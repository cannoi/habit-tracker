const L = require('../src/logic');
const { rateLimit } = require('../src/security');

describe('dates', () => {
  it('validates and computes dates across month, year and leap boundaries', () => {
    expect(L.isValidDate('2024-02-29')).toBe(true);
    expect(L.isValidDate('2023-02-29')).toBe(false);
    expect(L.isValidDate('2024-2-9')).toBe(false);
    expect(L.isValidDate(20240101)).toBe(false);
    expect(L.addDays('2024-02-28', 2)).toBe('2024-03-01');
    expect(L.addDays('2025-01-01', -1)).toBe('2024-12-31');
    expect(L.diffDays('2024-01-01', '2024-03-01')).toBe(60);
    expect(L.isoWeekday('2026-09-28')).toBe(1); // Monday
    expect(L.isoWeekday('2026-09-27')).toBe(7); // Sunday
  });
});

describe('streaks', () => {
  const base = { schedule: '1234567', target: 1 };
  it('is zero without logs', () => {
    expect(L.computeStreaks({ ...base, counts: {}, today: '2026-09-28' })).toEqual({ current: 0, best: 0 });
  });
  it('keeps the streak alive while today is still open', () => {
    const counts = { '2026-09-26': 1, '2026-09-27': 1 };
    expect(L.computeStreaks({ ...base, counts, today: '2026-09-28' })).toEqual({ current: 2, best: 2 });
  });
  it('breaks after a missed past day', () => {
    const counts = { '2026-09-24': 1, '2026-09-25': 1, '2026-09-27': 1 };
    expect(L.computeStreaks({ ...base, counts, today: '2026-09-28' })).toEqual({ current: 1, best: 2 });
    expect(L.computeStreaks({ ...base, counts: { '2026-09-25': 1 }, today: '2026-09-28' }).current).toBe(0);
  });
  it('honours the target (partial days do not count)', () => {
    const counts = { '2026-09-27': 1, '2026-09-28': 3 };
    expect(L.computeStreaks({ schedule: '1234567', target: 3, counts, today: '2026-09-28' })).toEqual({ current: 1, best: 1 });
  });
  it('skips unscheduled days (weekdays only: Fri + Mon stays one streak)', () => {
    // 2026-09-25 is Friday, 2026-09-28 is Monday
    const counts = { '2026-09-25': 1, '2026-09-28': 1 };
    expect(L.computeStreaks({ schedule: '12345', target: 1, counts, today: '2026-09-28' })).toEqual({ current: 2, best: 2 });
  });
});

describe('validation helpers', () => {
  it('normalises schedule and target', () => {
    expect(L.normSchedule('5311')).toBe('135');
    expect(L.normSchedule(null)).toBe('1234567');
    expect(L.normTarget('3')).toBe(3);
    expect(L.normTarget(null)).toBe(1);
    expect(L.normTarget(500)).toBe(20);
  });
  it('validates habit input, full and partial', () => {
    expect(L.validateHabitInput({ name: 'A' }).value.target).toBe(1);
    expect(L.validateHabitInput({}, { partial: true }).value).toEqual({});
    expect(L.validateHabitInput({ target: 0 }, { partial: true }).error.field).toBe('target');
    expect(L.validateHabitInput({ name: 'A', icon: '<b>' }).error.field).toBe('icon');
  });
  it('validates account fields', () => {
    expect(L.validUsername('good_name-1.x')).toBe(true);
    expect(L.validUsername('a b')).toBe(false);
    expect(L.validPassword('12345678')).toBe(true);
    expect(L.validPassword('1234567')).toBe(false);
    expect(L.validPassword('x'.repeat(73))).toBe(false);
    expect(L.validEmail('a@b.co')).toBe(true);
    expect(L.validEmail('a@b')).toBe(false);
  });
  it('escapes CSV cells', () => {
    expect(L.csvCell('a,b')).toBe('"a,b"');
    expect(L.csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(L.csvCell('=1+1')).toBe("'=1+1");
  });
});

describe('rate limiter', () => {
  it('blocks after the limit and sets Retry-After', () => {
    const mw = rateLimit({ windowMs: 60000, max: 2 });
    const mk = () => {
      const res = { headers: {}, code: 200, set(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json() { return this; } };
      return res;
    };
    let passed = 0;
    for (let i = 0; i < 3; i++) {
      const res = mk();
      mw({ ip: '1.2.3.4' }, res, () => { passed++; });
      if (i === 2) { expect(res.code).toBe(429); expect(res.headers['Retry-After']).toBeTruthy(); }
    }
    expect(passed).toBe(2);
    let other = 0;
    mw({ ip: '9.9.9.9' }, mk(), () => { other++; });
    expect(other).toBe(1); // a different client is not affected
  });
});
