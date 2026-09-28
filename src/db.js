'use strict';
// Thin promise wrapper around sqlite3 + idempotent, data-preserving migrations.
const sqlite3 = require('sqlite3').verbose();

function open(dbPath) {
  const raw = new sqlite3.Database(dbPath);
  raw.serialize(); // one statement at a time, in order

  const run = (sql, params = []) => new Promise((resolve, reject) => {
    raw.run(sql, params, function (err) {
      if (err) reject(err); else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
  const get = (sql, params = []) => new Promise((resolve, reject) => {
    raw.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
  const all = (sql, params = []) => new Promise((resolve, reject) => {
    raw.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
  const close = () => new Promise((resolve, reject) => {
    raw.close(err => (err ? reject(err) : resolve()));
  });

  const db = { run, get, all, close, raw };
  db.ready = migrate(db);
  db.ready.catch(err => console.error('[db] migration failed:', err));
  return db;
}

async function ensureColumn(db, table, column, ddl) {
  const cols = await db.all(`PRAGMA table_info(${table})`);
  if (!cols.some(c => c.name === column)) {
    await db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}

async function migrate(db) {
  await db.run('PRAGMA foreign_keys = ON');

  // Original schema (unchanged) - so databases created by v1 keep working.
  await db.run("CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, password TEXT, email TEXT)");
  await db.run("CREATE TABLE IF NOT EXISTS habits (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, name TEXT, description TEXT, target INTEGER, streak INTEGER, created_at TEXT, updated_at TEXT, FOREIGN KEY(user_id) REFERENCES users(id))");
  await db.run("CREATE TABLE IF NOT EXISTS habit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, habit_id INTEGER, user_id INTEGER, date TEXT, completed BOOLEAN, created_at TEXT, FOREIGN KEY(habit_id) REFERENCES habits(id), FOREIGN KEY(user_id) REFERENCES users(id))");

  // v2 additions (additive only).
  await ensureColumn(db, 'users', 'created_at', 'TEXT');
  await ensureColumn(db, 'users', 'token_version', 'INTEGER DEFAULT 0');
  await ensureColumn(db, 'habits', 'color', "TEXT DEFAULT '#4f46e5'");
  await ensureColumn(db, 'habits', 'icon', "TEXT DEFAULT '🎯'");
  await ensureColumn(db, 'habits', 'schedule', "TEXT DEFAULT '1234567'");
  await ensureColumn(db, 'habits', 'reminder_time', 'TEXT');
  await ensureColumn(db, 'habits', 'archived', 'INTEGER DEFAULT 0');
  await ensureColumn(db, 'habits', 'best_streak', 'INTEGER DEFAULT 0');
  await ensureColumn(db, 'habit_logs', 'count', 'INTEGER DEFAULT 1');

  await db.run('CREATE INDEX IF NOT EXISTS idx_habits_user ON habits(user_id)');

  // v1 allowed several log rows per habit/day. Merge them once (as count) and
  // then enforce one row per habit/day.
  const idx = await db.get("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_logs_habit_date'");
  if (!idx) {
    await db.run(`UPDATE habit_logs SET count = (SELECT COUNT(*) FROM habit_logs l2 WHERE l2.habit_id = habit_logs.habit_id AND l2.date = habit_logs.date)
                  WHERE id IN (SELECT MIN(id) FROM habit_logs GROUP BY habit_id, date)`);
    await db.run('DELETE FROM habit_logs WHERE id NOT IN (SELECT MIN(id) FROM habit_logs GROUP BY habit_id, date)');
    await db.run('CREATE UNIQUE INDEX idx_logs_habit_date ON habit_logs(habit_id, date)');
  }
}

module.exports = { open };
