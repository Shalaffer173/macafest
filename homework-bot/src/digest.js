// Тексты, которые бот пишет в чат сам или по команде: расписание на день, «что сейчас», звонки,
// вечерняя сводка и утреннее напоминание.
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

const toMin = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const toTime = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const roomOf = (r) => (!r ? '' : /^\d/.test(r) ? `, каб. ${r}` : `, ${r}`);
const lessonLabel = (l) => (l.number ? `${l.number}-й урок` : 'урок');
const OFF = new Set(['canceled', 'replaced']);
function minutesWord(n) {
  const d = n % 10, h = n % 100;
  return d === 1 && h !== 11 ? 'хвилина' : d >= 2 && d <= 4 && (h < 12 || h > 14) ? 'хвилини' : 'хвилин';
}
const inMinutes = (n) => (n >= 60 ? `${Math.floor(n / 60)} год ${n % 60} хв` : `${n} ${minutesWord(n)}`);

/** Уроки дня, которые реально идут, с началом и концом в минутах. */
function lessonsOn(db, tgId, date) {
  return db.prepare(`SELECT number, start, duration, subject, room, status FROM lessons
    WHERE tg_id = ? AND date = ? ORDER BY number, start`).all(tgId, date)
    .filter((l) => !OFF.has(l.status) && l.start)
    .map((l) => ({ ...l, from: toMin(l.start), to: toMin(l.start) + (l.duration || 45) }));
}

function nextDayLine(db, tgId, today) {
  const date = nextSchoolDay(db, tgId, today);
  const first = lessonsOn(db, tgId, date)[0];
  if (!first) return '';
  const when = date === addDays(today, 1) ? 'завтра' : `${DAYS_ACC[weekday(date)]}, ${short(date)}`;
  return `\nНаступні уроки — ${when}, перший о ${first.start}: ${first.subject}${roomOf(first.room)}.`;
}

/** /now — какой урок идёт, сколько осталось, что дальше. now = kyivNow(). */
export function nowText(db, tgId, now) {
  const list = lessonsOn(db, tgId, now.date);
  const m = now.minutes;
  if (!list.length) return `Сьогодні уроків немає.${nextDayLine(db, tgId, now.date)}`;
  const current = list.find((l) => l.from <= m && m < l.to);
  const next = list.find((l) => l.from > m);
  const nextLine = (l) => `${lessonLabel(l)}: ${l.subject} о ${l.start}${roomOf(l.room)}`;
  if (current) {
    const left = current.to - m;
    return `🔔 Зараз ${lessonLabel(current)}: ${current.subject}${roomOf(current.room)}. До дзвінка ${inMinutes(left)} (о ${toTime(current.to)}).`
      + (next ? `\nДалі ${nextLine(next)}.` : '\nЦе останній урок на сьогодні.');
  }
  if (next) {
    const wait = next.from - m;
    const first = next === list[0];
    return `${first ? '🌅 Уроки ще не почались.' : '☕ Перерва.'} Далі ${nextLine(next)} — через ${inMinutes(wait)}.`;
  }
  return `Уроки на сьогодні закінчились (останній дзвінок о ${toTime(list[list.length - 1].to)}).${nextDayLine(db, tgId, now.date)}`;
}

/** /bells — розклад дзвінків на сьогодні (или на ближайший учебный день). */
export function bellsText(db, tgId, today) {
  let date = today;
  let list = lessonsOn(db, tgId, date);
  if (!list.length) { date = nextSchoolDay(db, tgId, today); list = lessonsOn(db, tgId, date); }
  if (!list.length) return 'У розкладі поки немає уроків з часом.';
  const name = date === today ? 'сьогодні' : date === addDays(today, 1) ? 'завтра' : `${DAYS_ACC[weekday(date)]}, ${short(date)}`;
  return `🔔 Дзвінки на ${name}:\n${list.map((l) => `${l.number ?? '•'}. ${l.start}–${toTime(l.to)} ${l.subject}`).join('\n')}`;
}

/** Утреннее напоминание: что нужно сдать сегодня и ещё не сделано. null — писать не о чем. */
export function morningText(db, tgId, today) {
  const tasks = tasksDue(db, tgId, today);
  const undone = tasks.filter((t) => !t.done);
  if (!undone.length) return null;
  const list = undone.slice(0, 8).map((t) => `• ${t.subject}: ${t.text ? cut(t.text.replace(/\s+/g, ' '), 80) : '(без тексту)'}`);
  if (undone.length > 8) list.push(`…і ще ${undone.length - 8}`);
  const first = lessonsOn(db, tgId, today)[0];
  return `☀️ Доброго ранку! На сьогодні ще не зроблено ${undone.length} з ${tasks.length}:\n${list.join('\n')}`
    + (first ? `\n\nПерший урок о ${first.start}: ${first.subject}${roomOf(first.room)}.` : '');
}
