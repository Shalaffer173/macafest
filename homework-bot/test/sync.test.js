import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { diffTasks, syncUser, describeDiff } from '../src/sync.js';
import { openDb } from '../src/db.js';
import { encrypt, decrypt, verifyInitData } from '../src/crypto.js';
import { appointmentsToTasks, mergeDuplicates, findLoginActionId, absorbCookies } from '../src/eschool.js';

const win = { from: '2026-10-01', to: '2026-11-30' };
const task = (id, o = {}) => ({ id, subject: 'Алгебра', text: '№ 1', topic: null, due: '2026-11-12', assigned: '2026-11-10', files: 0, ...o });
const row = (t, o = {}) => [t.id, { task_id: t.id, text: t.text, due: t.due, removed: 0, ...o }];

test('первая синхронизация: всё новое, ничего не «задним числом»', () => {
  const d = diffTasks(new Map(), [task('1', { assigned: '2026-10-05' })], { lastSyncDay: null, ...win });
  assert.equal(d.added.length, 1);
  assert.equal(d.added[0].backdated, false);
});

test('задание, заданное на уже просмотренный день, помечается «задним числом»', () => {
  const d = diffTasks(new Map(), [task('1', { assigned: '2026-11-05' }), task('2', { assigned: '2026-11-11' })],
    { lastSyncDay: '2026-11-11', ...win });
  assert.deepEqual(d.added.map((t) => t.backdated), [true, false]);
});

test('изменённый текст, удаление и возврат задания', () => {
  const a = task('1'), b = task('2'), c = task('3');
  const existing = new Map([row(a), row(b), row(c, { removed: 1 })]);
  const d = diffTasks(existing, [{ ...a, text: '№ 2' }, c], { lastSyncDay: '2026-11-11', ...win });
  assert.deepEqual(d.changed.map((t) => t.id), ['1']);
  assert.deepEqual(d.removed.map((t) => t.task_id), ['2']);
  assert.deepEqual(d.restored.map((t) => t.id), ['3']);
});

test('задание за пределами окна не считается удалённым', () => {
  const old = task('1', { due: '2026-09-01' });
  const d = diffTasks(new Map([row(old)]), [], { lastSyncDay: '2026-11-11', ...win });
  assert.equal(d.removed.length, 0);
});

test('syncUser: галочка сохраняется, а при изменении условия сбрасывается', async () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO users (tg_id, created_at) VALUES (1, 'x')").run();
  const cfg = { daysBack: 400, daysForward: 400 };
  let list = [task('1'), task('2')];
  const provider = { fetchTasks: async () => list };

  const first = await syncUser(db, provider, 1, {}, cfg);
  assert.equal(first.first, true);
  assert.equal(describeDiff(first), null);
  db.prepare('UPDATE tasks SET done = 1 WHERE tg_id = 1').run();

  list = [task('1'), task('2', { text: '№ 99' }), task('3')];
  const second = await syncUser(db, provider, 1, {}, cfg);
  const done = Object.fromEntries(db.prepare('SELECT task_id, done FROM tasks').all().map((r) => [r.task_id, r.done]));
  assert.deepEqual(done, { 1: 1, 2: 0, 3: 0 });
  assert.match(describeDiff(second), /Змінено/);
});

test('шифрование сессии: туда и обратно, подмена обнаруживается', () => {
  const key = 'ab'.repeat(32);
  const blob = encrypt('{"a":1}', key);
  assert.equal(decrypt(blob, key), '{"a":1}');
  const bad = Buffer.from(blob, 'base64');
  bad[bad.length - 1] ^= 1;
  assert.throws(() => decrypt(bad.toString('base64'), key));
});

test('initData Telegram: верная подпись принимается, чужая и старая — нет', () => {
  const token = '123:ABC';
  const sign = (params, tok) => {
    const str = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
    const secret = createHmac('sha256', 'WebAppData').update(tok).digest();
    return createHmac('sha256', secret).update(str).digest('hex');
  };
  const now = Date.now();
  const p = new URLSearchParams({ auth_date: String(Math.floor(now / 1000)), user: JSON.stringify({ id: 42 }) });
  const good = `${p}&hash=${sign(p, token)}`;
  assert.equal(verifyInitData(good, token, 86400, now).id, 42);
  assert.equal(verifyInitData(`${p}&hash=${sign(p, 'other')}`, token, 86400, now), null);
  assert.equal(verifyInitData(good, token, 86400, now + 2 * 86400_000), null);
  assert.equal(verifyInitData('', token), null);
});

test('разбор ответа дневника в список заданий', () => {
  const tasks = appointmentsToTasks([
    { Id: 1, Subject: ' Алгебра ', Date: '2026-11-12T00:00:00', Embed: { TargetHomeworks: [
      { Id: 7, Description: ' № 245 ', Topic: 'Рівняння', AppointmentDate: '2026-11-10T00:00:00', TargetAppointmentDate: '2026-11-12T00:00:00', FilesCount: 2 },
      { Id: 8, Description: '   ' },
    ] } },
    { Id: 2, Subject: 'Фізика', Date: '2026-11-13', Embed: null },
    null,
  ]);
  assert.deepEqual(tasks, [{ id: '7', subject: 'Алгебра', text: '№ 245', topic: 'Рівняння', due: '2026-11-12', assigned: '2026-11-10', files: 2 }]);
});

test('поиск id действия входа и разбор cookie', () => {
  const js = 'let f=(0,u.createServerReference)("7f80b7759828e551699a695e15a7ee7868ba7db6f8",u.callServer,void 0,u.findSourceMapURL,"loginAction");';
  assert.equal(findLoginActionId(js), '7f80b7759828e551699a695e15a7ee7868ba7db6f8');
  assert.equal(findLoginActionId('nothing'), null);
  const jar = { old: '1', refresh_token: 'x' };
  absorbCookies(jar, { headers: { getSetCookie: () => ['session_token=abc; Path=/; HttpOnly', 'refresh_token=; Max-Age=-1'] } });
  assert.deepEqual(jar, { old: '1', session_token: 'abc' });
  // выдача и удаление одноимённой cookie в одном ответе: остаётся выданная
  const jar2 = {};
  absorbCookies(jar2, { headers: { getSetCookie: () => ['application_token=tok; Domain=.eschool-ua.com', 'application_token=; Max-Age=0; Path=/'] } });
  assert.deepEqual(jar2, { application_token: 'tok' });
});

test('одинаковые задания на разные темы одного урока склеиваются', () => {
  const t = (id, o = {}) => ({ id, subject: 'Англ', text: 'Get 200: p. 6', topic: null, due: '2026-11-10', assigned: null, files: 0, ...o });
  const out = mergeDuplicates([t('9', { topic: 'B', files: 2 }), t('5', { topic: 'A', text: 'Get  200: P. 6' }), t('7', { due: '2026-11-11' })]);
  assert.deepEqual(out.map((x) => x.id), ['5', '7']);
  assert.equal(out[0].topic, 'A; B');
  assert.equal(out[0].files, 2);
});

test('первая синхронизация: прошедшие задания идут в архив без галочки', async () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO users (tg_id, created_at) VALUES (1, 'x')").run();
  const mk = (id, due) => ({ id, subject: 'A', text: id, topic: null, due, assigned: null, files: 0 });
  let list = [mk('old', '2020-01-01'), mk('new', '2999-01-01')];
  const provider = { fetchTasks: async () => list };
  await syncUser(db, provider, 1, {}, { daysBack: 1, daysForward: 1 });
  const rows = () => Object.fromEntries(db.prepare('SELECT task_id, done, archived FROM tasks').all().map((r) => [r.task_id, [r.done, r.archived]]));
  assert.deepEqual(rows(), { old: [0, 1], new: [0, 0] });
  // при следующих синхронизациях прошедшее задание в архив уже не попадает
  list = [...list, mk('late', '2020-01-02')];
  await syncUser(db, provider, 1, {}, { daysBack: 1, daysForward: 1 });
  assert.deepEqual(rows().late, [0, 0]);
});

test('обновление базы: галочки, поставленные старой версией, снимаются', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = mkdtempSync(tmpdir() + '/hw-') + '/db.sqlite';
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE users (tg_id INTEGER PRIMARY KEY, session TEXT, student_name TEXT, school_name TEXT, last_sync TEXT, sync_error TEXT, created_at TEXT NOT NULL);
    CREATE TABLE tasks (tg_id INTEGER NOT NULL, task_id TEXT NOT NULL, subject TEXT NOT NULL, text TEXT NOT NULL, topic TEXT, due TEXT NOT NULL, assigned TEXT,
      files INTEGER NOT NULL DEFAULT 0, done INTEGER NOT NULL DEFAULT 0, done_at TEXT, backdated INTEGER NOT NULL DEFAULT 0, changed INTEGER NOT NULL DEFAULT 0,
      removed INTEGER NOT NULL DEFAULT 0, first_seen TEXT NOT NULL, PRIMARY KEY (tg_id, task_id));
    INSERT INTO users (tg_id, created_at) VALUES (1, 'x');
    INSERT INTO tasks (tg_id, task_id, subject, text, due, done, done_at, first_seen) VALUES
      (1, 'auto', 'A', 't', '2026-11-01', 1, 'T1', 'T1'), (1, 'mine', 'A', 't', '2026-11-12', 1, 'T2', 'T1'), (1, 'todo', 'A', 't', '2026-11-12', 0, NULL, 'T1');`);
  old.close();
  const db = openDb(path);
  const rows = Object.fromEntries(db.prepare('SELECT task_id, done, archived FROM tasks').all().map((r) => [r.task_id, [r.done, r.archived]]));
  assert.deepEqual(rows, { auto: [0, 1], mine: [1, 0], todo: [0, 0] });
});
