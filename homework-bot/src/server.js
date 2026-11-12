import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { openDb } from './db.js';
import { encrypt, decrypt, verifyInitData, signToken, verifyToken } from './crypto.js';
import { syncUser, describeDiff } from './sync.js';
import { createBot } from './telegram.js';
import { kyivNow, nextSchoolDay, scheduleText, digestText } from './digest.js';
import * as eschool from './eschool.js';
import * as demo from './demo.js';

const provider = config.demo ? demo : eschool;
const db = openDb(config.dbPath);
const WEB = fileURLToPath(new URL('../web/', import.meta.url));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

const deleteUser = (tgId) => db.prepare('DELETE FROM users WHERE tg_id = ?').run(tgId);
const loggedIn = (tgId) => !!db.prepare('SELECT 1 FROM users WHERE tg_id = ? AND session IS NOT NULL').get(tgId);
const needLogin = { text: 'Спершу увійди в щоденник: відкрий застосунок кнопкою нижче.', button: true };

// Команды бота в чате. Отвечают по данным из базы, к дневнику не обращаются.
const commands = {
  '/today': {
    description: 'розклад на сьогодні',
    run: async (tgId) => {
      if (!loggedIn(tgId)) return needLogin;
      const today = kyivNow().date;
      return { text: scheduleText(db, tgId, today, today) };
    },
  },
  '/tomorrow': {
    description: 'розклад на наступний навчальний день',
    run: async (tgId) => {
      if (!loggedIn(tgId)) return needLogin;
      const today = kyivNow().date;
      return { text: scheduleText(db, tgId, nextSchoolDay(db, tgId, today), today) };
    },
  },
  '/digest': {
    description: 'увімкнути або вимкнути вечірнє зведення',
    run: async (tgId) => {
      if (!loggedIn(tgId)) return needLogin;
      const on = !db.prepare('SELECT digest FROM users WHERE tg_id = ?').get(tgId).digest;
      db.prepare('UPDATE users SET digest = ? WHERE tg_id = ?').run(on ? 1 : 0, tgId);
      return { text: on
        ? `Вечірнє зведення увімкнено: щодня о ${config.digestHour}:00 напишу, що задано на наступний день і ще не зроблено.`
        : 'Вечірнє зведення вимкнено. Увімкнути знову: /digest' };
    },
  },
  '/delete': {
    description: 'стерти всі мої дані',
    run: async (tgId) => {
      deleteUser(tgId);
      console.log(`[logout] ${tgId}: пользователь стёр свои данные командой`);
      return { text: 'Готово: токен, завдання, розклад і оцінки стерто. Щоб почати знову, надішли /start.' };
    },
  },
};
const bot = config.demo ? null : createBot(config.botToken, { publicUrl: config.publicUrl, commands });

// ---------- сессии ----------
const loadSession = (row) => (row?.session ? JSON.parse(decrypt(row.session, config.secretKey)) : null);
function saveSession(tgId, session) {
  db.prepare('UPDATE users SET session = ? WHERE tg_id = ?').run(encrypt(JSON.stringify(session), config.secretKey), tgId);
}

// Все обращения к дневнику от имени одного пользователя идут по очереди: синхронизация и сдача
// ответа пользуются одними токенами, и одновременное продление сессии могло бы их испортить.
const queues = new Map();
function inTurn(tgId, fn) {
  const run = (queues.get(tgId) ?? Promise.resolve()).then(fn, fn);
  const tail = run.catch(() => {});
  queues.set(tgId, tail);
  tail.then(() => { if (queues.get(tgId) === tail) queues.delete(tgId); });
  return run;
}

function dropSession(tgId, message) {
  db.prepare('UPDATE users SET session = NULL, sync_error = ? WHERE tg_id = ?').run(message, tgId);
}

/** Выполняет fn(session) в очереди пользователя и сохраняет обновившиеся токены. */
function withSession(tgId, fn) {
  return inTurn(tgId, async () => {
    const session = loadSession(db.prepare('SELECT session FROM users WHERE tg_id = ?').get(tgId));
    if (!session) throw Object.assign(new Error('Потрібно увійти ще раз'), { status: 401 });
    try {
      const result = await fn(session);
      saveSession(tgId, session); // токены могли обновиться
      return result;
    } catch (e) {
      if (e.code === 'session_expired') {
        console.error(`[session] ${tgId}: сессия дневника потеряна, нужен повторный вход`);
        dropSession(tgId, e.message);
      } else {
        saveSession(tgId, session);
      }
      throw e;
    }
  });
}

const running = new Set(); // чтобы один пользователь не синхронизировался дважды одновременно
async function runSync(tgId, { notify }) {
  if (running.has(tgId)) return null;
  running.add(tgId);
  try {
    // Самая первая синхронизация идёт в два захода: сначала ближайшие недели, чтобы список
    // появился за несколько секунд, потом весь учебный год.
    const fresh = db.prepare('SELECT last_sync FROM users WHERE tg_id = ?').get(tgId);
    if (fresh && !fresh.last_sync) {
      await withSession(tgId, (session) => syncUser(db, provider, tgId, session, { ...config, quick: true }));
      console.log(`[sync] ${tgId}: первый быстрый проход готов, загружаю весь год`);
    }
    const result = await withSession(tgId, (session) => syncUser(db, provider, tgId, session, config));
    console.log(`[sync] ${tgId}: ${result.from}..${result.to}, заданий ${result.fetched}, с ответом ${result.answered}, новых ${result.diff.added.length}; уроков ${result.lessons}, оценок ${result.gradesTotal}, новых оценок ${result.grades.added.length}`);
    if (result.full && result.debug) {
      // Сводка без личных данных: помогает сверять число пропусков с официальным приложением.
      console.log(`[sync] ${tgId}: весь год с ${result.from}, уроков в ответе ${result.debug.appointments}, пропуски ${JSON.stringify(result.debug.missing)}`);
    }
    const text = notify && describeDiff(result);
    if (text && bot) await bot.send(tgId, text, true);
    return result;
  } catch (e) {
    if (e.status === 401) return null; // пользователь не вошёл — синхронизировать нечего
    if (e.code === 'session_expired') {
      if (notify && bot) await bot.send(tgId, '🔑 Сесія «Єдиної Школи» закінчилась. Відкрий список і увійди ще раз.', true);
    } else {
      db.prepare('UPDATE users SET sync_error = ? WHERE tg_id = ?').run(e.message, tgId);
    }
    throw e;
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

const MAX_FILE = 20 * 1024 * 1024;
async function readFile20(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_FILE) throw Object.assign(new Error('Файл завеликий: можна до 20 МБ'), { status: 413 });
    chunks.push(chunk);
  }
  if (!size) throw Object.assign(new Error('Порожній файл'), { status: 400 });
  return Buffer.concat(chunks);
}

/** Имя файла из заголовка: без путей и управляющих символов. */
function fileName(req) {
  let name = '';
  try { name = decodeURIComponent(String(req.headers['x-file-name'] ?? '')); } catch { /* оставим пустым */ }
  name = name.replace(/[\\/\u0000-\u001f]/g, '_').trim().slice(0, 200);
  return name || 'file';
}

/** Ошибка дневника -> ответ приложению. */
function answerFailed(res, tgId, e) {
  console.error(`[answer] ${tgId}: ${e.code ?? e.status ?? 'error'} ${e.message}`);
  const status = e.status ?? { session_expired: 401, answer_locked: 409, answer_empty: 400, forbidden: 403 }[e.code] ?? 502;
  const message = e.message;
  return send(res, status, { error: message });
}

function authUser(req) {
  if (config.demo) return { id: 1 };
  return verifyInitData(req.headers['x-telegram-init-data'], config.botToken);
}

// Вход идёт в фоне: он занимает несколько секунд, а запрос приложения должен ответить сразу
// (иначе тоннель обрывает его с ошибкой 502). tgId -> { pending: true } или { error }.
const logins = new Map();

function parseList(json) {
  try { const v = JSON.parse(json ?? '[]'); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []; }
  catch { return []; }
}

/** Короткий ответ для опроса, пока идёт вход или синхронизация. */
function status(tgId) {
  const u = db.prepare('SELECT session IS NOT NULL AS logged, last_sync FROM users WHERE tg_id = ?').get(tgId);
  const login = logins.get(tgId);
  return { loggedIn: !!u?.logged, loggingIn: !!login?.pending, loginError: login?.error ?? null, syncing: running.has(tgId), lastSync: u?.last_sync ?? null };
}

/** Понедельник прошлой недели: расписание старше этого приложению не нужно. */
function scheduleFrom() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) - 7);
  return d.toISOString().slice(0, 10);
}

function state(tgId) {
  const u = db.prepare('SELECT session, student_name, school_name, last_sync, sync_error, semester2_start, hidden_subjects FROM users WHERE tg_id = ?').get(tgId);
  if (!u?.session) {
    const login = logins.get(tgId);
    return { loggedIn: false, loggingIn: !!login?.pending, error: login?.error ?? u?.sync_error ?? null };
  }
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
    semester2Start: u.semester2_start ?? null, // с какой даты идёт второй семестр, если дневник это сообщил
    canAnswer: typeof provider.submitAnswer === 'function',
    hiddenSubjects: parseList(u.hidden_subjects), // предметы, скрытые во вкладке «Домашка»
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
  // Короткий ответ для опроса во время входа и синхронизации, чтобы не гонять весь список каждые 2 секунды.
  if (req.method === 'GET' && path === '/api/status') return send(res, 200, status(tgId));

  if (req.method === 'POST' && path === '/api/login') {
    const { username, password } = await readJson(req);
    if (typeof username !== 'string' || typeof password !== 'string' || !username.trim() || !password) {
      return send(res, 400, { error: 'Введи логін і пароль' });
    }
    if (loginBlocked(tgId)) return send(res, 429, { error: 'Забагато невірних паролів. Спробуй за годину' });
    if (!logins.get(tgId)?.pending) {
      logins.set(tgId, { pending: true });
      const name = username.trim();
      // Пароль живёт только в этом замыкании, пока идёт вход; ни в базу, ни в журнал он не попадает.
      provider.login(name, password).then((session) => {
        db.prepare(`INSERT INTO users (tg_id, student_name, school_name, created_at) VALUES (?, ?, ?, ?)
          ON CONFLICT(tg_id) DO UPDATE SET student_name = excluded.student_name, school_name = excluded.school_name, sync_error = NULL`)
          .run(tgId, session.studentName ?? null, session.schoolName ?? null, new Date().toISOString());
        saveSession(tgId, session);
        clearAttempts(tgId);
        logins.delete(tgId);
        console.log(`[login] ${tgId}: вход выполнен`);
        startSync(tgId);
      }).catch((e) => {
        console.error(`[login] ${tgId}: ${e.code ?? 'error'} ${e.message}`);
        if (e.code === 'bad_credentials') noteBadPassword(tgId);
        const known = e.code === 'bad_credentials' || e.code === 'not_student';
        logins.set(tgId, { error: known ? e.message : `Не вдалося увійти: ${e.message}` });
      });
    }
    return send(res, 200, state(tgId));
  }

  if (req.method === 'POST' && path === '/api/prefs') {
    const { hiddenSubjects } = await readJson(req);
    if (!Array.isArray(hiddenSubjects) || hiddenSubjects.length > 100 || hiddenSubjects.some((x) => typeof x !== 'string' || x.length > 200)) {
      return send(res, 400, { error: 'Некоректний список предметів' });
    }
    const r = db.prepare('UPDATE users SET hidden_subjects = ? WHERE tg_id = ?').run(JSON.stringify([...new Set(hiddenSubjects)]), tgId);
    return r.changes ? send(res, 200, { ok: true }) : send(res, 401, { error: 'Потрібно увійти' });
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

  // ----- ответ на задание: читается и сохраняется прямо в дневнике -----
  const am = /^\/api\/tasks\/(\d+)\/(answer|files|files\/(\d+)\/(?:remove|link))$/.exec(path);
  if (am) {
    const [, taskId, action, fileId] = am;
    if (typeof provider.submitAnswer !== 'function') return send(res, 404, { error: 'Not found' });
    // Только свои задания: id берётся из списка пользователя, а не из запроса на слово.
    if (!db.prepare('SELECT 1 FROM tasks WHERE tg_id = ? AND task_id = ?').get(tgId, taskId)) {
      return send(res, 404, { error: 'Завдання не знайдено' });
    }
    try {
      if (req.method === 'GET' && action === 'answer') {
        return send(res, 200, await withSession(tgId, (s) => provider.getAnswer(s, taskId)));
      }
      if (req.method === 'POST' && action === 'answer') {
        const { text } = await readJson(req);
        if (text != null && typeof text !== 'string') return send(res, 400, { error: 'Некоректна відповідь' });
        const answer = await withSession(tgId, (s) => provider.submitAnswer(s, taskId, text ?? ''));
        db.prepare(`UPDATE tasks SET answered = 1, done = 1, done_at = ?, archived = 0, changed = 0, files = ?
          WHERE tg_id = ? AND task_id = ?`).run(new Date().toISOString(), answer.files.length, tgId, taskId);
        console.log(`[answer] ${tgId}: ответ на задание ${taskId} сохранён в дневнике (файлов: ${answer.files.length})`);
        return send(res, 200, answer);
      }
      if (req.method === 'POST' && action === 'files') {
        const name = fileName(req);
        const type = String(req.headers['content-type'] ?? 'application/octet-stream');
        const file = new File([await readFile20(req)], name, { type });
        await withSession(tgId, (s) => provider.uploadAnswerFile(s, taskId, file, name));
        return send(res, 200, await withSession(tgId, (s) => provider.getAnswer(s, taskId)));
      }
      if (req.method === 'POST' && fileId && action.endsWith('/link')) {
        // Браузер не может передать подпись Telegram при скачивании, поэтому выдаём
        // отдельную ссылку на этот один файл, действующую пять минут.
        return send(res, 200, { url: `/f/${signToken({ u: tgId, t: taskId, f: fileId }, config.secretKey, 300)}` });
      }
      if (req.method === 'POST' && fileId) {
        await withSession(tgId, (s) => provider.removeAnswerFile(s, taskId, fileId));
        return send(res, 200, await withSession(tgId, (s) => provider.getAnswer(s, taskId)));
      }
    } catch (e) {
      return answerFailed(res, tgId, e);
    }
    return send(res, 405, { error: 'Method not allowed' });
  }

  if (req.method === 'POST' && path === '/api/logout') {
    deleteUser(tgId);
    console.log(`[logout] ${tgId}: пользователь стёр свои данные`);
    return send(res, 200, { loggedIn: false });
  }
  return send(res, 404, { error: 'Not found' });
}

// Типы, которые безопасно показать прямо в браузере; всё остальное отдаётся на скачивание.
const INLINE = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf']);

/** Файл задания по подписанной ссылке /f/<токен>: читается из дневника и сразу передаётся дальше. */
async function handleFile(res, token) {
  const link = verifyToken(token, config.secretKey);
  if (!link || typeof provider.openFile !== 'function') {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Посилання недійсне або застаріло. Відкрий файл із застосунку ще раз.');
    return;
  }
  let file;
  try {
    if (!db.prepare('SELECT 1 FROM tasks WHERE tg_id = ? AND task_id = ?').get(link.u, String(link.t))) throw new Error('задание не найдено');
    file = await withSession(link.u, (s) => provider.openFile(s, link.t, link.f));
  } catch (e) {
    console.error(`[file] ${link.u}: ${e.code ?? 'error'} ${e.message}`);
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Не вдалося отримати файл зі щоденника.');
    return;
  }
  const mime = String(file.mime).split(';')[0].trim().toLowerCase();
  const headers = {
    'Content-Type': INLINE.has(mime) ? mime : 'application/octet-stream',
    'Content-Disposition': `${INLINE.has(mime) ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': 'sandbox', // чужой файл не должен ничего исполнять на адресе бота
    'Cache-Control': 'private, no-store',
  };
  if (file.size) headers['Content-Length'] = file.size;
  res.writeHead(200, headers);
  Readable.fromWeb(file.body).on('error', () => res.destroy()).pipe(res);
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
    else if (req.method === 'GET' && path.startsWith('/f/')) await handleFile(res, path.slice(3));
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
// Вечерняя сводка: раз в несколько минут проверяем, не пора ли, и каждому пишем не чаще раза в день.
async function sendDigests() {
  const now = kyivNow();
  if (now.minutes < config.digestHour * 60 || now.minutes >= 22 * 60) return;
  const users = db.prepare('SELECT tg_id FROM users WHERE session IS NOT NULL AND digest = 1 AND (digest_sent IS NULL OR digest_sent < ?)').all(now.date);
  for (const { tg_id: tgId } of users) {
    db.prepare('UPDATE users SET digest_sent = ? WHERE tg_id = ?').run(now.date, tgId);
    const text = digestText(db, tgId, now.date);
    if (text && bot) await bot.send(tgId, text, true);
  }
}
setInterval(() => { sendDigests().catch((e) => console.error('[digest]', e.message)); }, 5 * 60_000).unref?.();

if (bot) bot.poll();
