// Синхронизация: сравнивает свежий список заданий с сохранённым и находит
// новые, изменённые и удалённые. Галочки «сделано» хранятся только у нас.
// Заодно сохраняет расписание и оценки и находит новые оценки и изменения в расписании.

import { kyivNow } from './digest.js';

/**
 * Чистая функция сравнения.
 * existing: Map(task_id -> строка из БД), fetched: задания из дневника,
 * lastSyncDay: YYYY-MM-DD прошлой синхронизации или null для первой.
 */
export function diffTasks(existing, fetched, { lastSyncDay, from, to }) {
  const added = [], changed = [], restored = [], removed = [], moved = [];
  const seen = new Set();
  for (const t of fetched) {
    seen.add(t.id);
    const old = existing.get(t.id);
    if (!old) {
      // «Задним числом»: задание появилось уже после того, как мы видели этот день.
      const backdated = lastSyncDay != null && (t.assigned ?? t.due) < lastSyncDay;
      added.push({ ...t, backdated });
    } else if (old.text !== t.text) {
      changed.push(t);
    } else if (old.due !== t.due || !!old.undated !== !!t.undated) {
      // У задания без даты срок вычисляется по расписанию и может сдвинуться (урок отменили),
      // а учитель может позже поставить дату. Это не новое условие: переносим срок молча, галочку не трогаем.
      if (old.undated || t.undated) moved.push(t); else changed.push(t);
    } else if (old.removed) {
      restored.push(t);
    }
  }
  for (const [id, old] of existing) {
    if (!seen.has(id) && !old.removed && old.due >= from && old.due <= to) removed.push(old);
  }
  return { added, changed, restored, removed, moved };
}

const today = () => new Date().toISOString().slice(0, 10);
function shift(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Воскресенье той недели, в которую попадает дата: расписание удобнее хранить целыми неделями. */
export function weekEnd(iso) {
  const dow = (new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7; // 0 = понедельник
  return shift(iso, 6 - dow);
}

const OFF = new Set(['canceled', 'replaced']);
const slotOf = (l) => (l.number != null ? `n${l.number}` : l.start ? `t${l.start}` : `i${l.id ?? l.lesson_id}`);

/** Расписание дня по «ячейкам» (номер урока): какой предмет реально идёт, кабинет, время. */
function slots(lessons) {
  const by = new Map();
  for (const l of lessons) {
    const key = slotOf(l);
    const cur = by.get(key) ?? { number: l.number ?? null, start: l.start ?? null, subject: null, offSubject: null, room: null, reason: null };
    if (OFF.has(l.status)) {
      cur.offSubject ??= l.subject;
      cur.reason ??= l.reason ?? null;
    } else if (!cur.subject) {
      Object.assign(cur, { subject: l.subject, room: l.room ?? null, start: l.start ?? cur.start });
    }
    by.set(key, cur);
  }
  return by;
}

/**
 * Изменения в расписании на ближайшие дни (сегодня и 7 дней вперёд): отмены, замены, новые уроки,
 * другой кабинет или время. Дни, которых раньше не было в базе, не сравниваются — иначе каждая
 * новая неделя в окне выглядела бы как «добавлены уроки». Сегодняшние уроки, которые уже начались, пропускаются.
 */
export function scheduleChanges(oldLessons, newLessons, now) {
  const last = shift(now.date, 7);
  const inRange = (l) => l.date >= now.date && l.date <= last;
  const byDate = (list) => {
    const m = new Map();
    for (const l of list.filter(inRange)) { if (!m.has(l.date)) m.set(l.date, []); m.get(l.date).push(l); }
    return m;
  };
  const before = byDate(oldLessons), after = byDate(newLessons);
  const started = (date, slot) => {
    if (date !== now.date || !slot?.start) return false;
    return Number(slot.start.slice(0, 2)) * 60 + Number(slot.start.slice(3, 5)) <= now.minutes;
  };
  const changes = [];
  for (const [date, oldList] of before) {
    const o = slots(oldList), n = slots(after.get(date) ?? []);
    for (const key of new Set([...o.keys(), ...n.keys()])) {
      const a = o.get(key), b = n.get(key);
      const where = b ?? a;
      if (started(date, where)) continue;
      const base = { date, number: where.number, start: where.start };
      if (a?.subject && !b) changes.push({ ...base, kind: 'removed', subject: a.subject });
      else if (!a && b?.subject) changes.push({ ...base, kind: 'added', subject: b.subject, room: b.room });
      else if (a && b) {
        if (a.subject && !b.subject) changes.push({ ...base, kind: 'canceled', subject: a.subject, reason: b.reason });
        else if (!a.subject && b.subject) changes.push({ ...base, kind: 'restored', subject: b.subject, room: b.room });
        else if (a.subject && b.subject && a.subject !== b.subject) changes.push({ ...base, kind: 'replaced', subject: b.subject, was: a.subject, room: b.room });
        else if (a.subject && b.subject) {
          if (a.room && b.room && a.room !== b.room) changes.push({ ...base, kind: 'room', subject: b.subject, was: a.room, room: b.room });
          if (a.start && b.start && a.start !== b.start) changes.push({ ...base, kind: 'time', subject: b.subject, was: a.start, start: b.start });
        }
      }
    }
  }
  return changes.sort((x, y) => (x.date + String(x.number ?? 99).padStart(2, '0') + (x.start ?? '')).localeCompare(y.date + String(y.number ?? 99).padStart(2, '0') + (y.start ?? '')));
}

/** Заменяет расписание пользователя за период [from, to] свежим и возвращает изменения на ближайшие дни. */
function replaceLessons(db, tgId, lessons, from, to) {
  const old = db.prepare('SELECT lesson_id, date, number, start, subject, room, status, reason FROM lessons WHERE tg_id = ? AND date BETWEEN ? AND ?').all(tgId, from, to);
  db.prepare('DELETE FROM lessons WHERE tg_id = ? AND date BETWEEN ? AND ?').run(tgId, from, to);
  const ins = db.prepare(`INSERT OR REPLACE INTO lessons
    (tg_id, lesson_id, date, number, start, duration, subject, room, teacher, topic, status, reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const l of lessons) {
    ins.run(tgId, l.id, l.date, l.number, l.start, l.duration, l.subject, l.room, l.teacher, l.topic, l.status, l.reason);
  }
  return scheduleChanges(old, lessons, kyivNow());
}

/** Заменяет оценки за период [from, to] и возвращает появившиеся и изменённые. */
function replaceGrades(db, tgId, grades, from, to) {
  const old = new Map(db.prepare('SELECT grade_id, label FROM grades WHERE tg_id = ?').all(tgId).map((r) => [r.grade_id, r.label]));
  db.prepare('DELETE FROM grades WHERE tg_id = ? AND lesson_date BETWEEN ? AND ?').run(tgId, from, to);
  const ins = db.prepare(`INSERT OR REPLACE INTO grades
    (tg_id, grade_id, subject, date, lesson_date, label, value, kind, type, topic, comment)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const added = [], changed = [];
  for (const g of grades) {
    ins.run(tgId, g.id, g.subject, g.date, g.lessonDate, g.label, g.value, g.kind, g.type, g.topic, g.comment);
    if (!old.has(g.id)) added.push(g);
    else if (old.get(g.id) !== g.label) changed.push({ ...g, oldLabel: old.get(g.id) });
  }
  return { added, changed };
}

/** 1 сентября текущего учебного года. */
export function schoolYearStart(todayIso) {
  const y = Number(todayIso.slice(0, 4));
  return `${todayIso.slice(5, 7) >= '08' ? y : y - 1}-09-01`;
}

// Поколение правил отбора заданий. Когда бот начинает показывать то, что раньше пропускал
// (сейчас — задания без текста), у давних пользователей разом «появляются» старые записи.
// При смене поколения они один раз принимаются молча: прошедшие уходят в архив, уведомлений нет.
export const TASK_RULES = 3; // 3: задания без даты и домашка из темы урока

/**
 * Одна синхронизация пользователя. Возвращает { diff, first, ... } для уведомлений.
 * cfg.quick — быстрый первый проход: только ближайшие недели, чтобы сразу было что показать.
 */
export async function syncUser(db, provider, tgId, session, cfg) {
  const user = db.prepare('SELECT last_sync, covered_from, last_full_sync, extras_synced, year_start, semester2_start, task_rules FROM users WHERE tg_id = ?').get(tgId);
  const quick = cfg.quick === true;
  const rulesChanged = (user?.task_rules ?? 1) < TASK_RULES;
  const lastSyncDay = user?.last_sync ? user.last_sync.slice(0, 10) : null;
  // Расписание и оценки умеет отдавать не каждый источник (в тестах — только задания).
  const hasExtras = typeof provider.fetchDiary === 'function';
  // Первая загрузка оценок идёт за весь год и молча: иначе каждая старая оценка стала бы «новой».
  const extrasFirst = hasExtras && !user?.extras_synced;
  // Обычно перечитываем последние недели, а раз в сутки и при первом входе — весь учебный год.
  const fullDue = !quick && (extrasFirst || rulesChanged || !user?.last_full_sync
    || Date.now() - Date.parse(user.last_full_sync) > (cfg.fullSyncHours ?? 24) * 3600_000);
  const recent = shift(today(), -cfg.daysBack);
  // Начало года и второго семестра берём из дневника, а пока их нет — считаем от 1 сентября.
  // Дата из дневника принимается, только если она похожа на начало текущего учебного года.
  const guess = schoolYearStart(today());
  const plausible = (d) => typeof d === 'string' && d >= shift(guess, -45) && d <= today();
  let yearStart = plausible(user?.year_start) ? user.year_start : guess;
  let semester2 = plausible(user?.year_start) ? user.semester2_start ?? null : null;
  if (fullDue && typeof provider.fetchYear === 'function') {
    try {
      const year = await provider.fetchYear(session);
      if (plausible(year?.start)) { yearStart = year.start; semester2 = year.semester2 ?? null; }
    } catch (e) {
      if (e.code === 'session_expired') throw e; // остальное не страшно: остаёмся на прежних границах
    }
  }
  const from = fullDue && yearStart < recent ? yearStart : recent;
  const to = weekEnd(shift(today(), cfg.daysForward));
  // Всё, что старше этой даты, бот раньше не загружал: такие задания не «новые», а архив.
  const archiveBefore = user?.covered_from ?? today();

  const diary = hasExtras
    ? await provider.fetchDiary(session, from, to)
    : { tasks: await provider.fetchTasks(session, from, to) };
  const fetched = diary.tasks;
  const rows = db.prepare('SELECT * FROM tasks WHERE tg_id = ?').all(tgId);
  const existing = new Map(rows.map((r) => [r.task_id, r]));
  const diff = diffTasks(existing, fetched, { lastSyncDay, from, to });
  const now = new Date().toISOString();

  const ins = db.prepare(`INSERT INTO tasks
    (tg_id, task_id, subject, text, topic, due, assigned, files, backdated, first_seen, archived, answered, done, done_at, undated)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const move = db.prepare('UPDATE tasks SET due = ?, assigned = ?, undated = ? WHERE tg_id = ? AND task_id = ?');
  // Ответ сдан в дневнике -> задание сделано. Срабатывает один раз, в момент появления
  // ответа, чтобы снятая вручную галочка не возвращалась при каждой синхронизации.
  const setAnswered = db.prepare(`UPDATE tasks SET answered = 1, done = 1, done_at = ?, archived = 0
    WHERE tg_id = ? AND task_id = ? AND answered = 0`);
  // Изменённое задание снова становится несделанным: учитель мог поменять условие.
  const upd = db.prepare(`UPDATE tasks SET subject = ?, text = ?, topic = ?, due = ?, assigned = ?, files = ?, undated = ?,
    changed = 1, removed = 0, archived = 0, done = 0, done_at = NULL WHERE tg_id = ? AND task_id = ?`);
  const setRemoved = db.prepare('UPDATE tasks SET removed = ? WHERE tg_id = ? AND task_id = ?');
  let grades = { added: [], changed: [] };
  let schedule = [];

  db.exec('BEGIN');
  try {
    for (const t of diff.added) {
      // Задания из периода, который бот раньше не видел (до первого входа или до расширения
      // окна), уходят в архив: бот не знает, сделаны ли они, и не сообщает о них как о новых.
      t.archived = !t.answered && t.due < today() && (t.due < archiveBefore || rulesChanged);
      t.silent = rulesChanged; // появилось из-за новых правил бота, а не в дневнике
      if (t.archived || t.silent) t.backdated = false;
      ins.run(tgId, t.id, t.subject, t.text, t.topic, t.due, t.assigned, t.files, t.backdated ? 1 : 0, now, t.archived ? 1 : 0,
        t.answered ? 1 : 0, t.answered ? 1 : 0, t.answered ? now : null, t.undated ? 1 : 0);
    }
    for (const t of diff.changed) upd.run(t.subject, t.text, t.topic, t.due, t.assigned, t.files, t.undated ? 1 : 0, tgId, t.id);
    for (const t of diff.moved) move.run(t.due, t.assigned, t.undated ? 1 : 0, tgId, t.id);
    for (const t of diff.restored) setRemoved.run(0, tgId, t.id);
    for (const t of diff.removed) setRemoved.run(1, tgId, t.task_id);
    for (const t of fetched) if (t.answered && existing.has(t.id)) setAnswered.run(now, tgId, t.id);
    if (diary.lessons) schedule = replaceLessons(db, tgId, diary.lessons, from, to);
    if (diary.grades) grades = replaceGrades(db, tgId, diary.grades, from, to);
    const covered = user?.covered_from && user.covered_from < from ? user.covered_from : from;
    // Быстрый проход не считается ни полной загрузкой года, ни первой загрузкой оценок:
    // следом идёт обычная синхронизация, которая дотянет остальное так же молча.
    const fullDone = !quick && (from === yearStart || yearStart >= recent);
    db.prepare(`UPDATE users SET last_sync = ?, sync_error = NULL, covered_from = ?, last_full_sync = ?, extras_synced = ?,
      year_start = ?, semester2_start = ?, task_rules = ? WHERE tg_id = ?`)
      .run(now, covered, fullDone ? now : user?.last_full_sync ?? null,
        (hasExtras && !quick) || user?.extras_synced ? 1 : 0, yearStart, semester2,
        quick ? user?.task_rules ?? 1 : TASK_RULES, tgId);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return {
    diff, grades, from, to,
    first: lastSyncDay == null,
    gradesSilent: extrasFirst, // оценки загружены впервые — о них не сообщаем
    schedule, // изменения в расписании на ближайшие дни
    fetched: fetched.length,
    answered: fetched.filter((t) => t.answered).length,
    lessons: diary.lessons?.length ?? 0,
    gradesTotal: diary.grades?.length ?? 0,
    full: from === yearStart, // перечитан весь учебный год
    debug: diary.debug ?? null,
  };
}

const fmt = (iso) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;
const cut = (s, n = 120) => (!s ? '(без тексту)' : s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Текст уведомления о результатах синхронизации или null, если сообщать нечего. */
const DAYS_ACC = ['неділю', 'понеділок', 'вівторок', 'середу', 'четвер', 'п’ятницю', 'суботу'];
function dayName(date, today) {
  if (date === today) return 'сьогодні';
  if (date === shift(today, 1)) return 'завтра';
  return `${DAYS_ACC[new Date(`${date}T00:00:00Z`).getUTCDay()]}, ${fmt(date)}`;
}
const lessonName = (c) => (c.number != null ? `${c.number}-й урок` : c.start ? `урок о ${c.start}` : 'урок');
const roomText = (r) => (!r ? '' : /^\d/.test(r) ? `, каб. ${r}` : `, ${r}`);

/** Изменения расписания одним блоком на каждый день. */
export function describeSchedule(changes, today) {
  const byDate = new Map();
  for (const c of changes) {
    const line = {
      canceled: `${lessonName(c)} (${c.subject}) скасовано${c.reason ? ` — ${c.reason}` : ''}`,
      removed: `${lessonName(c)} (${c.subject}) прибрано з розкладу`,
      added: `додано ${lessonName(c)}: ${c.subject}${roomText(c.room)}`,
      restored: `${lessonName(c)} (${c.subject}) знову в розкладі${roomText(c.room)}`,
      replaced: `${lessonName(c)}: заміна ${c.was} → ${c.subject}${roomText(c.room)}`,
      room: `${lessonName(c)} (${c.subject}): кабінет ${c.was} → ${c.room}`,
      time: `${lessonName(c)} (${c.subject}): тепер о ${c.start}, а не о ${c.was}`,
    }[c.kind];
    if (!byDate.has(c.date)) byDate.set(c.date, []);
    byDate.get(c.date).push(`• ${line}`);
  }
  return [...byDate].map(([date, lines]) => `📅 Зміни в розкладі на ${dayName(date, today)}:\n${lines.join('\n')}`);
}

export function describeDiff({ diff, first, grades, gradesSilent, schedule }) {
  if (first) return null; // при первом входе всё «новое», не шумим
  const lines = [];
  for (const t of diff.added) {
    if (t.archived || t.silent) continue;
    const when = t.undated ? `без дати (найближчий урок — ${fmt(t.due)})` : `на ${fmt(t.due)}`;
    lines.push(t.backdated
      ? `⚠️ Додано заднім числом: ${t.subject} ${when}\n${cut(t.text)}`
      : `🆕 ${t.subject} ${when}\n${cut(t.text)}`);
  }
  for (const t of diff.changed) lines.push(`✏️ Змінено: ${t.subject} на ${fmt(t.due)}\n${cut(t.text)}`);
  for (const t of diff.removed) lines.push(`🗑 Прибрано: ${t.subject} на ${fmt(t.due)}`);
  if (schedule?.length) lines.push(...describeSchedule(schedule, kyivNow().date));
  if (grades && !gradesSilent) {
    const kind = (g) => (g.type ? ` (${g.type.toLowerCase()})` : '');
    for (const g of grades.added) {
      lines.push(g.kind === 'missing'
        ? `🚫 Пропуск: ${g.subject} за ${fmt(g.date)} (${g.label})`
        : `📊 Оцінка: ${g.subject} — ${g.label}${kind(g)} за ${fmt(g.date)}`);
    }
    for (const g of grades.changed) {
      if (g.kind !== 'missing') lines.push(`📊 Оцінку змінено: ${g.subject} — ${g.oldLabel} → ${g.label}${kind(g)} за ${fmt(g.date)}`);
    }
  }
  if (!lines.length) return null;
  return lines.slice(0, 10).join('\n\n') + (lines.length > 10 ? `\n\n…і ще ${lines.length - 10}` : '');
}
