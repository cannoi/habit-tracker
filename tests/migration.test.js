const os = require('os');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('../src/db');

const file = path.join(os.tmpdir(), `habit-tracker-legacy-${process.pid}-${Date.now()}.db`);
const exec = (db, sql, params = []) => new Promise((res, rej) => db.run(sql, params, err => (err ? rej(err) : res())));

afterAll(() => { for (const s of ['', '-journal', '-wal', '-shm']) { try { fs.unlinkSync(file + s); } catch (_) { /* ignore */ } } });

describe('migration from the v1 database', () => {
  it('keeps old data, merges duplicate daily logs and is idempotent', async () => {
    // Build a database exactly like the original app created it (v1 schema).
    const legacy = new sqlite3.Database(file);
    await exec(legacy, "CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, password TEXT, email TEXT)");
    await exec(legacy, "CREATE TABLE habits (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, name TEXT, description TEXT, target INTEGER, streak INTEGER, created_at TEXT, updated_at TEXT, FOREIGN KEY(user_id) REFERENCES users(id))");
    await exec(legacy, "CREATE TABLE habit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, habit_id INTEGER, user_id INTEGER, date TEXT, completed BOOLEAN, created_at TEXT, FOREIGN KEY(habit_id) REFERENCES habits(id), FOREIGN KEY(user_id) REFERENCES users(id))");
    await exec(legacy, "INSERT INTO users (username, password, email) VALUES ('old', 'hash', 'o@x.io')");
    await exec(legacy, "INSERT INTO habits (user_id, name, description, target, streak, created_at, updated_at) VALUES (1, 'Old habit', 'desc', 3, 2, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')");
    for (const d of ['2026-01-02', '2026-01-02', '2026-01-02', '2026-01-03']) {
      await exec(legacy, "INSERT INTO habit_logs (habit_id, user_id, date, completed, created_at) VALUES (1, 1, ?, 1, 'x')", [d]);
    }
    await new Promise(r => legacy.close(r));

    for (let round = 0; round < 2; round++) { // second round proves it is idempotent
      const db = open(file);
      await db.ready;
      const habit = await db.get('SELECT * FROM habits WHERE id = 1');
      expect(habit.name).toBe('Old habit');
      expect(habit.color).toBe('#4f46e5');
      expect(habit.schedule).toBe('1234567');
      expect(habit.archived).toBe(0);
      const logs = await db.all('SELECT date, count FROM habit_logs ORDER BY date');
      expect(logs).toEqual([{ date: '2026-01-02', count: 3 }, { date: '2026-01-03', count: 1 }]);
      const user = await db.get('SELECT username, email, token_version FROM users WHERE id = 1');
      expect(user.username).toBe('old');
      await db.close();
    }
  });
});
