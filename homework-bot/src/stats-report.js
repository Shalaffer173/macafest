// Таблица статистики по дням: npm run stats   (CSV для таблиц: npm run stats -- --csv > stats.csv)
import { DatabaseSync } from 'node:sqlite';

const COLUMNS = [
  ['active_users', 'людей'], ['app_opens', 'відкриттів'], ['tasks_ticked', 'галочок'], ['ticked_in_time', 'вчасно'],
  ['answers_sent', 'здано через бот'], ['due_total', 'задано на день'], ['due_done', 'з них зроблено'],
  ['found_tasks', 'нових завдань'], ['found_backdated', 'заднім числом'], ['found_undated', 'без дати'],
  ['found_changed', 'змінених'], ['found_grades', 'оцінок'], ['found_schedule', 'змін розкладу'],
  ['messages_sent', 'повідомлень'], ['users_logged', 'підключено'],
];
const db = new DatabaseSync(process.env.DB_PATH || './data/bot.sqlite', { readOnly: true });
const rows = db.prepare('SELECT date, metric, value FROM stats_daily ORDER BY date').all();
const byDate = new Map();
for (const r of rows) {
  if (!byDate.has(r.date)) byDate.set(r.date, {});
  byDate.get(r.date)[r.metric] = r.value;
}
const table = [...byDate].map(([date, m]) => ({ дата: date, ...Object.fromEntries(COLUMNS.map(([k, label]) => [label, m[k] ?? 0])) }));
if (process.argv.includes('--csv')) {
  const head = ['дата', ...COLUMNS.map(([, l]) => l)];
  console.log(head.join(','));
  for (const r of table) console.log(head.map((h) => r[h]).join(','));
} else if (!table.length) {
  console.log('Статистики ще немає: вона з’являється, коли ботом користуються.');
} else {
  console.table(table);
  const sum = (k) => table.reduce((s, r) => s + r[k], 0);
  const share = sum('задано на день') ? Math.round((sum('з них зроблено') / sum('задано на день')) * 100) : null;
  console.log(`Днів: ${table.length}. Завдань заднім числом спіймано: ${sum('заднім числом')}, без дати: ${sum('без дати')}.`
    + (share != null ? ` Відмічено зробленими до дня уроку: ${share}% заданого.` : ''));
}
