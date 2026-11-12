import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { diffTasks, syncUser, describeDiff, schoolYearStart, weekEnd } from '../src/sync.js';
import { openDb } from '../src/db.js';
import { encrypt, decrypt, verifyInitData, signToken, verifyToken } from '../src/crypto.js';
import { kyivNow, nextSchoolDay, scheduleText, digestText } from '../src/digest.js';
import { createBot } from '../src/telegram.js';
import {
  appointmentsToTasks, appointmentsToLessons, appointmentsToGrades, mergeDuplicates, findLoginActionId, absorbCookies,
  parseAcademicYear, missingStats, getAnswer, submitAnswer, uploadAnswerFile, removeAnswerFile,
} from '../src/eschool.js';

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
  assert.deepEqual(tasks, [
    { id: '7', subject: 'Алгебра', text: '№ 245', topic: 'Рівняння', due: '2026-11-12', assigned: '2026-11-10', files: 2, answered: true },
    // запись без текста тоже остаётся: на неё в дневнике можно сдать ответ
    { id: '8', subject: 'Алгебра', text: '', topic: null, due: '2026-11-12', assigned: null, files: 0, answered: false },
  ]);
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
  assert.match(text, /🚫 Пропуск: Алгебра за \d\d\.\d\d \(Н\)/);
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

test('границы учебного года из ответа дневника', () => {
  assert.deepEqual(parseAcademicYear([
    { Id: 1, Start: '2026-08-31T00:00:00', End: '2026-12-25T00:00:00', Semester: 1 },
    { Id: 2, Start: '2027-01-11T00:00:00', End: '2027-05-31T00:00:00', Semester: 2 },
    null,
  ]), { start: '2026-08-31', end: '2027-05-31', semester2: '2027-01-11' });
  assert.equal(parseAcademicYear([]), null);
  assert.equal(parseAcademicYear([{ Id: 1, Start: '', End: null }]), null);
});

test('сводка по пропускам считает записи, повторы и значения поля Missing', () => {
  const st = missingStats([
    { Date: '2026-09-02', Embed: { Rates: [{ Id: 1, MissingTypeId: 3, Missing: 1 }, { Id: 2, Rate: 10 }] } },
    { Date: '2026-09-02', Embed: { Rates: [{ Id: 1, MissingTypeId: 3, Missing: 1 }] } }, // та же запись на втором уроке
    { Date: '2026-10-05', Canceled: true, Embed: { Rates: [{ Id: 3, Missing: 2 }, { Id: 4, MissingType: 'Н' }] } },
    null,
  ]);
  assert.deepEqual(st, { rates: 5, marks: 3, unique: 2, repeated: 1, byTypeId: 2, byMissingField: 3, typeTextOnly: 1,
    missingValues: { 1: 2, 2: 1 }, onCanceled: 1, byMonth: { '2026-09': 2, '2026-10': 1 } });
});

test('синхронизация берёт начало года из дневника, а неправдоподобную дату отбрасывает', async () => {
  const iso = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const guess = schoolYearStart(iso(0));
  const early = (() => { const d = new Date(`${guess}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); })();
  const run = async (year) => {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO users (tg_id, created_at) VALUES (1, 'x')").run();
    const calls = [];
    const provider = {
      fetchYear: async () => year,
      fetchDiary: async (_s, from) => { calls.push(from); return { tasks: [], lessons: [], grades: [] }; },
    };
    await syncUser(db, provider, 1, {}, { daysBack: 10, daysForward: 14 });
    return { from: calls[0], user: db.prepare('SELECT year_start, semester2_start FROM users').get() };
  };
  // в начале сентября «день раньше 1 сентября» может оказаться ближе 10 дней — тогда окно и так шире года
  const expectFrom = (start) => (start < iso(-10) ? start : iso(-10));
  const a = await run({ start: early, end: '2999-01-01', semester2: '2999-01-11' });
  assert.equal(a.from, expectFrom(early));
  assert.deepEqual({ ...a.user }, { year_start: early, semester2_start: '2999-01-11' });
  const b = await run({ start: '2001-09-01', end: '2002-05-31', semester2: null }); // чужой год
  assert.equal(b.from, expectFrom(guess));
  assert.equal(b.user.year_start, guess);
  const c = await run(null); // дневник ничего не сообщил
  assert.equal(c.user.year_start, guess);
});

test('ответ на задание: запросы в том же формате, что у сайта дневника', async () => {
  const session = { jar: { application_token: 't' }, identity: { user_id: 1, school_id: 4047, role: 'schoolboy' }, schoolId: 4047, schoolboyId: 1315 };
  const calls = [];
  let answers = [];
  let files = [{ Id: 5, Name: 'task.pdf', Role: 'teacher', Size: 100 }];
  let refuseWrites = false;
  const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const call = { method: init.method ?? 'GET', path: u.pathname, query: Object.fromEntries(u.searchParams) };
    if (typeof init.body === 'string') call.json = JSON.parse(init.body);
    if (init.body instanceof FormData) call.form = [...init.body.entries()].map(([k, v]) => [k, v.name, v.size]);
    calls.push(call);
    const tail = u.pathname.replace('/api/v1/4047/Homework/77', '');
    if (u.pathname === '/api/auth/refresh' || u.pathname === '/api/v1/seplogin') return json({});
    if (refuseWrites && call.method === 'POST') return json({ code: 'forbidden' }, 403);
    if (tail === '') return json({ Id: 77, Embed: { Files: files } });
    if (tail === '/Answer') return json({ Items: answers });
    if (tail === '/UploadFile') { files = [...files, { Id: 9, Name: 'my.jpg', Role: 'Schoolboy', Size: 3 }]; return json([{ Id: 9 }]); }
    if (tail === '/AssignAnswer') { answers = [{ Id: 300, Answer: call.json.Answer, SubmittedTime: '2026-11-12T10:00:00' }]; return json(answers[0]); }
    if (tail === '/UpdateAnswer') { answers = [{ ...answers[0], Answer: call.json.Answer }]; return new Response('', { status: 200 }); }
    if (tail === '/RemoveFile') { files = files.filter((f) => f.Id !== call.json.Id); return new Response('', { status: 200 }); }
    return json({}, 404);
  };
  const last = (suffix) => calls.filter((c) => c.path.endsWith(suffix)).at(-1);
  try {
    // чтение: задание с файлами и ответ ученика
    const empty = await getAnswer(session, '77');
    assert.deepEqual(empty, { status: 'todo', answerId: null, text: '', submittedAt: null, teacherComment: null,
      files: [], teacherFiles: [{ id: 5, name: 'task.pdf', size: 100 }] });
    assert.deepEqual(calls.map((c) => [c.method, c.path, c.query]), [
      ['GET', '/api/v1/4047/Homework/77', { embed: 'File' }],
      ['GET', '/api/v1/4047/Homework/77/Answer', { schoolboyId: '1315', embed: 'File' }],
    ]);

    // пустой ответ тоже можно сохранить: так задание отмечается сданным без текста и файлов
    const blank = await submitAnswer(session, '77', '   ');
    assert.deepEqual(last('/AssignAnswer').json, { Answer: '', Files: [] });
    assert.equal(blank.status, 'submitted');
    answers = []; // дальше проверяем обычный путь с чистого листа

    // файл: multipart с полем upload-file
    assert.equal(await uploadAnswerFile(session, '77', new File(['abc'], 'my.jpg'), 'my.jpg'), 9);
    assert.deepEqual(last('/UploadFile').form, [['upload-file', 'my.jpg', 3]]);

    // первый ответ создаётся через AssignAnswer со списком файлов ученика
    const first = await submitAnswer(session, '77', '  Готово ');
    assert.deepEqual(last('/AssignAnswer').json, { Answer: 'Готово', Files: [{ Id: 9 }] });
    assert.equal(first.status, 'submitted');
    assert.equal(first.text, 'Готово');
    assert.deepEqual(first.files, [{ id: 9, name: 'my.jpg', size: 3 }]);

    // повторный — через UpdateAnswer с id ответа
    const second = await submitAnswer(session, '77', 'Нова версія');
    assert.deepEqual(last('/UpdateAnswer').json, { Id: 300, Answer: 'Нова версія', Files: [{ Id: 9 }] });
    assert.equal(second.text, 'Нова версія');

    await removeAnswerFile(session, '77', '9');
    assert.deepEqual(last('/RemoveFile').json, { Id: 9 });

    // учитель вернул на доработку
    answers = [{ Id: 300, Answer: 'x', AnswerChecked: false, CheckedTime: '2026-11-10T10:00:00', TeacherComment: ' Допиши ' }];
    const reopened = await getAnswer(session, '77');
    assert.equal(reopened.status, 'reopened');
    assert.equal(reopened.teacherComment, 'Допиши');

    // проверенный ответ менять нельзя: до записи дело не доходит
    answers = [{ Id: 300, Answer: 'x', AnswerChecked: true }];
    const before = calls.length;
    await assert.rejects(submitAnswer(session, '77', 'ще раз'), { code: 'answer_locked' });
    assert.equal(calls.slice(before).some((c) => c.method === 'POST'), false);

    // отказ дневника на запись — это не потеря сессии: пользователя не разлогинивает
    answers = [];
    refuseWrites = true;
    await assert.rejects(submitAnswer(session, '77', 'текст'), { code: 'forbidden' });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('быстрый первый проход берёт только ближайшие недели, а следующий молча дотягивает год', async () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO users (tg_id, created_at) VALUES (1, 'x')").run();
  const iso = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const mk = (id, due) => ({ id, subject: 'A', text: id, topic: null, due, assigned: due, files: 0, answered: false });
  const grade = (id, date) => ({ id, subject: 'A', date, lessonDate: date, label: '10', value: 10, kind: 'current', type: 'Урок', topic: null, comment: null });
  const calls = [];
  const provider = {
    fetchDiary: async (_s, from) => {
      calls.push(from);
      const near = { tasks: [mk('soon', iso(1))], lessons: [], grades: [grade('g-near', iso(-1))] };
      return from === iso(-10) ? near
        : { tasks: [...near.tasks, mk('september', iso(-40))], lessons: [], grades: [...near.grades, grade('g-old', iso(-40))] };
    },
  };
  const cfg = { daysBack: 10, daysForward: 14 };

  const quick = await syncUser(db, provider, 1, {}, { ...cfg, quick: true });
  assert.equal(calls[0], iso(-10));
  assert.equal(quick.first, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 1);
  const after = db.prepare('SELECT last_full_sync, extras_synced, task_rules FROM users').get();
  assert.deepEqual({ ...after }, { last_full_sync: null, extras_synced: 0, task_rules: 1 });

  const full = await syncUser(db, provider, 1, {}, cfg);
  assert.ok(calls[1] < iso(-10), 'второй проход идёт с начала года');
  assert.equal(describeDiff(full), null, 'старые задания и оценки не считаются новыми');
  const rows = Object.fromEntries(db.prepare('SELECT task_id, archived FROM tasks').all().map((r) => [r.task_id, r.archived]));
  assert.deepEqual(rows, { soon: 0, september: 1 });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM grades').get().n, 2);
});

test('смена правил отбора: записи, которые бот раньше пропускал, принимаются один раз молча', async () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO users (tg_id, created_at) VALUES (1, 'x')").run();
  const iso = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const mk = (id, due, text = id) => ({ id, subject: 'A', text, topic: null, due, assigned: due, files: 0, answered: false });
  let list = [mk('a', iso(1))];
  const provider = { fetchTasks: async () => list };
  const cfg = { daysBack: 10, daysForward: 14 };
  await syncUser(db, provider, 1, {}, cfg);
  db.prepare('UPDATE users SET task_rules = 1').run(); // пользователь из версии со старыми правилами

  list = [...list, mk('past-empty', iso(-3), ''), mk('future-empty', iso(2), '')];
  const res = await syncUser(db, provider, 1, {}, cfg);
  assert.equal(describeDiff(res), null);
  const rows = Object.fromEntries(db.prepare('SELECT task_id, archived, backdated FROM tasks').all().map((r) => [r.task_id, [r.archived, r.backdated]]));
  assert.deepEqual(rows, { a: [0, 0], 'past-empty': [1, 0], 'future-empty': [0, 0] });

  // дальше всё как обычно: новое задание даёт уведомление
  list = [...list, mk('new', iso(3), '')];
  assert.match(describeDiff(await syncUser(db, provider, 1, {}, cfg)), /без тексту/);
});

test('подписанная ссылка: срок действия и защита от подмены', () => {
  const key = 'cd'.repeat(32);
  const now = Date.now();
  const token = signToken({ u: 7, t: '77', f: '9' }, key, 300, now);
  assert.deepEqual({ ...verifyToken(token, key, now), exp: undefined }, { u: 7, t: '77', f: '9', exp: undefined });
  assert.equal(verifyToken(token, key, now + 301_000), null, 'через пять минут не действует');
  assert.equal(verifyToken(token, 'ab'.repeat(32), now), null, 'чужой ключ');
  const [body, mac] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ u: 8, t: '77', f: '9', exp: 9e9 })).toString('base64url');
  assert.equal(verifyToken(`${forged}.${mac}`, key, now), null, 'подменили пользователя');
  assert.equal(verifyToken(body, key, now), null);
  assert.equal(verifyToken('', key, now), null);
});

test('киевское время: зима и лето', () => {
  assert.deepEqual(kyivNow(new Date('2026-11-12T16:30:00Z')), { date: '2026-11-12', minutes: 18 * 60 + 30 });
  assert.deepEqual(kyivNow(new Date('2026-06-30T21:30:00Z')), { date: '2026-07-01', minutes: 30 }); // летом +3, уже следующий день
});

test('расписание на день и вечерняя сводка', () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO users (tg_id, created_at) VALUES (1, 'x')").run();
  const lesson = db.prepare('INSERT INTO lessons (tg_id, lesson_id, date, number, start, duration, subject, room, status) VALUES (1, ?, ?, ?, ?, 45, ?, ?, ?)');
  const task = db.prepare("INSERT INTO tasks (tg_id, task_id, subject, text, due, done, archived, removed, first_seen) VALUES (1, ?, ?, ?, ?, ?, ?, ?, 'x')");
  // четверг 12.11 — сегодня; пятница 13.11 — уроки отменены; следующий учебный день — понедельник 16.11
  lesson.run('a', '2026-11-12', 1, '08:30', 'Алгебра', '214', 'normal');
  lesson.run('b', '2026-11-12', 2, '09:25', 'Хімія', '308', 'replacement');
  lesson.run('c', '2026-11-12', 3, '10:25', 'Геометрія', 'спортзал', 'canceled');
  lesson.run('d', '2026-11-13', 1, '08:30', 'Фізика', '305', 'canceled');
  lesson.run('e', '2026-11-16', 1, '08:30', 'Алгебра', '214', 'normal');
  lesson.run('f', '2026-11-16', 2, '09:25', 'Фізична культура', null, 'normal');
  task.run('1', 'Алгебра', '№ 1', '2026-11-12', 0, 0, 0);
  task.run('2', 'Алгебра', '§12, № 245', '2026-11-16', 0, 0, 0);
  task.run('3', 'Фізична культура', '', '2026-11-16', 0, 0, 0);
  task.run('4', 'Біологія', 'зроблене', '2026-11-16', 1, 0, 0);
  task.run('5', 'Хімія', 'прибране вчителем', '2026-11-16', 0, 0, 1);

  assert.equal(scheduleText(db, 1, '2026-11-12', '2026-11-12'), [
    '📅 Сьогодні, 12.11',
    '1. 08:30 Алгебра · каб. 214 · ДЗ',
    '2. 09:25 Хімія · каб. 308 (заміна)',
    '3. 10:25 Геометрія · спортзал — скасовано',
  ].join('\n'));
  assert.equal(scheduleText(db, 1, '2026-11-14', '2026-11-12'), '📅 Субота, 14.11\nУроків немає.');

  assert.equal(nextSchoolDay(db, 1, '2026-11-12'), '2026-11-16', 'день с одними отменёнными уроками пропускается');
  assert.equal(nextSchoolDay(db, 1, '2026-11-16'), '2026-11-17', 'расписания нет — просто следующий день');

  assert.equal(digestText(db, 1, '2026-11-12'), [
    '📚 На понеділок, 16.11 3 завдання, не зроблено 2:',
    '• Алгебра: §12, № 245',
    '• Фізична культура: (без тексту)',
  ].join('\n'));
  // скрытый предмет в сводку не попадает
  db.prepare("UPDATE users SET hidden_subjects = ? WHERE tg_id = 1").run(JSON.stringify(['Фізична культура']));
  assert.match(digestText(db, 1, '2026-11-12'), /2 завдання, не зроблено 1:/);
  // всё сделано — писать не о чем
  db.prepare("UPDATE tasks SET done = 1 WHERE task_id = '2'").run();
  assert.equal(digestText(db, 1, '2026-11-12'), null);
  // «завтра», когда следующий учебный день — действительно завтра
  db.prepare("UPDATE tasks SET done = 0 WHERE task_id = '2'").run();
  assert.match(digestText(db, 1, '2026-11-15'), /^📚 На завтра /);
});

test('бот в чате: команды, справка и неизвестные сообщения', async () => {
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    sent.push({ method: String(url).split('/').pop(), ...JSON.parse(init.body) });
    return new Response(JSON.stringify({ ok: true, result: {} }));
  };
  try {
    const bot = createBot('1:x', {
      publicUrl: 'https://app.example',
      commands: {
        '/today': { description: 'розклад на сьогодні', run: async (id) => ({ text: `розклад для ${id}` }) },
        '/hidden': { run: async () => ({ text: 'секрет', button: true }) },
      },
    });
    const msg = (text, type = 'private') => ({ message: { text, chat: { id: 5, type }, from: { id: 5 } } });
    await bot.handle(msg('/today'));
    await bot.handle(msg('/TODAY@some_bot extra'));
    await bot.handle(msg('/start'));
    await bot.handle(msg('привіт'));
    await bot.handle(msg('/today', 'group')); // в группах бот молчит
    assert.equal(sent.length, 4);
    assert.deepEqual([sent[0].text, sent[1].text], ['розклад для 5', 'розклад для 5']);
    assert.equal(sent[0].reply_markup, undefined);
    assert.match(sent[2].text, /\/today — розклад на сьогодні/);
    assert.doesNotMatch(sent[2].text, /hidden/);
    assert.equal(sent[2].reply_markup.inline_keyboard[0][0].web_app.url, 'https://app.example');
    assert.match(sent[3].text, /\/help/);
  } finally {
    globalThis.fetch = realFetch;
  }
});
