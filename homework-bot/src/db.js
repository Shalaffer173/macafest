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
    CREATE TABLE IF NOT EXISTS lessons (
      tg_id     INTEGER NOT NULL REFERENCES users(tg_id) ON DELETE CASCADE,
      lesson_id TEXT NOT NULL,
      date      TEXT NOT NULL,       -- YYYY-MM-DD
      number    INTEGER,             -- номер урока
      start     TEXT,                -- HH:MM
      duration  INTEGER,             -- минуты
      subject   TEXT NOT NULL,
      room      TEXT,
      teacher   TEXT,
      topic     TEXT,
      status    TEXT NOT NULL DEFAULT 'normal', -- normal | canceled | replacement | replaced
      reason    TEXT,
      PRIMARY KEY (tg_id, lesson_id)
    );
    CREATE INDEX IF NOT EXISTS lessons_by_date ON lessons (tg_id, date);
    CREATE TABLE IF NOT EXISTS grades (
      tg_id       INTEGER NOT NULL REFERENCES users(tg_id) ON DELETE CASCADE,
      grade_id    TEXT NOT NULL,
      subject     TEXT NOT NULL,
      date        TEXT NOT NULL,     -- дата оценки
      lesson_date TEXT NOT NULL,     -- дата урока, к которому она привязана
      label       TEXT NOT NULL,     -- что показывать: «10», «зарах.», «Н»
      value       REAL,              -- число для среднего балла или NULL
      kind        TEXT NOT NULL,     -- current | summary | missing
      type        TEXT,              -- «Поточна», «Тематична»…
      topic       TEXT,
      comment     TEXT,
      PRIMARY KEY (tg_id, grade_id)
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
  // v0.1.2: список за весь учебный год
  const ucols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (!ucols.includes('covered_from')) {
    db.exec('ALTER TABLE users ADD COLUMN covered_from TEXT');   // с какой даты задания уже загружались
    db.exec('ALTER TABLE users ADD COLUMN last_full_sync TEXT'); // когда последний раз перечитан весь год
  }
  // v0.2: расписание и оценки. extras_synced = 0, пока они ни разу не загружались целиком
  if (!db.prepare('PRAGMA table_info(users)').all().some((c) => c.name === 'extras_synced')) {
    db.exec('ALTER TABLE users ADD COLUMN extras_synced INTEGER NOT NULL DEFAULT 0');
  }
  // v0.3: границы учебного года и второго семестра из дневника
  if (!db.prepare('PRAGMA table_info(users)').all().some((c) => c.name === 'year_start')) {
    db.exec('ALTER TABLE users ADD COLUMN year_start TEXT');
    db.exec('ALTER TABLE users ADD COLUMN semester2_start TEXT');
  }
  // v0.1.3: задания, по которым ученик сдал ответ в дневнике, отмечаются сделанными
  if (!db.prepare('PRAGMA table_info(tasks)').all().some((c) => c.name === 'answered')) {
    db.exec('ALTER TABLE tasks ADD COLUMN answered INTEGER NOT NULL DEFAULT 0');
  }
  return db;
}
