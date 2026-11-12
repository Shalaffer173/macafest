// Кто запускал бота и кто вошёл в дневник: npm run users
// Только читает базу. Это личные данные людей — не пересылай вывод в общие чаты.
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync(process.env.DB_PATH || './data/bot.sqlite', { readOnly: true });
const rows = db.prepare(`
  SELECT v.tg_id, v.name AS telegram, v.username AS nick, substr(v.first_at, 1, 16) AS first_message,
         v.messages, u.student_name AS student, u.session IS NOT NULL AS logged_in, substr(u.last_sync, 1, 16) AS synced
  FROM visitors v LEFT JOIN users u USING (tg_id)
  UNION ALL
  SELECT u.tg_id, NULL, NULL, NULL, NULL, u.student_name, u.session IS NOT NULL, substr(u.last_sync, 1, 16)
  FROM users u WHERE u.tg_id NOT IN (SELECT tg_id FROM visitors)
  ORDER BY first_message`).all();
console.table(rows.map((r) => ({ ...r, logged_in: r.logged_in ? 'так' : 'ні' })));
console.log(`Писали боту: ${rows.filter((r) => r.first_message).length}. Увійшли в щоденник: ${rows.filter((r) => r.logged_in).length}.`);
