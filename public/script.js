/* Habit Tracker front-end. No innerHTML anywhere: every node is built with h() so user text can never become markup. */
(function () {
  'use strict';

  /* ---------- tiny helpers ---------- */
  const $ = sel => document.querySelector(sel);
  const view = $('#view');
  const dialog = $('#dialog');
  const toasts = $('#toasts');

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* private mode */ } },
    del(k) { try { localStorage.removeItem(k); } catch (_) { /* ignore */ } },
  };

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === false || v == null) continue;
        if (k === 'class') el.className = v;
        else if (k === 'style') for (const [p, val] of Object.entries(v)) el.style.setProperty(p, val);
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
        else if (v === true) el.setAttribute(k, '');
        else el.setAttribute(k, String(v));
      }
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      el.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  /* ---------- dates (local calendar days as YYYY-MM-DD) ---------- */
  const pad = n => String(n).padStart(2, '0');
  const localDate = (d = new Date()) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const parseDate = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const addDays = (s, n) => { const d = parseDate(s); d.setDate(d.getDate() + n); return localDate(d); };
  const isoWeekday = s => { const d = parseDate(s).getDay(); return d === 0 ? 7 : d; };

  /* ---------- state ---------- */
  const savedLang = store.get('ht_lang');
  const state = {
    token: store.get('ht_token'),
    user: null,
    habits: [],
    archived: [],
    stats: null,
    statsLoading: false,
    tab: 'today',
    dayOffset: 0,
    showArchived: false,
    today: localDate(),
    authMode: 'login',
    lang: savedLang && window.I18N[savedLang] ? savedLang : ((navigator.language || '').toLowerCase().startsWith('vi') ? 'vi' : 'en'),
    theme: store.get('ht_theme') || 'auto',
    installEvent: null,
  };

  function t(key, vars) {
    let s = window.I18N[state.lang][key];
    if (s === undefined) s = window.I18N.en[key];
    if (s === undefined) return key;
    if (typeof s === 'string' && vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? vars[k] : m));
    return s;
  }
  const fmtDate = (s, opts) => parseDate(s).toLocaleDateString(state.lang === 'vi' ? 'vi-VN' : 'en-US', opts);

  /* ---------- API ---------- */
  class ApiError extends Error {
    constructor(status, code, message) { super(message || code); this.status = status; this.code = code; }
  }

  async function api(path, opts = {}) {
    const headers = {};
    if (state.token) headers.Authorization = 'Bearer ' + state.token;
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    let res;
    try {
      res = await fetch(path, {
        method: opts.method || 'GET',
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
    } catch (_) {
      throw new ApiError(0, 'NETWORK');
    }
    if (res.ok && opts.blob) return res.blob();
    const text = await res.text();
    let data = null;
    if (text) { try { data = JSON.parse(text); } catch (_) { data = text; } }
    if (!res.ok) {
      const code = (data && data.code) || (res.status >= 500 ? 'SERVER_ERROR' : 'GENERIC');
      const err = new ApiError(res.status, code, data && data.error);
      if (state.token && (code === 'UNAUTHORIZED' || code === 'INVALID_TOKEN')) logout(true);
      throw err;
    }
    return data;
  }

  function errMsg(err) {
    if (!(err instanceof ApiError)) return t('err.GENERIC');
    const key = 'err.' + err.code;
    const s = t(key);
    if (s !== key) return s;
    return err.code === 'INVALID_HABIT' && err.message ? err.message : t('err.GENERIC');
  }

  function toast(msg, kind) {
    const el = h('div', { class: 'toast' + (kind === 'error' ? ' error' : '') }, msg);
    toasts.append(el);
    setTimeout(() => el.remove(), 3500);
  }

  /* ---------- modal dialogs ---------- */
  function modal(build) {
    return new Promise(resolve => {
      const onClose = () => resolve(null);
      const done = v => {
        dialog.removeEventListener('close', onClose);
        if (dialog.open) dialog.close();
        resolve(v);
      };
      dialog.replaceChildren(build(done));
      dialog.addEventListener('close', onClose, { once: true });
      if (typeof dialog.showModal === 'function') { if (!dialog.open) dialog.showModal(); } else dialog.setAttribute('open', '');
    });
  }
  dialog.addEventListener('click', e => { if (e.target === dialog && dialog.open) dialog.close(); }); // click on backdrop

  const confirmBox = (message, confirmLabel) => modal(done => h('div', null,
    h('p', null, message),
    h('div', { class: 'dialog-actions' },
      h('button', { class: 'btn-secondary', type: 'button', onClick: () => done(false) }, t('dlg.cancel')),
      h('button', { class: 'btn-danger', type: 'button', onClick: () => done(true) }, confirmLabel || t('dlg.confirm'))))
  ).then(v => v === true);

  /* ---------- theme / language ---------- */
  function applyTheme() {
    const root = document.documentElement;
    if (state.theme === 'light' || state.theme === 'dark') root.setAttribute('data-theme', state.theme);
    else root.removeAttribute('data-theme');
  }
  function setLang(l) {
    state.lang = l;
    store.set('ht_lang', l);
    document.documentElement.lang = l;
    renderHeader();
    if (state.token && state.user) renderApp(); else renderAuth();
  }
  function renderHeader() {
    const hdr = $('.app-header');
    let box = $('#header-actions');
    if (!box) { box = h('div', { id: 'header-actions', class: 'row' }); hdr.append(box); }
    box.replaceChildren(h('button', {
      class: 'btn-ghost', type: 'button', title: t('settings.language'), 'aria-label': t('settings.language'),
      onClick: () => setLang(state.lang === 'vi' ? 'en' : 'vi'),
    }, '🌐 ' + state.lang.toUpperCase()));
  }

  /* ---------- session ---------- */
  function logout(expired) {
    state.token = null; state.user = null; state.habits = []; state.archived = []; state.stats = null;
    store.del('ht_token');
    stopReminders();
    if (dialog.open) dialog.close();
    renderAuth();
    if (expired) toast(t('err.UNAUTHORIZED'), 'error');
  }

  async function doLogin(username, password) {
    const data = await api('/login', { method: 'POST', body: { username, password } });
    state.token = data.token;
    store.set('ht_token', data.token);
    state.user = await api('/api/me');
    state.today = localDate();
    await loadHabits();
    enterApp();
  }

  async function loadHabits() {
    state.habits = await api('/api/habits?today=' + state.today);
    if (state.showArchived) state.archived = await api('/api/habits?archived=1&today=' + state.today);
  }

  /* ---------- auth screen ---------- */
  function renderAuth() {
    document.body.classList.remove('in-app');
    const mode = state.authMode;
    const err = h('p', { class: 'form-error', role: 'alert' });
    const username = h('input', { type: 'text', id: 'auth-username', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false', maxlength: 32, required: true });
    const password = h('input', { type: 'password', id: 'auth-password', autocomplete: mode === 'register' ? 'new-password' : 'current-password', maxlength: 72, required: true });
    const email = mode === 'register' ? h('input', { type: 'email', id: 'auth-email', autocomplete: 'email', maxlength: 254 }) : null;
    const submit = h('button', { type: 'submit', class: 'btn-block' }, mode === 'register' ? t('auth.register') : t('auth.login'));

    const form = h('form', {
      class: 'auth-card', novalidate: true,
      onSubmit: async e => {
        e.preventDefault();
        err.textContent = '';
        const u = username.value.trim();
        const p = password.value;
        if (!u || !p) { err.textContent = t('err.INVALID_INPUT'); return; }
        submit.disabled = true;
        try {
          if (mode === 'register') {
            await api('/register', { method: 'POST', body: { username: u, password: p, email: email.value.trim() } });
          }
          await doLogin(u, p);
          if (mode === 'register') toast(t('auth.registered'));
        } catch (ex) {
          err.textContent = errMsg(ex);
        } finally {
          submit.disabled = false;
        }
      },
    },
    h('p', { class: 'tagline' }, t('tagline')),
    h('label', { class: 'field', for: 'auth-username' }, t('auth.username'), username),
    h('label', { class: 'field', for: 'auth-password' }, t('auth.password'), password),
    email && h('label', { class: 'field', for: 'auth-email' }, t('auth.email'), email),
    mode === 'register' && h('p', { class: 'muted' }, t('auth.hintRegister')),
    err,
    submit,
    h('button', {
      type: 'button', class: 'link-btn',
      onClick: () => { state.authMode = mode === 'login' ? 'register' : 'login'; renderAuth(); },
    }, mode === 'login' ? t('auth.toRegister') : t('auth.toLogin')));

    view.replaceChildren(form);
    username.focus();
  }

  function renderOffline() {
    view.replaceChildren(h('div', { class: 'empty' },
      h('span', { class: 'big' }, '📡'), t('err.NETWORK'),
      h('p', null, h('button', { type: 'button', onClick: boot }, '↻'))));
  }

  /* ---------- app shell ---------- */
  const TABS = ['today', 'habits', 'stats', 'settings'];

  function enterApp() {
    document.body.classList.add('in-app');
    state.tab = 'today';
    state.dayOffset = 0;
    renderApp();
    startReminders();
  }

  function switchTab(tab) {
    state.tab = tab;
    if (tab === 'habits' && state.showArchived) loadHabits().then(renderApp).catch(() => {});
    renderApp();
  }

  function renderApp() {
    if (!state.user) return;
    const panel = { today: viewToday, habits: viewHabits, stats: viewStats, settings: viewSettings }[state.tab]();
    view.replaceChildren(
      h('nav', { class: 'tabs', role: 'tablist' }, TABS.map(k => h('button', {
        class: 'tab', role: 'tab', type: 'button', 'aria-selected': String(state.tab === k), onClick: () => switchTab(k),
      }, t('nav.' + k)))),
      panel);
  }

  function replaceHabit(v) {
    state.stats = null;
    const list = v.archived ? state.archived : state.habits;
    const other = v.archived ? state.habits : state.archived;
    const oi = other.findIndex(x => x.id === v.id);
    if (oi >= 0) other.splice(oi, 1);
    const i = list.findIndex(x => x.id === v.id);
    if (i >= 0) list[i] = v; else list.push(v);
  }

  /* ---------- TODAY ---------- */
  const busy = new Set();
  async function setCount(hb, date, count) {
    const key = hb.id + date;
    if (busy.has(key)) return;
    busy.add(key);
    try {
      const res = await api(`/api/habits/${hb.id}/logs/${date}?today=${state.today}`, { method: 'PUT', body: { count } });
      replaceHabit(res.habit);
      renderApp();
    } catch (e) {
      toast(errMsg(e), 'error');
    } finally {
      busy.delete(key);
    }
  }

  function weekStrip(hb) {
    return h('div', { class: 'week', 'aria-hidden': 'true' }, hb.recent.slice(-7).map(r => {
      const cls = !r.scheduled ? 'off' : r.count >= hb.target ? 'full' : r.count > 0 ? 'part' : '';
      return h('div', { class: 'd' }, h('span', { class: 'dot ' + cls, title: r.date }), t('days.letter')[isoWeekday(r.date) - 1]);
    }));
  }

  function habitCard(hb, day, date) {
    const cnt = day.count;
    const isDone = cnt >= hb.target;
    let control;
    if (hb.target === 1) {
      control = h('button', {
        class: 'check-btn', type: 'button', 'aria-pressed': String(isDone),
        'aria-label': (isDone ? t('today.uncheck') : t('today.check')) + ': ' + hb.name,
        onClick: () => setCount(hb, date, isDone ? 0 : 1),
      }, '✓');
    } else {
      control = h('div', { class: 'counter' },
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': t('today.minus'), disabled: cnt <= 0, onClick: () => setCount(hb, date, Math.max(0, cnt - 1)) }, '−'),
        h('output', null, cnt + '/' + hb.target),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': t('today.plus'), disabled: cnt >= 99, onClick: () => setCount(hb, date, cnt + 1) }, '+'));
    }
    return h('li', { class: 'habit-item', style: { '--hc': hb.color } },
      h('div', { class: 'habit-row' },
        h('span', { class: 'habit-icon', 'aria-hidden': 'true' }, hb.icon),
        h('div', { class: 'habit-main' },
          h('div', { class: 'habit-header' },
            h('span', { class: 'habit-title' }, hb.name),
            h('span', { class: 'habit-streak' }, '🔥 ' + t('today.streak', { n: hb.streak }))),
          hb.description && h('div', { class: 'habit-desc' }, hb.description)),
        control),
      hb.target > 1 && h('div', { class: 'bar' }, h('i', { style: { width: Math.min(100, Math.round(100 * cnt / hb.target)) + '%' } })),
      weekStrip(hb));
  }

  function shareProgress() {
    const day = state.habits.map(hb => ({ hb, d: hb.recent[hb.recent.length - 1] })).filter(x => x.d && x.d.scheduled);
    const done = day.filter(x => x.d.count >= x.hb.target).length;
    const streak = state.habits.reduce((m, hb) => Math.max(m, hb.streak), 0);
    const text = t('share.text', { done, total: day.length, streak });
    if (navigator.share) {
      navigator.share({ title: 'Habit Tracker', text }).catch(() => {});
    } else if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(() => toast(t('share.copied')), () => toast(text));
    } else {
      toast(text);
    }
  }

  function viewToday() {
    const date = addDays(state.today, -state.dayOffset);
    const off = state.dayOffset;
    const title = off === 0 ? t('today.title') : off === 1 ? t('today.yesterday') : fmtDate(date, { weekday: 'long' });
    const root = h('div');

    root.append(h('div', { class: 'day-nav' },
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': t('today.prev'), disabled: off >= 13, onClick: () => { state.dayOffset++; renderApp(); } }, '‹'),
      h('h2', null, title, h('div', { class: 'muted' }, fmtDate(date, { day: 'numeric', month: 'long', year: 'numeric' }))),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': t('today.next'), disabled: off <= 0, onClick: () => { state.dayOffset--; renderApp(); } }, '›')));

    if (!state.habits.length) {
      root.append(h('div', { class: 'empty' }, h('span', { class: 'big' }, '🌱'), t('today.empty'),
        h('p', null, h('button', { type: 'button', onClick: () => { state.tab = 'habits'; renderApp(); openHabitForm(); } }, t('habits.new')))));
      return root;
    }

    const entries = state.habits.map(hb => ({ hb, day: hb.recent.find(r => r.date === date) })).filter(x => x.day);
    const scheduled = entries.filter(x => x.day.scheduled);
    const done = scheduled.filter(x => x.day.count >= x.hb.target).length;
    const pct = scheduled.length ? Math.round(100 * done / scheduled.length) : 0;

    root.append(h('div', { class: 'progress-card' },
      h('div', { class: 'ring', style: { '--p': pct } }, h('span', null, pct + '%')),
      h('div', null, h('strong', null, t('today.progress', { done, total: scheduled.length })),
        off > 0 && h('div', null, h('button', { class: 'btn-ghost', type: 'button', onClick: () => { state.dayOffset = 0; renderApp(); } }, t('today.backToToday'))))));

    if (scheduled.length && done === scheduled.length) root.append(h('p', { class: 'success-note' }, t('today.allDone')));
    if (!scheduled.length) root.append(h('p', { class: 'empty' }, t('today.noneScheduled')));

    root.append(h('ul', { id: 'habits' }, scheduled.map(x => habitCard(x.hb, x.day, date))));
    const rest = entries.length - scheduled.length;
    if (rest > 0) root.append(h('p', { class: 'muted center' }, t('today.rest', { n: rest })));
    root.append(h('p', { class: 'center' }, h('button', { class: 'btn-secondary', type: 'button', onClick: shareProgress }, '📤 ' + t('today.share'))));
    return root;
  }

  /* ---------- HABITS (manage) ---------- */
  const COLORS = ['#4f46e5', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#8b5cf6', '#64748b'];
  const EMOJIS = ['🎯', '💧', '📚', '🏃', '🧘', '💪', '🍎', '😴', '✍️', '💊', '🧹', '🎸', '☀️', '🚴'];

  function scheduleLabel(sch) {
    if (sch === '1234567') return t('habits.everyDay');
    return sch.split('').map(d => t('days.short')[Number(d) - 1]).join(' · ');
  }

  async function archiveHabit(hb, archived) {
    try {
      const res = await api(`/api/habits/${hb.id}/archive?today=${state.today}`, { method: 'POST', body: { archived } });
      replaceHabit(res.habit);
      toast(t(archived ? 'habits.archived' : 'habits.restored'));
      renderApp();
    } catch (e) { toast(errMsg(e), 'error'); }
  }

  async function deleteHabit(hb) {
    if (!(await confirmBox(t('habits.confirmDelete', { name: hb.name }), t('habits.delete')))) return;
    try {
      await api('/api/habits/' + hb.id, { method: 'DELETE' });
      state.habits = state.habits.filter(x => x.id !== hb.id);
      state.archived = state.archived.filter(x => x.id !== hb.id);
      state.stats = null;
      toast(t('habits.deleted'));
      renderApp();
    } catch (e) { toast(errMsg(e), 'error'); }
  }

  async function showHistory(hb) {
    const list = h('ul', { id: 'logs', class: 'log-list' }, h('li', null, '…'));
    const p = modal(done => h('div', null,
      h('h2', null, t('history.title', { name: hb.name })), list,
      h('div', { class: 'dialog-actions' }, h('button', { class: 'btn-secondary', type: 'button', onClick: () => done(true) }, t('history.close')))));
    try {
      const logs = await api(`/api/habits/${hb.id}/logs?limit=90`);
      list.replaceChildren(...(logs.length ? logs.map(l => h('li', null,
        h('span', null, fmtDate(l.date, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })),
        h('strong', null, (l.count >= hb.target ? '✓ ' : '') + l.count + '/' + hb.target)))
        : [h('li', null, t('history.empty'))]));
    } catch (e) { list.replaceChildren(h('li', null, errMsg(e))); }
    return p;
  }

  function habitManageCard(hb) {
    return h('li', { class: 'habit-item', style: { '--hc': hb.color } },
      h('div', { class: 'habit-row' },
        h('span', { class: 'habit-icon', 'aria-hidden': 'true' }, hb.icon),
        h('div', { class: 'habit-main' },
          h('span', { class: 'habit-title' }, hb.name),
          hb.description && h('div', { class: 'habit-desc' }, hb.description))),
      h('div', { class: 'meta' },
        h('span', { class: 'chip' }, t('habits.perDay', { n: hb.target })),
        h('span', { class: 'chip' }, scheduleLabel(hb.schedule)),
        hb.reminder_time && h('span', { class: 'chip' }, t('habits.remindAt', { t: hb.reminder_time })),
        h('span', { class: 'habit-streak' }, '🔥 ' + t('today.streak', { n: hb.streak })),
        h('span', { class: 'chip' }, t('habits.best', { n: hb.best_streak })),
        h('span', { class: 'chip' }, t('habits.rate30', { n: hb.rate30 }))),
      h('div', { class: 'actions' },
        h('button', { class: 'btn-ghost', type: 'button', onClick: () => showHistory(hb) }, t('habits.history')),
        !hb.archived && h('button', { class: 'btn-ghost', type: 'button', onClick: () => openHabitForm(hb) }, t('habits.edit')),
        h('button', { class: 'btn-ghost', type: 'button', onClick: () => archiveHabit(hb, !hb.archived) }, hb.archived ? t('habits.restore') : t('habits.archive')),
        h('button', { class: 'btn-ghost', type: 'button', style: { color: 'var(--danger)' }, onClick: () => deleteHabit(hb) }, t('habits.delete'))));
  }

  function viewHabits() {
    const root = h('div');
    root.append(h('div', { class: 'row between' },
      h('h2', { style: { margin: '0' } }, t('habits.title')),
      h('button', { type: 'button', id: 'add-habit-btn', onClick: () => openHabitForm() }, t('habits.new'))));
    root.append(state.habits.length
      ? h('ul', null, state.habits.map(habitManageCard))
      : h('p', { class: 'empty' }, t('habits.empty')));
    root.append(h('label', { class: 'toggle' },
      h('input', {
        type: 'checkbox', checked: state.showArchived,
        onChange: async e => {
          state.showArchived = e.target.checked;
          if (state.showArchived) { try { await loadHabits(); } catch (ex) { toast(errMsg(ex), 'error'); } }
          renderApp();
        },
      }), t('habits.showArchived')));
    if (state.showArchived) {
      root.append(state.archived.length ? h('ul', null, state.archived.map(habitManageCard)) : h('p', { class: 'muted' }, t('habits.empty')));
    }
    return root;
  }

  function openHabitForm(hb) {
    const isEdit = !!hb;
    const sel = {
      icon: hb ? hb.icon : EMOJIS[0],
      color: hb ? hb.color : COLORS[0],
      days: new Set((hb ? hb.schedule : '1234567').split('').map(Number)),
    };
    const emojis = EMOJIS.includes(sel.icon) ? EMOJIS : [sel.icon, ...EMOJIS];
    const colors = COLORS.includes(sel.color) ? COLORS : [sel.color, ...COLORS];

    const name = h('input', { type: 'text', id: 'habit-name', maxlength: 60, value: hb ? hb.name : '', placeholder: t('form.name') });
    const desc = h('input', { type: 'text', id: 'habit-description', maxlength: 200, value: hb ? hb.description : '' });
    const target = h('input', { type: 'number', id: 'habit-target', min: 1, max: 20, step: 1, value: hb ? hb.target : 1, inputmode: 'numeric' });
    const time = h('input', { type: 'time', id: 'habit-reminder', value: hb && hb.reminder_time ? hb.reminder_time : '' });
    const err = h('p', { class: 'form-error', role: 'alert' });
    const save = h('button', { type: 'submit' }, t('form.save'));

    const toggleGroup = (container, btn) => { for (const b of container.children) b.setAttribute('aria-pressed', String(b === btn)); };
    const emojiBox = h('div', { class: 'emojis' });
    emojis.forEach(em => emojiBox.append(h('button', {
      type: 'button', class: 'emoji', 'aria-pressed': String(em === sel.icon), 'aria-label': em,
      onClick: e => { sel.icon = em; toggleGroup(emojiBox, e.currentTarget); },
    }, em)));
    const colorBox = h('div', { class: 'swatches' });
    colors.forEach(c => colorBox.append(h('button', {
      type: 'button', class: 'swatch', style: { background: c }, 'aria-pressed': String(c === sel.color), 'aria-label': c,
      onClick: e => { sel.color = c; toggleGroup(colorBox, e.currentTarget); },
    })));
    const dayBox = h('div', { class: 'days' });
    for (let d = 1; d <= 7; d++) {
      dayBox.append(h('button', {
        type: 'button', class: 'day', 'aria-pressed': String(sel.days.has(d)),
        onClick: e => {
          if (sel.days.has(d)) sel.days.delete(d); else sel.days.add(d);
          e.currentTarget.setAttribute('aria-pressed', String(sel.days.has(d)));
        },
      }, t('days.short')[d - 1]));
    }

    return modal(done => h('form', {
      novalidate: true,
      onSubmit: async e => {
        e.preventDefault();
        err.textContent = '';
        if (!name.value.trim()) { err.textContent = t('form.nameRequired'); name.focus(); return; }
        if (!sel.days.size) { err.textContent = t('form.days'); return; }
        save.disabled = true;
        const body = {
          name: name.value.trim(), description: desc.value.trim(), target: Number(target.value) || 1,
          icon: sel.icon, color: sel.color, schedule: [...sel.days].sort().join(''), reminder_time: time.value || null,
        };
        try {
          const res = await api(`/api/habits${isEdit ? '/' + hb.id : ''}?today=${state.today}`, { method: isEdit ? 'PUT' : 'POST', body });
          replaceHabit(res.habit);
          toast(t(isEdit ? 'habits.saved' : 'habits.created'));
          done(true);
          renderApp();
        } catch (ex) {
          err.textContent = errMsg(ex);
          save.disabled = false;
        }
      },
    },
    h('h2', null, t(isEdit ? 'form.editTitle' : 'form.newTitle')),
    h('label', { class: 'field', for: 'habit-name' }, t('form.name'), name),
    h('label', { class: 'field', for: 'habit-description' }, t('form.description'), desc),
    h('label', { class: 'field', for: 'habit-target' }, t('form.target'), target),
    h('div', { class: 'field' }, t('form.icon'), emojiBox),
    h('div', { class: 'field' }, t('form.color'), colorBox),
    h('div', { class: 'field' }, t('form.days'), dayBox),
    h('label', { class: 'field', for: 'habit-reminder' }, t('form.reminder'), time),
    err,
    h('div', { class: 'dialog-actions' },
      h('button', { type: 'button', class: 'btn-secondary', onClick: () => done(null) }, t('form.cancel')), save)));
  }

  /* ---------- STATS ---------- */
  function viewStats() {
    const root = h('div', null, h('h2', null, t('stats.title')));
    if (!state.habits.length) { root.append(h('p', { class: 'empty' }, t('stats.empty'))); return root; }
    if (!state.stats) {
      root.append(h('p', { class: 'muted center' }, '…'));
      if (!state.statsLoading) {
        state.statsLoading = true;
        api('/api/stats?today=' + state.today)
          .then(s => { state.stats = s; })
          .catch(e => toast(errMsg(e), 'error'))
          .finally(() => { state.statsLoading = false; if (state.stats && state.tab === 'stats') renderApp(); });
      }
      return root;
    }
    const s = state.stats;
    const card = (value, label) => h('div', { class: 'stat' }, h('b', null, value), h('span', null, label));
    root.append(h('div', { class: 'cards' },
      card(s.today_done + '/' + s.today_total, t('stats.today')),
      card(s.rate7 + '%', t('stats.rate7')),
      card(s.rate30 + '%', t('stats.rate30')),
      card(s.total_checkins, t('stats.total')),
      card('🔥 ' + s.current_streak, t('stats.currentStreak')),
      card('🏆 ' + s.best_streak, t('stats.bestStreak'))));

    root.append(h('h2', null, t('stats.weekly')),
      h('div', { class: 'weekly' }, s.weekly.map(d => {
        const ratio = d.total ? d.done / d.total : 0;
        return h('div', { class: 'col' },
          h('i', { class: d.total ? '' : 'none', title: d.done + '/' + d.total, style: { height: Math.max(3, Math.round(ratio * 100)) + '%' } }),
          t('days.letter')[isoWeekday(d.date) - 1]);
      })));

    const cells = [];
    for (let i = 0; i < isoWeekday(s.heatmap[0].date) - 1; i++) cells.push(h('i', { class: 'pad' }));
    s.heatmap.forEach(d => {
      const r = d.total ? d.done / d.total : 0;
      const lv = !d.total || r === 0 ? 0 : r < 0.5 ? 1 : r < 0.8 ? 2 : r < 1 ? 3 : 4;
      cells.push(h('i', { class: lv ? 'l' + lv : '', title: fmtDate(d.date, { day: 'numeric', month: 'short' }) + ': ' + d.done + '/' + d.total }));
    });
    root.append(h('h2', null, t('stats.heatmap')), h('div', { class: 'heat' }, cells),
      h('div', { class: 'legend' }, t('stats.less'), ...[0, 1, 2, 3, 4].map(n => h('i', { class: n ? 'l' + n : '' })), t('stats.more')));

    root.append(h('h2', null, t('stats.perHabit')), h('ul', null, s.habits.map(x => h('li', { class: 'habit-item', style: { '--hc': x.color } },
      h('div', { class: 'habit-header' },
        h('span', { class: 'habit-title' }, x.icon + ' ' + x.name),
        h('span', { class: 'habit-streak' }, '🔥 ' + x.current)),
      h('div', { class: 'bar' }, h('i', { style: { width: x.rate30 + '%' } })),
      h('div', { class: 'habit-desc' }, t('habits.rate30', { n: x.rate30 }) + ' · ' + t('habits.best', { n: x.best }) + ' · ✓ ' + t('stats.days', { n: x.total_days }))))));
    return root;
  }

  /* ---------- SETTINGS ---------- */
  async function download(path, filename) {
    try {
      const blob = await api(path, { blob: true });
      const url = URL.createObjectURL(blob);
      const a = h('a', { href: url, download: filename });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (e) { toast(errMsg(e), 'error'); }
  }

  function remindersSection() {
    const box = h('div', { class: 'section' }, h('h2', null, t('settings.reminders')), h('p', { class: 'muted' }, t('settings.remindersHelp')));
    if (!('Notification' in window)) { box.append(h('p', null, t('settings.remindersUnsupported'))); return box; }
    const on = store.get('ht_remind') === '1' && Notification.permission === 'granted';
    if (Notification.permission === 'denied') { box.append(h('p', null, t('settings.remindersDenied'))); return box; }
    if (on) {
      box.append(h('p', null, '✅ ' + t('settings.remindersOn')),
        h('button', { class: 'btn-secondary', type: 'button', onClick: () => { store.set('ht_remind', '0'); renderApp(); } }, t('settings.disableReminders')));
    } else {
      box.append(h('button', {
        type: 'button',
        onClick: async () => {
          const perm = await Notification.requestPermission();
          store.set('ht_remind', perm === 'granted' ? '1' : '0');
          renderApp();
          if (perm === 'granted') tick();
        },
      }, '🔔 ' + t('settings.enableReminders')));
    }
    return box;
  }

  function viewSettings() {
    const root = h('div');
    const emailIn = h('input', { type: 'email', id: 'settings-email', value: state.user.email || '', maxlength: 254, autocomplete: 'email' });
    const emailErr = h('p', { class: 'form-error', role: 'alert' });
    root.append(h('div', { class: 'section' },
      h('h2', null, t('settings.account')),
      h('p', null, '👤 ', h('strong', null, state.user.username)),
      h('form', {
        novalidate: true,
        onSubmit: async e => {
          e.preventDefault();
          emailErr.textContent = '';
          try {
            const u = await api('/api/me', { method: 'PUT', body: { email: emailIn.value.trim() } });
            state.user.email = u.email;
            toast(t('settings.emailSaved'));
          } catch (ex) { emailErr.textContent = errMsg(ex); }
        },
      }, h('label', { class: 'field', for: 'settings-email' }, t('settings.email'), emailIn), emailErr,
      h('button', { type: 'submit', class: 'btn-secondary' }, t('settings.saveEmail')))));

    const cur = h('input', { type: 'password', id: 'pw-current', autocomplete: 'current-password', maxlength: 72 });
    const nw = h('input', { type: 'password', id: 'pw-new', autocomplete: 'new-password', maxlength: 72 });
    const pwErr = h('p', { class: 'form-error', role: 'alert' });
    root.append(h('div', { class: 'section' }, h('h2', null, t('settings.password')),
      h('form', {
        novalidate: true,
        onSubmit: async e => {
          e.preventDefault();
          pwErr.textContent = '';
          try {
            const r = await api('/api/me/password', { method: 'POST', body: { current_password: cur.value, new_password: nw.value } });
            state.token = r.token;
            store.set('ht_token', r.token);
            cur.value = ''; nw.value = '';
            toast(t('settings.passwordChanged'));
          } catch (ex) { pwErr.textContent = errMsg(ex); }
        },
      },
      h('label', { class: 'field', for: 'pw-current' }, t('settings.currentPassword'), cur),
      h('label', { class: 'field', for: 'pw-new' }, t('settings.newPassword'), nw), pwErr,
      h('button', { type: 'submit', class: 'btn-secondary' }, t('settings.changePassword')))));

    const langSel = h('select', { id: 'set-lang', onChange: e => setLang(e.target.value) },
      h('option', { value: 'vi', selected: state.lang === 'vi' }, 'Tiếng Việt'),
      h('option', { value: 'en', selected: state.lang === 'en' }, 'English'));
    const themeSel = h('select', {
      id: 'set-theme',
      onChange: e => { state.theme = e.target.value; store.set('ht_theme', state.theme); applyTheme(); },
    }, ['auto', 'light', 'dark'].map(k => h('option', { value: k, selected: state.theme === k }, t('theme.' + k))));
    root.append(h('div', { class: 'section' }, h('h2', null, t('settings.appearance')),
      h('label', { class: 'field', for: 'set-lang' }, t('settings.language'), langSel),
      h('label', { class: 'field', for: 'set-theme' }, t('settings.theme'), themeSel)));

    root.append(remindersSection());

    root.append(h('div', { class: 'section' }, h('h2', null, t('settings.data')),
      h('div', { class: 'row' },
        h('button', { class: 'btn-secondary', type: 'button', onClick: () => download('/api/export', 'habit-tracker-export.json') }, '⬇ ' + t('settings.exportJson')),
        h('button', { class: 'btn-secondary', type: 'button', onClick: () => download('/api/export.csv', 'habit-tracker-export.csv') }, '⬇ ' + t('settings.exportCsv')),
        state.installEvent && h('button', {
          type: 'button',
          onClick: async () => { const ev = state.installEvent; state.installEvent = null; ev.prompt(); try { await ev.userChoice; } catch (_) { /* ignore */ } renderApp(); },
        }, '📲 ' + t('settings.install')))));

    root.append(h('div', { class: 'section danger' }, h('h2', null, t('settings.danger')),
      h('p', { class: 'muted' }, t('settings.deleteHelp')),
      h('button', { class: 'btn-danger', type: 'button', onClick: deleteAccount }, t('settings.deleteAccount'))));

    root.append(h('p', { class: 'center' }, h('button', { class: 'btn-secondary', type: 'button', id: 'logout-btn', onClick: () => logout(false) }, t('settings.logout'))));
    return root;
  }

  async function deleteAccount() {
    const pw = h('input', { type: 'password', id: 'del-password', autocomplete: 'current-password', maxlength: 72 });
    const err = h('p', { class: 'form-error', role: 'alert' });
    const ok = await modal(done => h('form', {
      novalidate: true,
      onSubmit: async e => {
        e.preventDefault();
        try {
          await api('/api/me', { method: 'DELETE', body: { password: pw.value } });
          done(true);
        } catch (ex) { err.textContent = errMsg(ex); }
      },
    },
    h('h2', null, t('settings.deleteAccount')), h('p', null, t('settings.deletePrompt')), pw, err,
    h('div', { class: 'dialog-actions' },
      h('button', { type: 'button', class: 'btn-secondary', onClick: () => done(false) }, t('dlg.cancel')),
      h('button', { type: 'submit', class: 'btn-danger' }, t('settings.deleteAccount')))));
    if (ok === true) { logout(false); toast(t('settings.accountDeleted')); }
  }

  /* ---------- reminders (while the app is open / installed) ---------- */
  let reminderTimer = null;
  function stopReminders() { if (reminderTimer) { clearInterval(reminderTimer); reminderTimer = null; } }
  function startReminders() { stopReminders(); reminderTimer = setInterval(tick, 30000); tick(); }

  function notify(hb) {
    const title = t('reminder.title');
    const opts = { body: hb.icon + ' ' + t('reminder.body', { name: hb.name }), icon: '/icon-192.png', tag: 'habit-' + hb.id };
    const fallback = () => { try { new Notification(title, opts); } catch (_) { /* ignore */ } };
    if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
      navigator.serviceWorker.ready.then(r => r.showNotification(title, opts)).catch(fallback);
    } else fallback();
  }

  async function tick() {
    if (!state.token || !state.user) return;
    const today = localDate();
    if (today !== state.today) { // the day rolled over while the app stayed open
      state.today = today; state.dayOffset = 0; state.stats = null;
      try { await loadHabits(); renderApp(); } catch (_) { /* retry on next tick */ }
      return;
    }
    if (store.get('ht_remind') !== '1' || !('Notification' in window) || Notification.permission !== 'granted') return;
    const now = new Date();
    const mins = now.getHours() * 60 + now.getMinutes();
    const key = 'ht_reminded_' + today;
    let sent;
    try { sent = JSON.parse(store.get(key) || '[]'); } catch (_) { sent = []; }
    for (const hb of state.habits) {
      if (!hb.reminder_time) continue;
      const [hh, mm] = hb.reminder_time.split(':').map(Number);
      const at = hh * 60 + mm;
      if (mins < at || mins > at + 120) continue;
      const day = hb.recent[hb.recent.length - 1];
      if (!day || !day.scheduled || day.count >= hb.target || sent.includes(hb.id)) continue;
      sent.push(hb.id);
      notify(hb);
    }
    store.set(key, JSON.stringify(sent));
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });

  /* ---------- PWA ---------- */
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    state.installEvent = e;
    if (state.user && state.tab === 'settings') renderApp();
  });
  window.addEventListener('load', () => {
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  });

  /* ---------- boot ---------- */
  async function boot() {
    applyTheme();
    document.documentElement.lang = state.lang;
    renderHeader();
    if (state.token) {
      try {
        state.user = await api('/api/me');
        state.today = localDate();
        await loadHabits();
        enterApp();
        return;
      } catch (e) {
        if (e instanceof ApiError && e.code === 'NETWORK') { renderOffline(); return; }
        state.token = null; state.user = null; store.del('ht_token');
      }
    }
    renderAuth();
  }

  boot();
})();
