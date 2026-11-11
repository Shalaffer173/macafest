import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (
      tg_id        INTEGER PRIMARY KEY,
      session      TEXT,              -- зашифрованные токены сессии, пароля здесь нет
      student_name TEXT,
      school_name  TEXT,
      last_sync    TEXT,              -- ISO-время последней удачной синхронизации
      sync_error   TEXT,
      created_at   TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tasks (
      tg_id      INTEGER NOT NULL REFERENCES users(tg_id) ON DELETE CASCADE,
      task_id    TEXT NOT NULL,       -- id задания в дневнике
      subject    TEXT NOT NULL,
      text       TEXT NOT NULL,
      topic      TEXT,
      due        TEXT NOT NULL,       -- YYYY-MM-DD, к какому уроку
      assigned   TEXT,                -- YYYY-MM-DD, на каком уроке задано
      files      INTEGER NOT NULL DEFAULT 0,
      done       INTEGER NOT NULL DEFAULT 0,
      done_at    TEXT,
      backdated  INTEGER NOT NULL DEFAULT 0,
      changed    INTEGER NOT NULL DEFAULT 0,
      removed    INTEGER NOT NULL DEFAULT 0,
      first_seen TEXT NOT NULL,
      PRIMARY KEY (tg_id, task_id)
    );
    CREATE TABLE IF NOT EXISTS login_attempts (
      tg_id INTEGER NOT NULL,
      at    INTEGER NOT NULL
    );
  `);
  // v0.1.1: задания, которые уже прошли к моменту первого входа, идут в архив,
  // а не в «сделано»: бот не знает, делал ли их ученик.
  const cols = db.prepare('PRAGMA table_info(tasks)').all().map((c) => c.name);
  if (!cols.includes('archived')) {
    db.exec('ALTER TABLE tasks ADD COLUMN archived INTEGER NOT NULL DEFAULT 0');
    // Прежняя версия ставила таким заданиям галочку сама (done_at = first_seen) — снимаем.
    db.exec('UPDATE tasks SET archived = 1, done = 0, done_at = NULL WHERE done = 1 AND done_at = first_seen');
  }
  return db;
}
