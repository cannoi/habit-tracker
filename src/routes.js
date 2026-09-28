'use strict';
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const L = require('./logic');
const { rateLimit } = require('./security');

module.exports = function createRoutes({ db, jwtSecret, authRateMax }) {
  const router = express.Router();

  /* ---------- helpers ---------- */
  const ah = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  const fail = (res, status, code, error) => res.status(status).json({ error, code });
  const nowIso = () => new Date().toISOString();
  const intParam = v => (/^\d+$/.test(String(v)) ? parseInt(v, 10) : null);

  // "today" comes from the client (its local calendar day). Only accept it if it is within
  // +-2 days of the server's UTC date, so it cannot be used to write into the far future.
  function getToday(req) {
    const t = req.query && req.query.today;
    const server = L.todayUTC();
    if (typeof t === 'string' && L.isValidDate(t) && Math.abs(L.diffDays(server, t)) <= 2) return t;
    return server;
  }

  const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: authRateMax, code: 'RATE_LIMITED' });
  const sensitiveLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, max: 10, keyFn: req => 'u' + (req.user ? req.user.id : req.ip),
  });

  let dummy;
  const dummyHash = () => dummy || (dummy = bcrypt.hash('dummy-password-for-timing', 10));
  const signToken = u => jwt.sign({ id: u.id, tv: u.token_version || 0 }, jwtSecret, { expiresIn: '7d' });

  const auth = ah(async (req, res, next) => {
    const m = /^Bearer (.+)$/i.exec(req.headers.authorization || '');
    if (!m) return fail(res, 401, 'UNAUTHORIZED', 'Authentication required');
    let payload;
    try {
      payload = jwt.verify(m[1], jwtSecret, { algorithms: ['HS256'] });
    } catch (_) {
      return fail(res, 401, 'INVALID_TOKEN', 'Invalid or expired token');
    }
    const user = await db.get('SELECT id, username, email, created_at, token_version FROM users WHERE id = ?', [payload.id]);
    if (!user || (user.token_version || 0) !== (payload.tv || 0)) {
      return fail(res, 401, 'INVALID_TOKEN', 'Invalid or expired token');
    }
    req.user = user;
    next();
  });

  /* ---------- data access ---------- */
  async function groupedLogs(userId) {
    const rows = await db.all(
      'SELECT l.habit_id, l.date, l.count FROM habit_logs l JOIN habits h ON h.id = l.habit_id WHERE h.user_id = ?', [userId]);
    const map = {};
    for (const r of rows) {
      (map[r.habit_id] = map[r.habit_id] || {})[r.date] = r.count == null ? 1 : r.count;
    }
    return map;
  }
  async function habitCounts(habitId) {
    const rows = await db.all('SELECT date, count FROM habit_logs WHERE habit_id = ?', [habitId]);
    const counts = {};
    for (const r of rows) counts[r.date] = r.count == null ? 1 : r.count;
    return counts;
  }
  const findHabit = (userId, id) => db.get('SELECT * FROM habits WHERE id = ? AND user_id = ?', [id, userId]);

  async function viewOf(row, today) {
    return L.buildHabitView(row, await habitCounts(row.id), today);
  }
  async function refreshStreak(row, today) {
    const v = await viewOf(row, today);
    await db.run('UPDATE habits SET streak = ?, best_streak = MAX(COALESCE(best_streak, 0), ?), updated_at = ? WHERE id = ?',
      [v.streak, v.best_streak, nowIso(), row.id]);
    return v;
  }
  async function createHabit(userId, body) {
    const { value, error } = L.validateHabitInput(body);
    if (error) return { error };
    const now = nowIso();
    const r = await db.run(
      `INSERT INTO habits (user_id, name, description, target, streak, best_streak, color, icon, schedule, reminder_time, archived, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?, ?, 0, ?, ?)`,
      [userId, value.name, value.description, value.target, value.color, value.icon, value.schedule, value.reminder_time, now, now]);
    return { id: r.lastID };
  }
  async function setCount(row, userId, date, count, today) {
    if (count <= 0) {
      await db.run('DELETE FROM habit_logs WHERE habit_id = ? AND date = ?', [row.id, date]);
    } else {
      const done = count >= L.normTarget(row.target) ? 1 : 0;
      await db.run(
        `INSERT INTO habit_logs (habit_id, user_id, date, completed, count, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(habit_id, date) DO UPDATE SET count = excluded.count, completed = excluded.completed`,
        [row.id, userId, date, done, count, nowIso()]);
    }
    return refreshStreak(row, today);
  }

  /* ---------- auth ---------- */
  router.post('/register', authLimiter, ah(async (req, res) => {
    const { username, password, email } = req.body || {};
    if (!L.validUsername(username)) {
      return fail(res, 400, 'INVALID_USERNAME', 'Username must be 3-32 characters: letters, numbers, . _ -');
    }
    if (!L.validPassword(password)) {
      return fail(res, 400, 'INVALID_PASSWORD', 'Password must be 8-72 characters');
    }
    if (email != null && email !== '' && !L.validEmail(email)) {
      return fail(res, 400, 'INVALID_EMAIL', 'Invalid email address');
    }
    const name = username.trim();
    if (await db.get('SELECT id FROM users WHERE username = ? COLLATE NOCASE', [name])) {
      return fail(res, 400, 'USER_EXISTS', 'User already exists');
    }
    const hash = await bcrypt.hash(password, 10);
    try {
      const r = await db.run('INSERT INTO users (username, password, email, created_at) VALUES (?, ?, ?, ?)',
        [name, hash, email || null, nowIso()]);
      res.status(201).json({ id: r.lastID });
    } catch (err) {
      if (/UNIQUE/i.test(err.message)) return fail(res, 400, 'USER_EXISTS', 'User already exists');
      throw err;
    }
  }));

  router.post('/login', authLimiter, ah(async (req, res) => {
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string' || !username.trim() || !password) {
      return fail(res, 400, 'INVALID_INPUT', 'Username and password are required');
    }
    const name = username.trim();
    const user = await db.get('SELECT * FROM users WHERE username = ? COLLATE NOCASE ORDER BY (username = ?) DESC LIMIT 1', [name, name]);
    const hash = user && user.password ? user.password : await dummyHash();
    const ok = await bcrypt.compare(password, hash).catch(() => false);
    if (!user || !ok) return fail(res, 401, 'INVALID_CREDENTIALS', 'Invalid username or password');
    res.status(200).json({ token: signToken(user), id: user.id, username: user.username });
  }));

  router.get('/api/me', auth, (req, res) => {
    const { id, username, email, created_at } = req.user;
    res.json({ id, username, email, created_at });
  });

  router.put('/api/me', auth, ah(async (req, res) => {
    const email = (req.body || {}).email;
    if (email != null && email !== '' && !L.validEmail(email)) return fail(res, 400, 'INVALID_EMAIL', 'Invalid email address');
    await db.run('UPDATE users SET email = ? WHERE id = ?', [email || null, req.user.id]);
    res.json({ id: req.user.id, username: req.user.username, email: email || null });
  }));

  router.post('/api/me/password', auth, sensitiveLimiter, ah(async (req, res) => {
    const { current_password, new_password } = req.body || {};
    if (!L.validPassword(new_password)) return fail(res, 400, 'INVALID_PASSWORD', 'Password must be 8-72 characters');
    const row = await db.get('SELECT * FROM users WHERE id = ?', [req.user.id]);
    const ok = typeof current_password === 'string' && await bcrypt.compare(current_password, row.password).catch(() => false);
    if (!ok) return fail(res, 401, 'INVALID_CREDENTIALS', 'Current password is incorrect');
    const hash = await bcrypt.hash(new_password, 10);
    const tv = (row.token_version || 0) + 1;
    await db.run('UPDATE users SET password = ?, token_version = ? WHERE id = ?', [hash, tv, row.id]);
    res.json({ token: signToken({ id: row.id, token_version: tv }) }); // other sessions are now invalid
  }));

  router.delete('/api/me', auth, sensitiveLimiter, ah(async (req, res) => {
    const password = (req.body || {}).password;
    const row = await db.get('SELECT * FROM users WHERE id = ?', [req.user.id]);
    const ok = typeof password === 'string' && await bcrypt.compare(password, row.password).catch(() => false);
    if (!ok) return fail(res, 401, 'INVALID_CREDENTIALS', 'Password is incorrect');
    await db.run('DELETE FROM habit_logs WHERE habit_id IN (SELECT id FROM habits WHERE user_id = ?) OR user_id = ?', [row.id, row.id]);
    await db.run('DELETE FROM habits WHERE user_id = ?', [row.id]);
    await db.run('DELETE FROM users WHERE id = ?', [row.id]);
    res.status(204).end();
  }));

  /* ---------- habits (new API) ---------- */
  router.get('/api/habits', auth, ah(async (req, res) => {
    const today = getToday(req);
    const archived = req.query.archived === '1' ? 1 : 0;
    const rows = await db.all('SELECT * FROM habits WHERE user_id = ? AND COALESCE(archived, 0) = ? ORDER BY id', [req.user.id, archived]);
    const logs = await groupedLogs(req.user.id);
    res.json(rows.map(r => L.buildHabitView(r, logs[r.id] || {}, today)));
  }));

  router.post('/api/habits', auth, ah(async (req, res) => {
    const r = await createHabit(req.user.id, req.body);
    if (r.error) return res.status(400).json({ error: r.error.message, code: 'INVALID_HABIT', field: r.error.field });
    const row = await findHabit(req.user.id, r.id);
    res.status(201).json({ habit: await viewOf(row, getToday(req)) });
  }));

  router.put('/api/habits/:id', auth, ah(async (req, res) => {
    const id = intParam(req.params.id);
    const row = id && await findHabit(req.user.id, id);
    if (!row) return fail(res, 404, 'NOT_FOUND', 'Habit not found');
    const { value, error } = L.validateHabitInput(req.body, { partial: true });
    if (error) return res.status(400).json({ error: error.message, code: 'INVALID_HABIT', field: error.field });
    const keys = Object.keys(value);
    if (keys.length) {
      // keys come only from validateHabitInput's fixed whitelist - never from the request.
      await db.run(`UPDATE habits SET ${keys.map(k => k + ' = ?').join(', ')}, updated_at = ? WHERE id = ?`,
        [...keys.map(k => value[k]), nowIso(), id]);
    }
    const today = getToday(req);
    res.json({ habit: await refreshStreak(await findHabit(req.user.id, id), today) });
  }));

  router.post('/api/habits/:id/archive', auth, ah(async (req, res) => {
    const id = intParam(req.params.id);
    const row = id && await findHabit(req.user.id, id);
    if (!row) return fail(res, 404, 'NOT_FOUND', 'Habit not found');
    const archived = (req.body || {}).archived === false ? 0 : 1;
    await db.run('UPDATE habits SET archived = ?, updated_at = ? WHERE id = ?', [archived, nowIso(), id]);
    res.json({ habit: await viewOf(await findHabit(req.user.id, id), getToday(req)) });
  }));

  router.delete('/api/habits/:id', auth, ah(async (req, res) => {
    const id = intParam(req.params.id);
    const row = id && await findHabit(req.user.id, id);
    if (!row) return fail(res, 404, 'NOT_FOUND', 'Habit not found');
    await db.run('DELETE FROM habit_logs WHERE habit_id = ?', [id]);
    await db.run('DELETE FROM habits WHERE id = ?', [id]);
    res.status(204).end();
  }));

  router.put('/api/habits/:id/logs/:date', auth, ah(async (req, res) => {
    const id = intParam(req.params.id);
    const row = id && await findHabit(req.user.id, id);
    if (!row) return fail(res, 404, 'NOT_FOUND', 'Habit not found');
    const today = getToday(req);
    const date = req.params.date;
    if (!L.isValidDate(date)) return fail(res, 400, 'INVALID_DATE', 'Invalid date');
    if (date > today) return fail(res, 400, 'FUTURE_DATE', 'Cannot log a future date');
    if (L.diffDays(date, today) > 730) return fail(res, 400, 'INVALID_DATE', 'Date is too far in the past');
    const count = Number((req.body || {}).count);
    if (!Number.isInteger(count) || count < 0 || count > L.MAX_LOG_COUNT) {
      return fail(res, 400, 'INVALID_COUNT', `Count must be a whole number from 0 to ${L.MAX_LOG_COUNT}`);
    }
    res.json({ habit: await setCount(row, req.user.id, date, count, today) });
  }));

  // History for one habit. Registered on the legacy path as well as /api.
  ['/habits/:habit_id/logs', '/api/habits/:habit_id/logs'].forEach(p => {
    router.get(p, auth, ah(async (req, res) => {
      const id = intParam(req.params.habit_id);
      const row = id && await findHabit(req.user.id, id);
      if (!row) return fail(res, 404, 'NOT_FOUND', 'Habit not found');
      const from = L.isValidDate(req.query.from) ? req.query.from : '0000-01-01';
      const to = L.isValidDate(req.query.to) ? req.query.to : '9999-12-31';
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 1000, 1), 1000);
      const rows = await db.all(
        'SELECT * FROM habit_logs WHERE habit_id = ? AND date >= ? AND date <= ? ORDER BY date DESC LIMIT ?', [id, from, to, limit]);
      res.json(rows.map(r => ({ ...r, count: r.count == null ? 1 : r.count })));
    }));
  });

  /* ---------- legacy v1 endpoints (kept, but now authenticated & scoped to the token's user) ---------- */
  router.post('/habits', auth, ah(async (req, res) => {
    const r = await createHabit(req.user.id, req.body); // any user_id in the body is ignored
    if (r.error) return fail(res, 400, 'INVALID_HABIT', 'Error adding habit');
    res.status(201).json({ id: r.id });
  }));

  router.post('/habits/:id/complete', auth, ah(async (req, res) => {
    const id = intParam(req.params.id);
    const row = id && await findHabit(req.user.id, id);
    if (!row) return fail(res, 404, 'NOT_FOUND', 'Habit not found');
    const today = getToday(req);
    const date = (req.body || {}).date == null ? today : req.body.date;
    if (!L.isValidDate(date) || date > today) return fail(res, 400, 'INVALID_DATE', 'Error marking habit as completed');
    const counts = await habitCounts(id);
    await setCount(row, req.user.id, date, Math.min((counts[date] || 0) + 1, L.MAX_LOG_COUNT), today);
    res.status(200).send('Habit marked as completed');
  }));

  router.get('/habits/:user_id', auth, ah(async (req, res) => {
    if (String(req.user.id) !== String(req.params.user_id)) return fail(res, 403, 'FORBIDDEN', 'Forbidden');
    const today = getToday(req);
    const rows = await db.all('SELECT * FROM habits WHERE user_id = ? AND COALESCE(archived, 0) = 0 ORDER BY id', [req.user.id]);
    const logs = await groupedLogs(req.user.id);
    res.json(rows.map(r => L.buildHabitView(r, logs[r.id] || {}, today)));
  }));

  /* ---------- statistics & export ---------- */
  router.get('/api/stats', auth, ah(async (req, res) => {
    const rows = await db.all('SELECT * FROM habits WHERE user_id = ? AND COALESCE(archived, 0) = 0 ORDER BY id', [req.user.id]);
    res.json(L.buildStats(rows, await groupedLogs(req.user.id), getToday(req)));
  }));

  async function exportData(userId) {
    const habits = await db.all('SELECT * FROM habits WHERE user_id = ? ORDER BY id', [userId]);
    const logs = await groupedLogs(userId);
    return habits.map(h => ({
      id: h.id, name: h.name, description: h.description || '', target: L.normTarget(h.target),
      color: h.color, icon: h.icon, schedule: L.normSchedule(h.schedule), reminder_time: h.reminder_time || null,
      archived: h.archived ? 1 : 0, created_at: h.created_at,
      logs: Object.keys(logs[h.id] || {}).sort().map(date => ({ date, count: logs[h.id][date] })),
    }));
  }

  router.get('/api/export', auth, ah(async (req, res) => {
    res.set('Content-Disposition', 'attachment; filename="habit-tracker-export.json"');
    res.json({
      exported_at: nowIso(),
      user: { username: req.user.username, email: req.user.email },
      habits: await exportData(req.user.id),
    });
  }));

  router.get('/api/export.csv', auth, ah(async (req, res) => {
    const lines = ['habit,date,count,target'];
    for (const h of await exportData(req.user.id)) {
      for (const l of h.logs) lines.push([h.name, l.date, l.count, h.target].map(L.csvCell).join(','));
    }
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="habit-tracker-export.csv"');
    res.send('\ufeff' + lines.join('\n') + '\n');
  }));

  router.use('/api', (req, res) => fail(res, 404, 'NOT_FOUND', 'Not found'));
  return router;
};
