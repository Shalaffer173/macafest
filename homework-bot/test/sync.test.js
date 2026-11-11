import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { diffTasks, syncUser, describeDiff, schoolYearStart, weekEnd } from '../src/sync.js';
import { openDb } from '../src/db.js';
import { encrypt, decrypt, verifyInitData } from '../src/crypto.js';
import { appointmentsToTasks, appointmentsToLessons, appointmentsToGrades, mergeDuplicates, findLoginActionId, absorbCookies } from '../src/eschool.js';

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
  assert.deepEqual(tasks, [{ id: '7', subject: 'Алгебра', text: '№ 245', topic: 'Рівняння', due: '2026-11-12', assigned: '2026-11-10', files: 2, answered: true }]);
  const one = (h) => appointmentsToTasks([{ Subject: 'A', Date: '2026-11-12', Embed: { TargetHomeworks: [{ Id: 1, Description: 'x', ...h }] } }])[0].answered;
  assert.equal(one({}), false);
  assert.equal(one({ HaveAnswer: true }), true);
  assert.equal(one({ FilesCount: 1 }), true);
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
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  list = [...list, mk('late', yesterday)];
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

test('начало учебного года', () => {
  assert.equal(schoolYearStart('2026-11-11'), '2026-09-01');
  assert.equal(schoolYearStart('2027-03-01'), '2026-09-01');
  assert.equal(schoolYearStart('2026-09-01'), '2026-09-01');
});

test('расширение окна до 1 сентября: старые задания идут в архив без уведомлений', async () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO users (tg_id, created_at) VALUES (1, 'x')").run();
  const iso = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const mk = (id, due) => ({ id, subject: 'A', text: id, topic: null, due, assigned: due, files: 0 });
  const calls = [];
  let list = [mk('recent', iso(-3)), mk('next', iso(2))];
  const provider = { fetchTasks: async (_s, from, to) => { calls.push(from); return list; } };
  const cfg = { daysBack: 10, daysForward: 14, fullSyncHours: 24 };

  await syncUser(db, provider, 1, {}, cfg);
  // имитируем базу старой версии: год ещё не перечитывался, охват — только 10 дней
  db.prepare('UPDATE users SET last_full_sync = NULL, covered_from = ? WHERE tg_id = 1').run(iso(-10));
  list = [...list, mk('september', iso(-40)), mk('fresh', iso(-1))];
  const res = await syncUser(db, provider, 1, {}, cfg);

  const rows = Object.fromEntries(db.prepare('SELECT task_id, archived, backdated FROM tasks').all().map((r) => [r.task_id, [r.archived, r.backdated]]));
  assert.deepEqual(rows.september, [1, 0]);
  assert.equal(rows.fresh[0], 0);
  const text = describeDiff(res);
  assert.match(text, /fresh/);
  assert.doesNotMatch(text, /september/);
  // сразу после полной синхронизации следующая снова короткая
  await syncUser(db, provider, 1, {}, cfg);
  assert.equal(calls.at(-1), iso(-10));
});

test('сданный в дневнике ответ отмечает задание сделанным один раз', async () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO users (tg_id, created_at) VALUES (1, 'x')").run();
  const mk = (id, due, answered = false) => ({ id, subject: 'A', text: id, topic: null, due, assigned: null, files: 0, answered });
  let list = [mk('oldAnswered', '2020-01-01', true), mk('old', '2020-01-02'), mk('later', '2999-01-01')];
  const provider = { fetchTasks: async () => list };
  const cfg = { daysBack: 1, daysForward: 1 };
  const rows = () => Object.fromEntries(db.prepare('SELECT task_id, done, archived FROM tasks').all().map((r) => [r.task_id, [r.done, r.archived]]));

  await syncUser(db, provider, 1, {}, cfg);
  assert.deepEqual(rows(), { oldAnswered: [1, 0], old: [0, 1], later: [0, 0] });

  list = [mk('oldAnswered', '2020-01-01', true), mk('old', '2020-01-02', true), mk('later', '2999-01-01', true)];
  await syncUser(db, provider, 1, {}, cfg);
  assert.deepEqual(rows(), { oldAnswered: [1, 0], old: [1, 0], later: [1, 0] });

  // галочку сняли вручную — следующая синхронизация её не возвращает
  db.prepare("UPDATE tasks SET done = 0 WHERE task_id = 'later'").run();
  await syncUser(db, provider, 1, {}, cfg);
  assert.deepEqual(rows().later, [0, 0]);
});

test('конец недели', () => {
  assert.equal(weekEnd('2026-11-11'), '2026-11-15'); // среда -> воскресенье
  assert.equal(weekEnd('2026-11-15'), '2026-11-15');
  assert.equal(weekEnd('2026-11-16'), '2026-11-22');
});

test('разбор расписания из ответа дневника', () => {
  const lessons = appointmentsToLessons([
    { Id: 1, Date: '2026-11-11T00:00:00', LessonNumber: 2, StartTime: '09:25:00', Duration: 45, Subject: ' Фізика ', RoomNumber: '305',
      Embed: { Teacher: { LastName: 'Шевчук', FirstName: 'Ірина', SecondName: 'Василівна' }, Topics: [{ Id: 5, Title: '' }, { Id: 6, Title: 'Закони Ньютона' }] } },
    { Id: 2, Date: '2026-11-11', LessonNumber: 0, StartTime: null, Duration: 0, Subject: 'Хімія', RoomNumber: '0', Canceled: true, CancelReason: 'Хвороба' },
    { Id: 3, Date: '2026-11-11', LessonNumber: 4, StartTime: '11:25', Subject: 'Хімія', ReplaceId: 77 },
    { Id: 4, Date: '2026-11-11', LessonNumber: 5, Subject: 'Географія', ReplacementId: 78, CancelReason: 'Заміна' },
    { Id: 5, Subject: 'Без дати' },
    null,
  ]);
  assert.deepEqual(lessons[0], { id: '1', date: '2026-11-11', number: 2, start: '09:25', duration: 45, subject: 'Фізика', room: '305',
    teacher: 'Шевчук І. В.', topic: 'Закони Ньютона', status: 'normal', reason: null });
  assert.deepEqual(lessons.map((l) => [l.id, l.status, l.reason, l.number, l.start, l.duration, l.room]), [
    ['1', 'normal', null, 2, '09:25', 45, '305'],
    ['2', 'canceled', 'Хвороба', null, null, 45, null],
    ['3', 'replacement', null, 4, '11:25', 45, null],
    ['4', 'replaced', 'Заміна', 5, null, 45, null],
  ]);
});

test('разбор оценок из ответа дневника', () => {
  const grades = appointmentsToGrades([{ Id: 1, Date: '2026-11-10T00:00:00', Subject: 'Алгебра', Embed: { Rates: [
    { Id: 1, Rate: 10, RateValue: '10', RateType: 'Поточна', Topic: ' Рівняння ', SchoolboyDescription: 'Молодець' },
    { Id: 2, Rate: 9, RateValue: '9', RateType: 'Тематична', Summary: true, Date: '2026-11-09T00:00:00' },
    { Id: 3, Rate: 0, RateValue: '', MissingTypeId: 4, MissingType: 'Н' },
    { Id: 4, Missing: 1 },
    { Id: 5, Rate: 0, RateValue: 'зарах.' },
    { Id: 6, Rate: 0, RateValue: '' },
    { Id: 7, Rate: 11, RateValue: 'одинадцять', RateCategoryId: 6 },
    null,
  ] } }]);
  assert.deepEqual(grades[0], { id: '1', subject: 'Алгебра', date: '2026-11-10', lessonDate: '2026-11-10', label: '10', value: 10,
    kind: 'current', type: 'Поточна', topic: 'Рівняння', comment: 'Молодець' });
  assert.deepEqual(grades.map((g) => [g.id, g.kind, g.label, g.value, g.date]), [
    ['1', 'current', '10', 10, '2026-11-10'],
    ['2', 'summary', '9', 9, '2026-11-09'],
    ['3', 'missing', 'Н', null, '2026-11-10'],
    ['4', 'missing', 'Н', null, '2026-11-10'],
    ['5', 'current', 'зарах.', null, '2026-11-10'],
    ['7', 'current', '11', 11, '2026-11-10'],
  ]);
});

test('расписание и оценки: первая загрузка молчит и идёт за весь год, новые оценки дают уведомление', async () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO users (tg_id, created_at) VALUES (1, 'x')").run();
  const iso = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const lesson = (id, date, subject = 'Алгебра') => ({ id, date, number: 1, start: '08:30', duration: 45, subject, room: null, teacher: null, topic: null, status: 'normal', reason: null });
  const grade = (id, date, label, kind = 'current') => ({ id, subject: 'Алгебра', date, lessonDate: date, label, value: Number(label) || null, kind, type: 'Поточна', topic: null, comment: null });
  let diary = { tasks: [], lessons: [lesson('l1', iso(-2)), lesson('l2', iso(1))], grades: [grade('g1', iso(-2), '9')] };
  const calls = [];
  const provider = { fetchDiary: async (_s, from, to) => { calls.push([from, to]); return diary; } };
  const cfg = { daysBack: 10, daysForward: 14, fullSyncHours: 24 };
  const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

  // пользователь из прошлой версии: задания уже синхронизировались, а расписания и оценок ещё нет
  db.prepare('UPDATE users SET last_sync = ?, last_full_sync = ?, covered_from = ? WHERE tg_id = 1')
    .run(new Date().toISOString(), new Date().toISOString(), schoolYearStart(iso(0)));
  const first = await syncUser(db, provider, 1, {}, cfg);
  assert.equal(calls[0][0], schoolYearStart(iso(0)), 'первая загрузка оценок — с начала учебного года');
  assert.equal(calls[0][1], weekEnd(iso(14)), 'до конца недели');
  assert.equal(first.gradesSilent, true);
  assert.equal(describeDiff(first), null);
  assert.deepEqual([count('lessons'), count('grades')], [2, 1]);

  // вторая синхронизация короткая: появилась оценка, изменилась старая, добавился пропуск, урок отменён
  diary = {
    tasks: [],
    lessons: [lesson('l1', iso(-2)), { ...lesson('l2', iso(1)), status: 'canceled' }, lesson('l3', iso(2), 'Фізика')],
    grades: [grade('g1', iso(-2), '10'), grade('g2', iso(-1), '11'), grade('g3', iso(-1), 'Н', 'missing')],
  };
  const second = await syncUser(db, provider, 1, {}, cfg);
  assert.equal(calls[1][0], iso(-10));
  const text = describeDiff(second);
  assert.match(text, /Оцінка: Алгебра — 11 \(поточна\)/);
  assert.match(text, /Оцінку змінено: Алгебра — 9 → 10/);
  assert.doesNotMatch(text, /Н/, 'о пропусках не сообщаем');
  assert.deepEqual([count('lessons'), count('grades')], [3, 3]);
  assert.equal(db.prepare("SELECT status FROM lessons WHERE lesson_id = 'l2'").get().status, 'canceled');

  // оценку удалили в дневнике — она исчезает и у нас, без уведомления
  diary = { ...diary, grades: [grade('g1', iso(-2), '10')] };
  const third = await syncUser(db, provider, 1, {}, cfg);
  assert.equal(describeDiff(third), null);
  assert.equal(count('grades'), 1);

  // удаление пользователя стирает расписание и оценки
  db.prepare('DELETE FROM users WHERE tg_id = 1').run();
  assert.deepEqual([count('lessons'), count('grades')], [0, 0]);
});
