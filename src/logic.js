'use strict';
// Pure, dependency-free business logic: dates, validation, streaks and statistics.

const DAY_MS = 86400000;
const DEFAULT_COLOR = '#4f46e5';
const DEFAULT_ICON = '🎯';
const ALL_DAYS = '1234567'; // ISO weekdays: 1 = Monday ... 7 = Sunday
const MAX_TARGET = 20;
const MAX_LOG_COUNT = 99;
const HEATMAP_DAYS = 112; // 16 weeks

/* ---------- dates (all values are 'YYYY-MM-DD' strings, DST-safe via UTC math) ---------- */
function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
const toMs = s => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
const addDays = (s, n) => new Date(toMs(s) + n * DAY_MS).toISOString().slice(0, 10);
const diffDays = (a, b) => Math.round((toMs(b) - toMs(a)) / DAY_MS); // b - a
const isoWeekday = s => { const d = new Date(toMs(s)).getUTCDay(); return d === 0 ? 7 : d; };
const isScheduled = (schedule, date) => schedule.includes(String(isoWeekday(date)));
const todayUTC = () => new Date().toISOString().slice(0, 10);

/* ---------- normalisation & validation ---------- */
function normTarget(t) {
  const n = parseInt(t, 10);
  return Number.isFinite(n) && n >= 1 ? Math.min(n, MAX_TARGET) : 1;
}
function normSchedule(s) {
  const str = typeof s === 'string' ? s : '';
  const days = [...new Set(str.split('').filter(c => /[1-7]/.test(c)))].sort().join('');
  return days || ALL_DAYS;
}
function parseSchedule(v) {
  const raw = Array.isArray(v) ? v.join('') : v;
  if (typeof raw !== 'string' || !/^[1-7]+$/.test(raw)) return null;
  return [...new Set(raw.split(''))].sort().join('');
}

/** Validate habit input. With partial=true only supplied fields are checked. Returns {value} or {error}. */
function validateHabitInput(body, { partial = false } = {}) {
  const b = body && typeof body === 'object' ? body : {};
  const out = {};
  const bad = (field, msg) => ({ error: { field, message: msg } });
  const has = k => b[k] !== undefined;

  if (!partial || has('name')) {
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    if (!name) return bad('name', 'Name is required');
    if ([...name].length > 60) return bad('name', 'Name must be at most 60 characters');
    out.name = name;
  }
  if (!partial || has('description')) {
    const d = b.description == null ? '' : b.description;
    if (typeof d !== 'string') return bad('description', 'Invalid description');
    if ([...d.trim()].length > 200) return bad('description', 'Description must be at most 200 characters');
    out.description = d.trim();
  }
  if (!partial || has('target')) {
    const raw = b.target === undefined || b.target === null || b.target === '' ? 1 : b.target;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > MAX_TARGET) return bad('target', `Target must be a whole number from 1 to ${MAX_TARGET}`);
    out.target = n;
  }
  if (!partial || has('color')) {
    const c = b.color == null || b.color === '' ? DEFAULT_COLOR : b.color;
    if (typeof c !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(c)) return bad('color', 'Invalid color');
    out.color = c.toLowerCase();
  }
  if (!partial || has('icon')) {
    const i = b.icon == null || b.icon === '' ? DEFAULT_ICON : b.icon;
    if (typeof i !== 'string' || [...i].length > 4 || /[<>&"']/.test(i)) return bad('icon', 'Invalid icon');
    out.icon = i;
  }
  if (!partial || has('schedule')) {
    const s = b.schedule == null || b.schedule === '' ? ALL_DAYS : parseSchedule(b.schedule);
    if (!s) return bad('schedule', 'Choose at least one day of the week');
    out.schedule = s;
  }
  if (!partial || has('reminder_time')) {
    const r = b.reminder_time;
    if (r == null || r === '') out.reminder_time = null;
    else if (typeof r === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(r)) out.reminder_time = r;
    else return bad('reminder_time', 'Reminder time must be HH:MM');
  }
  return { value: out };
}

/* ---------- streaks & rates ---------- */
/** counts: { 'YYYY-MM-DD': number }. A day is "done" when count >= target. Unscheduled days are neutral. */
function computeStreaks({ schedule, target, counts, today }) {
  const done = Object.keys(counts).filter(d => counts[d] >= target).sort();
  if (!done.length) return { current: 0, best: 0 };
  const last = done[done.length - 1];
  const end = today > last ? today : last;
  let run = 0;
  let best = 0;
  for (let d = done[0]; d <= end; d = addDays(d, 1)) {
    if (!isScheduled(schedule, d)) continue;
    if (counts[d] >= target) {
      run += 1;
      if (run > best) best = run;
    } else if (d !== today) {
      run = 0; // a missed past day breaks the streak; today is still open
    }
  }
  return { current: run, best };
}

function habitStart(habit, counts) {
  const created = typeof habit.created_at === 'string' ? habit.created_at.slice(0, 10) : '';
  const first = Object.keys(counts).sort()[0];
  const cands = [created, first].filter(isValidDate).sort();
  return cands[0] || null;
}

function periodStats(habit, counts, from, to) {
  const start = habitStart(habit, counts);
  let d = start && start > from ? start : from;
  let total = 0;
  let done = 0;
  for (; d <= to; d = addDays(d, 1)) {
    if (!isScheduled(habit.schedule, d)) continue;
    total += 1;
    if ((counts[d] || 0) >= habit.target) done += 1;
  }
  return { done, total };
}
const pct = ({ done, total }) => (total ? Math.round((100 * done) / total) : 0);

/* ---------- views sent to the client ---------- */
function buildHabitView(row, counts, today) {
  const target = normTarget(row.target);
  const schedule = normSchedule(row.schedule);
  const h = { target, schedule, created_at: row.created_at };
  const { current, best } = computeStreaks({ schedule, target, counts, today });
  const recent = [];
  for (let i = 13; i >= 0; i -= 1) {
    const date = addDays(today, -i);
    recent.push({ date, count: counts[date] || 0, scheduled: isScheduled(schedule, date) });
  }
  const dates = Object.keys(counts);
  return {
    id: row.id,
    name: row.name,
    description: row.description || '',
    target,
    color: row.color || DEFAULT_COLOR,
    icon: row.icon || DEFAULT_ICON,
    schedule,
    reminder_time: row.reminder_time || null,
    archived: row.archived ? 1 : 0,
    streak: current,
    best_streak: Math.max(best, current),
    created_at: row.created_at,
    updated_at: row.updated_at,
    today_count: counts[today] || 0,
    recent,
    rate7: pct(periodStats(h, counts, addDays(today, -6), today)),
    rate30: pct(periodStats(h, counts, addDays(today, -29), today)),
    total_days: dates.filter(d => counts[d] >= target).length,
    total_checkins: dates.reduce((s, d) => s + counts[d], 0),
  };
}

function buildStats(habitRows, logsByHabit, today) {
  const items = habitRows.map(row => {
    const counts = logsByHabit[row.id] || {};
    const view = buildHabitView(row, counts, today);
    return { view, counts, h: { target: view.target, schedule: view.schedule, created_at: row.created_at } };
  });

  let todayDone = 0, todayTotal = 0;
  const agg7 = { done: 0, total: 0 };
  const agg30 = { done: 0, total: 0 };
  let totalCheckins = 0;
  for (const { view, counts, h } of items) {
    if (isScheduled(view.schedule, today)) {
      todayTotal += 1;
      if ((counts[today] || 0) >= view.target) todayDone += 1;
    }
    const s7 = periodStats(h, counts, addDays(today, -6), today);
    const s30 = periodStats(h, counts, addDays(today, -29), today);
    agg7.done += s7.done; agg7.total += s7.total;
    agg30.done += s30.done; agg30.total += s30.total;
    totalCheckins += view.total_checkins;
  }

  const dayStat = date => {
    let done = 0, total = 0;
    for (const { counts, h } of items) {
      const start = habitStart(h, counts);
      if (start && start > date) continue;
      if (!isScheduled(h.schedule, date)) continue;
      total += 1;
      if ((counts[date] || 0) >= h.target) done += 1;
    }
    return { date, done, total };
  };
  const weekly = [];
  for (let i = 6; i >= 0; i -= 1) weekly.push(dayStat(addDays(today, -i)));
  const heatmap = [];
  for (let i = HEATMAP_DAYS - 1; i >= 0; i -= 1) heatmap.push(dayStat(addDays(today, -i)));

  return {
    today,
    habits_count: items.length,
    today_done: todayDone,
    today_total: todayTotal,
    rate7: pct(agg7),
    rate30: pct(agg30),
    total_checkins: totalCheckins,
    best_streak: items.reduce((m, i) => Math.max(m, i.view.best_streak), 0),
    current_streak: items.reduce((m, i) => Math.max(m, i.view.streak), 0),
    weekly,
    heatmap,
    habits: items.map(({ view }) => ({
      id: view.id, name: view.name, icon: view.icon, color: view.color,
      current: view.streak, best: view.best_streak, rate30: view.rate30, total_days: view.total_days,
    })),
  };
}

/* ---------- misc ---------- */
const USERNAME_RE = /^[A-Za-z0-9_.-]{3,32}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const validUsername = u => typeof u === 'string' && USERNAME_RE.test(u.trim());
const validEmail = e => typeof e === 'string' && e.length <= 254 && EMAIL_RE.test(e);
const validPassword = p => typeof p === 'string' && p.length >= 8 && Buffer.byteLength(p) <= 72; // bcrypt limit

function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // neutralise spreadsheet formula injection
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

module.exports = {
  DEFAULT_COLOR, DEFAULT_ICON, ALL_DAYS, MAX_LOG_COUNT,
  isValidDate, addDays, diffDays, isoWeekday, isScheduled, todayUTC,
  normTarget, normSchedule, validateHabitInput,
  computeStreaks, periodStats, buildHabitView, buildStats,
  validUsername, validEmail, validPassword, csvCell,
};
