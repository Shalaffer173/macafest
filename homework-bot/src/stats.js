// Анонимная статистика использования — для исследования (МАН): только итоги по дням, без имён и Telegram-ID.
//
// Чтобы посчитать «сколько разных людей было сегодня», за текущий день хранится отпечаток
// sha256(ключ сервера + дата + id), обрезанный до 16 знаков. На следующий день отпечатки удаляются,
// остаётся только число. Связать дни между собой или восстановить по отпечатку человека нельзя.
import { createHash } from 'node:crypto';
import { kyivNow } from './digest.js';

export function createStats(db, secretKey, now = () => kyivNow().date) {
  const add = db.prepare(`INSERT INTO stats_daily (date, metric, value) VALUES (?, ?, ?)
    ON CONFLICT(date, metric) DO UPDATE SET value = value + excluded.value`);
  const put = db.prepare(`INSERT INTO stats_daily (date, metric, value) VALUES (?, ?, ?)
    ON CONFLICT(date, metric) DO UPDATE SET value = excluded.value`);
  const seenIns = db.prepare('INSERT OR IGNORE INTO stats_seen (date, h) VALUES (?, ?)');

  /** Прибавить n к счётчику за сегодня. */
  function count(metric, n = 1) {
    if (n) add.run(now(), metric, n);
  }

  /** Отметить, что человек сегодня пользовался ботом (считается один раз в день). */
  function seen(tgId) {
    const date = now();
    const h = createHash('sha256').update(`${secretKey}|${date}|${tgId}`).digest('hex').slice(0, 16);
    if (seenIns.run(date, h).changes) count('active_users');
  }

  /**
   * Итоги прошедшего дня, которые нельзя посчитать по ходу: сколько заданий было задано на этот день
   * и сколько из них отмечено сделанными, сколько людей подключено. Плюс удаление старых отпечатков.
   */
  function closeDay(date) {
    db.prepare('DELETE FROM stats_seen WHERE date < ?').run(now());
    if (db.prepare("SELECT 1 FROM stats_daily WHERE date = ? AND metric = 'day_closed'").get(date)) return false;
    const t = db.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(done), 0) AS done, COALESCE(SUM(answered), 0) AS answered
      FROM tasks WHERE due = ? AND removed = 0 AND archived = 0`).get(date);
    put.run(date, 'due_total', t.total);
    put.run(date, 'due_done', t.done);
    put.run(date, 'due_answered', t.answered);
    put.run(date, 'users_logged', db.prepare('SELECT COUNT(*) AS n FROM users WHERE session IS NOT NULL').get().n);
    put.run(date, 'day_closed', 1);
    return true;
  }

  /** Счётчики за день: { metric: value }. */
  function day(date = now()) {
    return Object.fromEntries(db.prepare('SELECT metric, value FROM stats_daily WHERE date = ?').all(date).map((r) => [r.metric, r.value]));
  }

  return { count, seen, closeDay, day };
}

/** Что из результата синхронизации относится к статистике: что бот поймал и о чём сообщил. */
export function syncMetrics(result) {
  if (!result || result.first) return {};
  const added = result.diff.added.filter((t) => !t.archived && !t.silent);
  return {
    found_tasks: added.length,
    found_backdated: added.filter((t) => t.backdated).length,
    found_undated: added.filter((t) => t.undated).length,
    found_changed: result.diff.changed.length,
    found_grades: result.gradesSilent ? 0 : result.grades.added.filter((g) => g.kind !== 'missing').length,
    found_absences: result.gradesSilent ? 0 : result.grades.added.filter((g) => g.kind === 'missing').length,
    found_schedule: result.schedule?.length ?? 0,
  };
}
