import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { openDb } from './db.js';
import { encrypt, decrypt, verifyInitData } from './crypto.js';
import { syncUser, describeDiff } from './sync.js';
import { createBot } from './telegram.js';
import * as eschool from './eschool.js';
import * as demo from './demo.js';

const provider = config.demo ? demo : eschool;
const db = openDb(config.dbPath);
const WEB = fileURLToPath(new URL('../web/', import.meta.url));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

const deleteUser = (tgId) => db.prepare('DELETE FROM users WHERE tg_id = ?').run(tgId);
const bot = config.demo ? null : createBot(config.botToken, { publicUrl: config.publicUrl, onDelete: deleteUser });

// ---------- сессии ----------
const loadSession = (row) => (row?.session ? JSON.parse(decrypt(row.session, config.secretKey)) : null);
function saveSession(tgId, session) {
  db.prepare('UPDATE users SET session = ? WHERE tg_id = ?').run(encrypt(JSON.stringify(session), config.secretKey), tgId);
}

const running = new Set(); // чтобы один пользователь не синхронизировался дважды одновременно
async function runSync(tgId, { notify }) {
  if (running.has(tgId)) return null;
  running.add(tgId);
  try {
    const row = db.prepare('SELECT session FROM users WHERE tg_id = ?').get(tgId);
    const session = loadSession(row);
    if (!session) return null;
    try {
      const result = await syncUser(db, provider, tgId, session, config);
      saveSession(tgId, session); // токены могли обновиться
      console.log(`[sync] ${tgId}: ${result.from}..${result.to}, заданий ${result.fetched}, с ответом ${result.answered}, новых ${result.diff.added.length}; уроков ${result.lessons}, оценок ${result.gradesTotal}, новых оценок ${result.grades.added.length}`);
      const text = notify && describeDiff(result);
      if (text && bot) await bot.send(tgId, text, true);
      return result;
    } catch (e) {
      if (e.code === 'session_expired') {
        console.error(`[sync] ${tgId}: сессия дневника потеряна, нужен повторный вход`);
        db.prepare('UPDATE users SET session = NULL, sync_error = ? WHERE tg_id = ?').run(e.message, tgId);
        if (notify && bot) await bot.send(tgId, '🔑 Сесія «Єдиної Школи» закінчилась. Відкрий список і увійди ще раз.', true);
      } else {
        db.prepare('UPDATE users SET sync_error = ? WHERE tg_id = ?').run(e.message, tgId);
      }
      throw e;
    }
  } finally {
    running.delete(tgId);
  }
}

// Синхронизация идёт в фоне: она занимает до полуминуты, а запрос приложения
// должен ответить сразу. Приложение само опрашивает /api/state, пока syncing = true.
function startSync(tgId) {
  runSync(tgId, { notify: false }).catch((e) => console.error(`[sync] ${tgId}: ${e.message}`));
}

// ---------- HTTP ----------
function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 10000) throw Object.assign(new Error('Слишком большой запрос'), { status: 413 });
  }
  try { return raw ? JSON.parse(raw) : {}; } catch { throw Object.assign(new Error('Некорректный JSON'), { status: 400 }); }
}

function authUser(req) {
  if (config.demo) return { id: 1 };
  return verifyInitData(req.headers['x-telegram-init-data'], config.botToken);
}

/** Понедельник прошлой недели: расписание старше этого приложению не нужно. */
function scheduleFrom() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) - 7);
  return d.toISOString().slice(0, 10);
}

function state(tgId) {
  const u = db.prepare('SELECT session, student_name, school_name, last_sync, sync_error FROM users WHERE tg_id = ?').get(tgId);
  if (!u?.session) return { loggedIn: false, error: u?.sync_error ?? null };
  const tasks = db.prepare(`SELECT task_id AS id, subject, text, topic, due, assigned, files, done, backdated, changed, removed, archived, answered
    FROM tasks WHERE tg_id = ? ORDER BY due, subject`).all(tgId)
    .map((t) => ({ ...t, done: !!t.done, backdated: !!t.backdated, changed: !!t.changed, removed: !!t.removed, archived: !!t.archived, answered: !!t.answered }));
  const lessons = db.prepare(`SELECT lesson_id AS id, date, number, start, duration, subject, room, teacher, topic, status, reason
    FROM lessons WHERE tg_id = ? AND date >= ? ORDER BY date, number, start`).all(tgId, scheduleFrom());
  const grades = db.prepare(`SELECT grade_id AS id, subject, date, label, value, kind, type, topic, comment
    FROM grades WHERE tg_id = ? ORDER BY date DESC, grade_id DESC`).all(tgId);
  return {
    loggedIn: true, student: u.student_name, school: u.school_name, lastSync: u.last_sync, error: u.sync_error,
    syncing: running.has(tgId), tasks, lessons, grades,
  };
}

// Защита от подбора пароля: не больше 5 неверных паролей в час. Считаются только отказы
// самого дневника; сбои сети и удачные входы в счёт не идут.
const HOUR = 3600_000;
function loginBlocked(tgId) {
  db.prepare('DELETE FROM login_attempts WHERE at < ?').run(Date.now() - HOUR);
  return db.prepare('SELECT COUNT(*) AS n FROM login_attempts WHERE tg_id = ?').get(tgId).n >= 5;
}
const noteBadPassword = (tgId) => db.prepare('INSERT INTO login_attempts (tg_id, at) VALUES (?, ?)').run(tgId, Date.now());
const clearAttempts = (tgId) => db.prepare('DELETE FROM login_attempts WHERE tg_id = ?').run(tgId);
db.exec('DELETE FROM login_attempts'); // счётчик прежней версии считал и сбои сети

async function handleApi(req, res, path) {
  const user = authUser(req);
  if (!user) return send(res, 401, { error: 'Відкрий застосунок через бота в Telegram' });
  const tgId = user.id;

  if (req.method === 'GET' && path === '/api/state') return send(res, 200, state(tgId));
  // Короткий ответ для опроса во время синхронизации, чтобы не гонять весь список каждые 2 секунды.
  if (req.method === 'GET' && path === '/api/status') return send(res, 200, { syncing: running.has(tgId) });

  if (req.method === 'POST' && path === '/api/login') {
    const { username, password } = await readJson(req);
    if (typeof username !== 'string' || typeof password !== 'string' || !username.trim() || !password) {
      return send(res, 400, { error: 'Введи логін і пароль' });
    }
    if (loginBlocked(tgId)) return send(res, 429, { error: 'Забагато невірних паролів. Спробуй за годину' });
    let session;
    try {
      session = await provider.login(username.trim(), password); // пароль дальше этой строки не уходит
    } catch (e) {
      console.error(`[login] ${tgId}: ${e.code ?? 'error'} ${e.message}`);
      if (e.code === 'bad_credentials') noteBadPassword(tgId);
      return send(res, e.code === 'bad_credentials' || e.code === 'not_student' ? 403 : 502, { error: e.message });
    }
    db.prepare(`INSERT INTO users (tg_id, student_name, school_name, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(tg_id) DO UPDATE SET student_name = excluded.student_name, school_name = excluded.school_name, sync_error = NULL`)
      .run(tgId, session.studentName ?? null, session.schoolName ?? null, new Date().toISOString());
    saveSession(tgId, session);
    clearAttempts(tgId);
    console.log(`[login] ${tgId}: вход выполнен`);
    startSync(tgId);
    return send(res, 200, state(tgId));
  }

  if (req.method === 'POST' && path === '/api/sync') {
    startSync(tgId);
    return send(res, 200, state(tgId));
  }

  const m = /^\/api\/tasks\/([^/]+)\/done$/.exec(path);
  if (req.method === 'POST' && m) {
    const { done } = await readJson(req);
    const r = db.prepare('UPDATE tasks SET done = ?, done_at = ?, changed = 0, archived = 0 WHERE tg_id = ? AND task_id = ?')
      .run(done ? 1 : 0, done ? new Date().toISOString() : null, tgId, decodeURIComponent(m[1]));
    return r.changes ? send(res, 200, { ok: true }) : send(res, 404, { error: 'Завдання не знайдено' });
  }

  if (req.method === 'POST' && path === '/api/logout') {
    deleteUser(tgId);
    console.log(`[logout] ${tgId}: пользователь стёр свои данные`);
    return send(res, 200, { loggedIn: false });
  }
  return send(res, 404, { error: 'Not found' });
}

async function handleStatic(res, path) {
  const rel = normalize(path === '/' ? 'index.html' : path.slice(1));
  if (rel.startsWith('..') || !MIME[extname(rel)]) { res.writeHead(404).end(); return; }
  try {
    const body = await readFile(join(WEB, rel));
    res.writeHead(200, { 'Content-Type': MIME[extname(rel)], 'Cache-Control': 'no-cache' });
    res.end(body);
  } catch { res.writeHead(404).end(); }
}

createServer(async (req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  try {
    if (path.startsWith('/api/')) await handleApi(req, res, path);
    else if (req.method === 'GET') await handleStatic(res, path);
    else res.writeHead(405).end();
  } catch (e) {
    console.error('[http]', e.message);
    if (!res.headersSent) send(res, e.status ?? 500, { error: e.status ? e.message : 'Помилка сервера' });
  }
}).listen(config.port, () => {
  console.log(`Сервер: http://localhost:${config.port}${config.demo ? ' (демо-режим)' : ''}`);
});

// ---------- фоновые задачи ----------
async function syncAll() {
  const ids = db.prepare('SELECT tg_id FROM users WHERE session IS NOT NULL').all().map((r) => r.tg_id);
  for (const id of ids) {
    await runSync(id, { notify: true }).catch((e) => console.error(`[sync] ${id}: ${e.message}`));
    await new Promise((r) => setTimeout(r, 2000)); // пользователи по очереди, с паузой
  }
}
setInterval(() => { syncAll().catch((e) => console.error('[sync]', e.message)); }, config.syncMinutes * 60_000).unref?.();
if (bot) bot.poll();
