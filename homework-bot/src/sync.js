// Синхронизация: сравнивает свежий список заданий с сохранённым и находит
// новые, изменённые и удалённые. Галочки «сделано» хранятся только у нас.

/**
 * Чистая функция сравнения.
 * existing: Map(task_id -> строка из БД), fetched: задания из дневника,
 * lastSyncDay: YYYY-MM-DD прошлой синхронизации или null для первой.
 */
export function diffTasks(existing, fetched, { lastSyncDay, from, to }) {
  const added = [], changed = [], restored = [], removed = [];
  const seen = new Set();
  for (const t of fetched) {
    seen.add(t.id);
    const old = existing.get(t.id);
    if (!old) {
      // «Задним числом»: задание появилось уже после того, как мы видели этот день.
      const backdated = lastSyncDay != null && (t.assigned ?? t.due) < lastSyncDay;
      added.push({ ...t, backdated });
    } else if (old.text !== t.text || old.due !== t.due) {
      changed.push(t);
    } else if (old.removed) {
      restored.push(t);
    }
  }
  for (const [id, old] of existing) {
    if (!seen.has(id) && !old.removed && old.due >= from && old.due <= to) removed.push(old);
  }
  return { added, changed, restored, removed };
}

const today = () => new Date().toISOString().slice(0, 10);
function shift(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Одна синхронизация пользователя. Возвращает { diff, first } для уведомлений. */
export async function syncUser(db, provider, tgId, session, cfg) {
  const user = db.prepare('SELECT last_sync FROM users WHERE tg_id = ?').get(tgId);
  const lastSyncDay = user?.last_sync ? user.last_sync.slice(0, 10) : null;
  const from = shift(today(), -cfg.daysBack);
  const to = shift(today(), cfg.daysForward);

  const fetched = await provider.fetchTasks(session, from, to);
  const rows = db.prepare('SELECT * FROM tasks WHERE tg_id = ?').all(tgId);
  const existing = new Map(rows.map((r) => [r.task_id, r]));
  const diff = diffTasks(existing, fetched, { lastSyncDay, from, to });
  const now = new Date().toISOString();

  const ins = db.prepare(`INSERT INTO tasks
    (tg_id, task_id, subject, text, topic, due, assigned, files, backdated, first_seen, done, done_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  // Изменённое задание снова становится несделанным: учитель мог поменять условие.
  const upd = db.prepare(`UPDATE tasks SET subject = ?, text = ?, topic = ?, due = ?, assigned = ?, files = ?,
    changed = 1, removed = 0, done = 0, done_at = NULL WHERE tg_id = ? AND task_id = ?`);
  const setRemoved = db.prepare('UPDATE tasks SET removed = ? WHERE tg_id = ? AND task_id = ?');

  db.exec('BEGIN');
  try {
    for (const t of diff.added) {
      // При первом входе прошедшие задания считаем сделанными: иначе список начнётся
      // с десятков «просроченных» за прошлые недели. Галочку можно снять.
      const past = lastSyncDay == null && t.due < today();
      ins.run(tgId, t.id, t.subject, t.text, t.topic, t.due, t.assigned, t.files, t.backdated ? 1 : 0, now, past ? 1 : 0, past ? now : null);
    }
    for (const t of diff.changed) upd.run(t.subject, t.text, t.topic, t.due, t.assigned, t.files, tgId, t.id);
    for (const t of diff.restored) setRemoved.run(0, tgId, t.id);
    for (const t of diff.removed) setRemoved.run(1, tgId, t.task_id);
    db.prepare('UPDATE users SET last_sync = ?, sync_error = NULL WHERE tg_id = ?').run(now, tgId);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { diff, first: lastSyncDay == null };
}

const fmt = (iso) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;
const cut = (s, n = 120) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Текст уведомления о результатах синхронизации или null, если сообщать нечего. */
export function describeDiff({ diff, first }) {
  if (first) return null; // при первом входе всё «новое», не шумим
  const lines = [];
  for (const t of diff.added) {
    lines.push(t.backdated
      ? `⚠️ Додано заднім числом: ${t.subject} на ${fmt(t.due)}\n${cut(t.text)}`
      : `🆕 ${t.subject} на ${fmt(t.due)}\n${cut(t.text)}`);
  }
  for (const t of diff.changed) lines.push(`✏️ Змінено: ${t.subject} на ${fmt(t.due)}\n${cut(t.text)}`);
  for (const t of diff.removed) lines.push(`🗑 Прибрано: ${t.subject} на ${fmt(t.due)}`);
  if (!lines.length) return null;
  return lines.slice(0, 10).join('\n\n') + (lines.length > 10 ? `\n\n…і ще ${lines.length - 10}` : '');
}
