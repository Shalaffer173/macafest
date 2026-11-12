// Тексты, которые бот пишет в чат сам или по команде: расписание на день и вечерняя сводка.
// Всё считается по киевскому времени и по данным, уже лежащим в базе, — без обращений к дневнику.

const kyiv = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

/** Текущие дата и время в Киеве: { date: 'YYYY-MM-DD', minutes: минут от полуночи }. */
export function kyivNow(at = new Date()) {
  const p = Object.fromEntries(kyiv.formatToParts(at).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}

function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const DAYS = ['неділя', 'понеділок', 'вівторок', 'середа', 'четвер', 'п’ятниця', 'субота'];
const DAYS_ACC = ['неділю', 'понеділок', 'вівторок', 'середу', 'четвер', 'п’ятницю', 'суботу']; // «на середу»
const weekday = (iso) => new Date(`${iso}T00:00:00Z`).getUTCDay();
const short = (iso) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;
const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function hiddenSubjects(db, tgId) {
  try { return new Set(JSON.parse(db.prepare('SELECT hidden_subjects FROM users WHERE tg_id = ?').get(tgId)?.hidden_subjects ?? '[]')); }
  catch { return new Set(); }
}

/** Ближайший после `after` день, в котором есть неотменённые уроки; если расписания нет — следующий день. */
export function nextSchoolDay(db, tgId, after) {
  const row = db.prepare(`SELECT MIN(date) AS date FROM lessons
    WHERE tg_id = ? AND date > ? AND date <= ? AND status NOT IN ('canceled', 'replaced')`).get(tgId, after, addDays(after, 10));
  return row?.date ?? addDays(after, 1);
}

/** Невыполненные задания на день с учётом скрытых предметов. */
function tasksDue(db, tgId, date) {
  const hidden = hiddenSubjects(db, tgId);
  return db.prepare('SELECT subject, text, done FROM tasks WHERE tg_id = ? AND due = ? AND removed = 0 AND archived = 0 ORDER BY subject')
    .all(tgId, date).filter((t) => !hidden.has(t.subject));
}

/** Расписание на день текстом для чата. today нужен только для подписи «Сьогодні»/«Завтра». */
export function scheduleText(db, tgId, date, today) {
  const lessons = db.prepare(`SELECT number, start, subject, room, status FROM lessons
    WHERE tg_id = ? AND date = ? ORDER BY number, start`).all(tgId, date);
  const name = date === today ? 'Сьогодні' : date === addDays(today, 1) ? 'Завтра' : DAYS[weekday(date)].replace(/^./, (c) => c.toUpperCase());
  const title = `📅 ${name}, ${short(date)}`;
  if (!lessons.length) return `${title}\nУроків немає.`;
  const homework = new Set(tasksDue(db, tgId, date).filter((t) => !t.done).map((t) => t.subject));
  const lines = lessons.map((l) => {
    const note = { canceled: ' — скасовано', replaced: ' — замінено іншим', replacement: ' (заміна)' }[l.status] ?? '';
    const room = l.room ? ` · ${/^\d/.test(l.room) ? `каб. ${l.room}` : l.room}` : '';
    const hw = !note.startsWith(' —') && homework.has(l.subject) ? ' · ДЗ' : '';
    return `${l.number ?? '•'}${l.number ? '.' : ''} ${l.start ?? ''} ${l.subject}${room}${hw}${note}`.replace(/\s+/g, ' ').trim();
  });
  return `${title}\n${lines.join('\n')}`;
}

const plural = (n) => (n % 10 === 1 && n % 100 !== 11 ? 'завдання' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? 'завдання' : 'завдань');

/** Вечерняя сводка: что задано на следующий учебный день и не сделано. null — писать не о чем. */
export function digestText(db, tgId, today) {
  const date = nextSchoolDay(db, tgId, today);
  const tasks = tasksDue(db, tgId, date);
  const undone = tasks.filter((t) => !t.done);
  if (!undone.length) return null;
  const when = date === addDays(today, 1) ? 'завтра' : `${DAYS_ACC[weekday(date)]}, ${short(date)}`;
  const list = undone.slice(0, 8).map((t) => `• ${t.subject}: ${t.text ? cut(t.text.replace(/\s+/g, ' '), 80) : '(без тексту)'}`);
  if (undone.length > 8) list.push(`…і ще ${undone.length - 8}`);
  return `📚 На ${when} ${tasks.length} ${plural(tasks.length)}, не зроблено ${undone.length}:\n${list.join('\n')}`;
}
