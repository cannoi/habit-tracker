const os = require('os');
const path = require('path');
const fs = require('fs');

// Isolated database + relaxed rate limit for the test run (must be set BEFORE requiring the server).
const TMP_DB = path.join(os.tmpdir(), `habit-tracker-test-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = TMP_DB;
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret';
process.env.AUTH_RATE_MAX = '1000';

const request = require('supertest');
const app = require('../server');
const L = require('../src/logic');

const today = L.todayUTC();
const q = `today=${today}`;

afterAll(async () => {
  await app.closeDb();
  for (const suffix of ['', '-journal', '-wal', '-shm']) { try { fs.unlinkSync(TMP_DB + suffix); } catch (_) { /* ignore */ } }
  try { fs.unlinkSync(path.join(os.tmpdir(), '.jwt_secret')); } catch (_) { /* ignore */ }
});

const call = (method, url, token, body) => {
  let r = request(app)[method](url);
  if (token) r = r.set('Authorization', `Bearer ${token}`);
  return body === undefined ? r : r.send(body);
};

async function signup(username, password = 'password123') {
  const reg = await call('post', '/register', null, { username, password, email: `${username}@example.com` });
  const login = await call('post', '/login', null, { username, password });
  return { id: reg.body.id, token: login.body.token, password };
}

describe('Habit Tracker API', () => {
  it('should return health check', async () => {
    const res = await request(app)
      .get('/health');
    expect(res.statusCode).toEqual(200);
    expect(res.text).toBe('OK');
  });

  it('should register a new user', async () => {
    const res = await request(app)
      .post('/register')
      .send({
        username: 'testuser',
        password: 'testpass',
        email: 'test@example.com'
      });
    expect(res.statusCode).toEqual(201);
    expect(res.body).toHaveProperty('id');
  });

  it('should login a user', async () => {
    const res = await request(app)
      .post('/login')
      .send({
        username: 'testuser',
        password: 'testpass'
      });
    expect(res.statusCode).toEqual(200);
    expect(res.body).toHaveProperty('token');
    expect(res.body).toHaveProperty('id');
  });
});

describe('Front-end is served (fix for "Cannot GET /")', () => {
  it('serves index.html at /', async () => {
    const res = await request(app).get('/');
    expect(res.statusCode).toBe(200);
    expect(res.text).toContain('Habit Tracker');
    expect(res.text).toContain('script.js');
  });
  it('serves static assets and PWA files', async () => {
    for (const p of ['/script.js', '/styles.css', '/i18n.js', '/sw.js', '/manifest.webmanifest', '/icon-192.png', '/made-by.png']) {
      const res = await request(app).get(p);
      expect(res.statusCode).toBe(200);
    }
  });
  it('sends security headers', async () => {
    const res = await request(app).get('/');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
  });
  it('returns JSON 404 for unknown API routes', async () => {
    const res = await request(app).get('/api/nope');
    expect(res.statusCode).toBe(404);
  });
});

describe('Auth', () => {
  it('validates registration input', async () => {
    let res = await call('post', '/register', null, { username: 'ab', password: 'password123' });
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('INVALID_USERNAME');
    res = await call('post', '/register', null, { username: 'validname', password: 'short' });
    expect(res.body.code).toBe('INVALID_PASSWORD');
    res = await call('post', '/register', null, { username: 'validname', password: 'password123', email: 'nope' });
    expect(res.body.code).toBe('INVALID_EMAIL');
  });
  it('rejects duplicate usernames (case-insensitive)', async () => {
    await call('post', '/register', null, { username: 'DupUser', password: 'password123' });
    const res = await call('post', '/register', null, { username: 'dupuser', password: 'password123' });
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('USER_EXISTS');
  });
  it('rejects wrong password and unknown user with the same error', async () => {
    await signup('logintest');
    const a = await call('post', '/login', null, { username: 'logintest', password: 'wrongpassword' });
    const b = await call('post', '/login', null, { username: 'ghostuser', password: 'wrongpassword' });
    expect(a.statusCode).toBe(401);
    expect(b.statusCode).toBe(401);
    expect(a.body.code).toBe('INVALID_CREDENTIALS');
    expect(b.body.code).toBe('INVALID_CREDENTIALS');
  });
  it('requires a valid token', async () => {
    expect((await call('get', '/api/habits')).statusCode).toBe(401);
    expect((await call('get', '/api/habits', 'garbage.token.value')).statusCode).toBe(401);
  });
  it('rejects malformed JSON', async () => {
    const res = await request(app).post('/login').set('Content-Type', 'application/json').send('{bad');
    expect(res.statusCode).toBe(400);
  });
  it('returns and updates the profile', async () => {
    const u = await signup('profileuser');
    let res = await call('get', '/api/me', u.token);
    expect(res.body.username).toBe('profileuser');
    res = await call('put', '/api/me', u.token, { email: 'new@example.com' });
    expect(res.body.email).toBe('new@example.com');
    res = await call('put', '/api/me', u.token, { email: 'bad' });
    expect(res.statusCode).toBe(400);
  });
  it('changes password and invalidates old tokens', async () => {
    const u = await signup('pwuser');
    let res = await call('post', '/api/me/password', u.token, { current_password: 'nope-nope', new_password: 'newpassword1' });
    expect(res.statusCode).toBe(401);
    res = await call('post', '/api/me/password', u.token, { current_password: u.password, new_password: 'newpassword1' });
    expect(res.statusCode).toBe(200);
    expect((await call('get', '/api/me', u.token)).statusCode).toBe(401); // old token dead
    expect((await call('get', '/api/me', res.body.token)).statusCode).toBe(200); // new token works
    res = await call('post', '/login', null, { username: 'pwuser', password: 'newpassword1' });
    expect(res.statusCode).toBe(200);
  });
  it('deletes an account with password confirmation', async () => {
    const u = await signup('deleteme');
    await call('post', '/api/habits', u.token, { name: 'x' });
    expect((await call('delete', '/api/me', u.token, { password: 'wrong-pass' })).statusCode).toBe(401);
    expect((await call('delete', '/api/me', u.token, { password: u.password })).statusCode).toBe(204);
    expect((await call('post', '/login', null, { username: 'deleteme', password: u.password })).statusCode).toBe(401);
    expect((await call('get', '/api/me', u.token)).statusCode).toBe(401);
  });
});

describe('Habits', () => {
  it('creates, lists, updates, archives and deletes a habit', async () => {
    const u = await signup('habitowner');
    let res = await call('post', `/api/habits?${q}`, u.token, { name: '  Read  ', description: 'Books', target: 2, color: '#10b981', icon: '📚', schedule: [1, 2, 3, 4, 5], reminder_time: '08:30' });
    expect(res.statusCode).toBe(201);
    const id = res.body.habit.id;
    expect(res.body.habit.name).toBe('Read');
    expect(res.body.habit.schedule).toBe('12345');
    expect(res.body.habit.target).toBe(2);

    res = await call('get', `/api/habits?${q}`, u.token);
    expect(res.body).toHaveLength(1);

    res = await call('put', `/api/habits/${id}?${q}`, u.token, { name: 'Read more', target: 3 });
    expect(res.body.habit.name).toBe('Read more');
    expect(res.body.habit.target).toBe(3);
    expect(res.body.habit.color).toBe('#10b981'); // untouched fields stay

    res = await call('post', `/api/habits/${id}/archive?${q}`, u.token, { archived: true });
    expect(res.body.habit.archived).toBe(1);
    expect((await call('get', `/api/habits?${q}`, u.token)).body).toHaveLength(0);
    expect((await call('get', `/api/habits?archived=1&${q}`, u.token)).body).toHaveLength(1);
    res = await call('post', `/api/habits/${id}/archive?${q}`, u.token, { archived: false });
    expect(res.body.habit.archived).toBe(0);

    expect((await call('delete', `/api/habits/${id}`, u.token)).statusCode).toBe(204);
    expect((await call('get', `/api/habits?${q}`, u.token)).body).toHaveLength(0);
    expect((await call('delete', `/api/habits/${id}`, u.token)).statusCode).toBe(404);
  });
  it('validates habit input', async () => {
    const u = await signup('validator');
    const bad = [
      { name: '' }, { name: 'x'.repeat(61) }, { name: 'ok', target: 0 }, { name: 'ok', target: 21 },
      { name: 'ok', color: 'red' }, { name: 'ok', schedule: '89' }, { name: 'ok', reminder_time: '25:00' },
    ];
    for (const body of bad) {
      const res = await call('post', '/api/habits', u.token, body);
      expect(res.statusCode).toBe(400);
      expect(res.body.code).toBe('INVALID_HABIT');
    }
  });
  it('isolates data between users', async () => {
    const a = await signup('isolate_a');
    const b = await signup('isolate_b');
    const habit = (await call('post', '/api/habits', a.token, { name: 'Private' })).body.habit;
    expect((await call('get', `/api/habits?${q}`, b.token)).body).toHaveLength(0);
    expect((await call('put', `/api/habits/${habit.id}`, b.token, { name: 'Hacked' })).statusCode).toBe(404);
    expect((await call('delete', `/api/habits/${habit.id}`, b.token)).statusCode).toBe(404);
    expect((await call('put', `/api/habits/${habit.id}/logs/${today}?${q}`, b.token, { count: 1 })).statusCode).toBe(404);
    expect((await call('get', `/api/habits/${habit.id}/logs`, b.token)).statusCode).toBe(404);
    expect((await call('get', `/habits/${a.id}`, b.token)).statusCode).toBe(403);
    expect((await call('post', `/habits/${habit.id}/complete`, b.token, {})).statusCode).toBe(404);
  });
});

describe('Check-ins, streaks and statistics', () => {
  it('records counts, computes streaks and rejects bad input', async () => {
    const u = await signup('streaker');
    const habit = (await call('post', `/api/habits?${q}`, u.token, { name: 'Run', target: 2 })).body.habit;
    const put = (date, count) => call('put', `/api/habits/${habit.id}/logs/${date}?${q}`, u.token, { count });

    let res = await put(today, 1);
    expect(res.body.habit.today_count).toBe(1);
    expect(res.body.habit.streak).toBe(0); // 1 of 2 - not complete yet
    res = await put(today, 2);
    expect(res.body.habit.streak).toBe(1);
    res = await put(L.addDays(today, -1), 2);
    res = await put(L.addDays(today, -2), 5); // more than the target still counts
    expect(res.body.habit.streak).toBe(3);
    res = await put(L.addDays(today, -4), 2); // gap on day -3
    expect(res.body.habit.streak).toBe(3);
    expect(res.body.habit.best_streak).toBe(3);
    res = await put(L.addDays(today, -1), 0); // undo -> breaks the run
    expect(res.body.habit.streak).toBe(1);

    expect((await put(L.addDays(today, 1), 1)).statusCode).toBe(400); // future
    expect((await put('2020-13-45', 1)).statusCode).toBe(400);
    expect((await put(today, -1)).statusCode).toBe(400);
    expect((await put(today, 1.5)).statusCode).toBe(400);
    expect((await put(today, 1000)).statusCode).toBe(400);
    expect((await call('put', `/api/habits/${habit.id}/logs/2030-01-01?today=2030-01-01`, u.token, { count: 1 })).statusCode).toBe(400); // fake "today" is ignored

    res = await call('get', `/api/habits/${habit.id}/logs`, u.token);
    expect(res.body).toHaveLength(3); // today, -2, -4
  });
  it('builds statistics', async () => {
    const u = await signup('statsuser');
    const habit = (await call('post', `/api/habits?${q}`, u.token, { name: 'Meditate' })).body.habit;
    await call('put', `/api/habits/${habit.id}/logs/${today}?${q}`, u.token, { count: 1 });
    const res = await call('get', `/api/stats?${q}`, u.token);
    expect(res.statusCode).toBe(200);
    expect(res.body.today_done).toBe(1);
    expect(res.body.today_total).toBe(1);
    expect(res.body.total_checkins).toBe(1);
    expect(res.body.current_streak).toBe(1);
    expect(res.body.weekly).toHaveLength(7);
    expect(res.body.heatmap).toHaveLength(112);
    expect(res.body.habits).toHaveLength(1);
  });
  it('exports JSON and CSV (with formula-injection protection)', async () => {
    const u = await signup('exporter');
    const habit = (await call('post', '/api/habits', u.token, { name: '=SUM(A1)' })).body.habit;
    await call('put', `/api/habits/${habit.id}/logs/${today}?${q}`, u.token, { count: 1 });
    const json = await call('get', '/api/export', u.token);
    expect(json.body.habits[0].logs).toHaveLength(1);
    const csv = await call('get', '/api/export.csv', u.token);
    expect(csv.statusCode).toBe(200);
    expect(csv.text).toContain("'=SUM(A1)");
    expect(csv.headers['content-type']).toContain('text/csv');
  });
});

describe('Legacy v1 endpoints (kept, now authenticated)', () => {
  it('still supports add / complete / list / logs', async () => {
    const u = await signup('legacyuser');
    expect((await call('post', '/habits', null, { user_id: u.id, name: 'x' })).statusCode).toBe(401);
    let res = await call('post', '/habits', u.token, { user_id: 9999, name: 'Legacy', description: 'd', target: '2' });
    expect(res.statusCode).toBe(201);
    const id = res.body.id;
    res = await call('post', `/habits/${id}/complete`, u.token, { user_id: u.id, date: today });
    expect(res.statusCode).toBe(200);
    expect(res.text).toBe('Habit marked as completed');
    await call('post', `/habits/${id}/complete`, u.token, { date: today });
    res = await call('get', `/habits/${u.id}?${q}`, u.token);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].user_id).toBeUndefined();
    expect(res.body[0].today_count).toBe(2);
    expect(res.body[0].streak).toBe(1);
    res = await call('get', `/habits/${id}/logs`, u.token);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].count).toBe(2);
  });
});
