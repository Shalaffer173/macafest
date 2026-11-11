const tg = window.Telegram?.WebApp;
tg?.ready();
tg?.expand();

const app = document.getElementById('app');
let data = null;
let view = remembered('view', 'homework'); // homework | schedule | grades
let filter = 'todo'; // фильтр на вкладке «Домашка»
let week = null; // понедельник недели, показанной в расписании
let scrollToToday = false;
let busy = false;

// ---------- общие помощники ----------

function remembered(key, fallback) {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
function remember(key, value) {
  try { localStorage.setItem(key, value); } catch { /* в приватном режиме хранилища может не быть */ }
}

async function api(path, body) {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': tg?.initData ?? '' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Помилка ${res.status}`);
  return json;
}

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c != null && c !== false));
  return node;
}

const todayIso = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};
function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const mondayOf = (iso) => addDays(iso, -((new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7));
const shortDate = (iso) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;
const DAYS = ['неділя', 'понеділок', 'вівторок', 'середа', 'четвер', 'п’ятниця', 'субота'];
function dayLabel(iso, today) {
  const diff = Math.round((new Date(iso) - new Date(today)) / 86400000);
  if (diff === 0) return `Сьогодні, ${shortDate(iso)}`;
  if (diff === 1) return `Завтра, ${shortDate(iso)}`;
  return `${DAYS[new Date(iso).getUTCDay()]}, ${shortDate(iso)}`.replace(/^./, (c) => c.toUpperCase());
}
const empty = (text) => el('p', { className: 'empty', textContent: text });

/** Ряд кнопок-переключателей: pick(id) вызывается при выборе. */
function switcher(className, items, current, pick) {
  return el('div', { className }, ...items.map(([id, label]) => {
    const b = el('button', { textContent: label });
    b.setAttribute('aria-pressed', String(current === id));
    b.addEventListener('click', () => pick(id));
    return b;
  }));
}

// ---------- вход ----------

function renderLogin(error) {
  const user = el('input', { type: 'text', name: 'username', autocomplete: 'username', required: true });
  const pass = el('input', { type: 'password', name: 'password', autocomplete: 'current-password', required: true });
  const btn = el('button', { className: 'primary', type: 'submit', textContent: 'Увійти' });
  const err = el('p', { className: 'error', textContent: error ?? '' });
  const form = el('form', {},
    el('label', {}, 'Логін учня', user),
    el('label', {}, 'Пароль', pass),
    err, btn);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    btn.disabled = true;
    btn.textContent = 'Входжу…';
    err.textContent = '';
    try {
      data = await api('/api/login', { username: user.value, password: pass.value });
      render();
      watchSync();
    } catch (ex) {
      err.textContent = ex.message;
      btn.disabled = false;
      btn.textContent = 'Увійти';
    }
  });
  app.replaceChildren(
    el('h1', { textContent: 'Щоденник' }),
    el('p', { className: 'muted', textContent: 'Увійди в «Єдину Школу» один раз. Пароль не зберігається: далі працює тимчасовий токен, який можна стерти будь-коли.' }),
    form);
}

// ---------- вкладка «Домашка» ----------

function taskNode(t, today) {
  const box = el('input', { type: 'checkbox', checked: t.done, disabled: t.removed });
  box.setAttribute('aria-label', `Зроблено: ${t.subject}`);
  const li = el('li', { className: `task${t.done ? ' done' : ''}${t.removed ? ' removed' : ''}${t.archived ? ' archived' : ''}` },
    box,
    el('div', { className: 'body' },
      el('div', { className: 'subject', textContent: t.subject }),
      el('div', { className: 'text', textContent: t.text }),
      el('div', { className: 'meta' },
        t.removed && el('span', { className: 'tag danger', textContent: 'прибрано вчителем' }),
        t.archived && el('span', { className: 'tag', textContent: 'до підключення бота' }),
        t.answered && el('span', { className: 'tag ok', textContent: 'відповідь здано' }),
        t.backdated && el('span', { className: 'tag warn', textContent: 'додано заднім числом' }),
        t.changed && el('span', { className: 'tag warn', textContent: 'змінено' }),
        !t.done && !t.removed && !t.archived && t.due < today && el('span', { className: 'tag danger', textContent: 'прострочено' }),
        t.files > 0 && el('span', { textContent: `📎 ${t.files}` }),
        t.topic && el('span', { textContent: t.topic }))));
  const toggle = async () => {
    if (t.removed) return;
    t.done = !t.done;
    t.changed = false;
    t.archived = false;
    tg?.HapticFeedback?.impactOccurred('light');
    render();
    try { await api(`/api/tasks/${encodeURIComponent(t.id)}/done`, { done: t.done }); }
    catch { t.done = !t.done; render(); }
  };
  li.addEventListener('click', (e) => { e.preventDefault(); toggle(); });
  return li;
}

function renderHomework(today) {
  // Прогресс считаем по текущей неделе и дальше, плюс всё несделанное из прошлого.
  const monday = mondayOf(today);
  const live = data.tasks.filter((t) => !t.removed && !t.archived && (t.due >= monday || !t.done));
  const doneCount = live.filter((t) => t.done).length;
  const pct = live.length ? Math.round((doneCount / live.length) * 100) : 0;

  const shown = data.tasks.filter((t) => (filter === 'todo' ? !t.done && !t.removed && !t.archived : filter === 'done' ? t.done : true));
  const groups = new Map();
  for (const t of shown) {
    const key = filter === 'todo' && t.due < today ? 'overdue' : t.due;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  const keys = [...groups.keys()].sort((a, b) => (a === 'overdue' ? -1 : b === 'overdue' ? 1 : a < b ? -1 : 1));
  if (filter !== 'todo') keys.reverse();

  return [
    data.syncing && !data.tasks.length && el('p', { className: 'muted', textContent: 'Завантажую завдання зі щоденника…' }),
    el('div', { className: 'progress' },
      el('div', { className: 'row' },
        el('span', {}, 'Зроблено ', el('b', { textContent: `${doneCount} з ${live.length}` })),
        el('span', { className: 'muted', textContent: `залишилось ${live.length - doneCount}` })),
      el('div', { className: 'bar' }, el('i', { style: `width:${pct}%` }))),
    switcher('tabs', [['todo', 'Треба зробити'], ['done', 'Зроблено'], ['all', 'Усі']], filter, (id) => { filter = id; render(); }),
    ...(keys.length
      ? keys.flatMap((k) => [
          el('h2', { className: k === 'overdue' ? 'overdue' : '', textContent: k === 'overdue' ? 'Прострочено' : dayLabel(k, today) }),
          el('ul', {}, ...groups.get(k).map((t) => taskNode(t, today))),
        ])
      : [empty(filter === 'todo' ? '🎉 Усе зроблено' : 'Тут поки порожньо')]),
    data.tasks.length > 0 && el('p', { className: 'muted center', textContent:
      `Усього завдань: ${data.tasks.length}, найстаріше від ${shortDate(data.tasks[0].due)}. В архіві: ${data.tasks.filter((t) => t.archived).length}` }),
  ];
}

// ---------- вкладка «Розклад» ----------

const minutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
function endTime(start, duration) {
  const t = minutes(start) + duration;
  return `${String(Math.floor(t / 60) % 24).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

/** Неделя по умолчанию: текущая, пока в ней остались уроки; иначе следующая. */
function defaultWeek(weeks, lessons, today) {
  const current = mondayOf(today);
  const hasUpcoming = lessons.some((l) => mondayOf(l.date) === current && l.date >= today);
  if (weeks.includes(current) && hasUpcoming) return current;
  return weeks.find((w) => w > current) ?? (weeks.includes(current) ? current : weeks[weeks.length - 1]);
}

function lessonNode(l, today) {
  const off = l.status === 'canceled' || l.status === 'replaced';
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const isNow = !off && l.date === today && l.start && nowMin >= minutes(l.start) && nowMin < minutes(l.start) + l.duration;
  // Домашка, заданная на этот урок: связываем по дате и предмету.
  // Архивные задания не считаем: бот не знает, сделаны ли они.
  const due = data.tasks.filter((t) => !t.removed && !t.archived && t.due === l.date && t.subject === l.subject);
  const undone = due.filter((t) => !t.done).length;
  const time = l.start ? `${l.start}–${endTime(l.start, l.duration)}` : null;
  return el('li', { className: `lesson${off ? ' off' : ''}${isNow ? ' now' : ''}` },
    el('div', { className: 'num', textContent: l.number ?? '·' }),
    el('div', { className: 'body' },
      el('div', { className: 'subject', textContent: l.subject }),
      el('div', { className: 'meta' },
        isNow && el('span', { className: 'tag ok', textContent: 'зараз' }),
        l.status === 'canceled' && el('span', { className: 'tag danger', textContent: 'скасовано' }),
        l.status === 'replaced' && el('span', { className: 'tag danger', textContent: 'замінено іншим' }),
        l.status === 'replacement' && el('span', { className: 'tag warn', textContent: 'заміна' }),
        !off && due.length > 0 && el('span', { className: `tag ${undone ? 'warn' : 'ok'}`,
          textContent: undone ? (undone > 1 ? `ДЗ: ${undone}` : 'ДЗ') : 'ДЗ ✓' }),
        time && el('span', { textContent: time }),
        l.room && el('span', { textContent: /^\d/.test(l.room) ? `каб. ${l.room}` : l.room }),
        l.teacher && el('span', { textContent: l.teacher })),
      off && l.reason && el('div', { className: 'note', textContent: l.reason }),
      !off && l.topic && el('div', { className: 'note', textContent: l.topic })));
}

function renderSchedule(today) {
  const lessons = data.lessons ?? [];
  if (!lessons.length) {
    return [empty(data.syncing ? 'Завантажую розклад…' : 'Розкладу поки немає. Натисни ↻, щоб завантажити.')];
  }
  const weeks = [...new Set(lessons.map((l) => mondayOf(l.date)))].sort();
  if (!week || !weeks.includes(week)) week = defaultWeek(weeks, lessons, today);
  const idx = weeks.indexOf(week);
  const current = mondayOf(today);
  const name = week === current ? 'Цей тиждень' : week === addDays(current, 7) ? 'Наступний тиждень'
    : week === addDays(current, -7) ? 'Минулий тиждень' : 'Тиждень';

  const step = (delta, label, symbol) => {
    const b = el('button', { className: 'icon-btn', textContent: symbol, disabled: !weeks[idx + delta] });
    b.setAttribute('aria-label', label);
    b.addEventListener('click', () => { week = weeks[idx + delta]; render(); });
    return b;
  };

  const byDay = new Map();
  for (const l of lessons) {
    if (mondayOf(l.date) !== week) continue;
    if (!byDay.has(l.date)) byDay.set(l.date, []);
    byDay.get(l.date).push(l);
  }
  return [
    el('div', { className: 'weeknav' },
      step(-1, 'Попередній тиждень', '‹'),
      el('div', { className: 'label' }, name, el('small', { textContent: `${shortDate(week)} – ${shortDate(addDays(week, 6))}` })),
      step(1, 'Наступний тиждень', '›')),
    ...[...byDay.keys()].sort().flatMap((date) => {
      const h = el('h2', { className: date === today ? 'today' : '', textContent: dayLabel(date, today) });
      if (date === today) h.id = 'today';
      return [h, el('ul', { className: date < today ? 'past' : '' }, ...byDay.get(date).map((l) => lessonNode(l, today)))];
    }),
  ];
}

// ---------- вкладка «Оцінки» ----------

const num = (v) => v.toLocaleString('uk-UA', { maximumFractionDigits: 1 });
function average(grades) {
  const values = grades.filter((g) => g.kind === 'current' && g.value != null).map((g) => g.value);
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}
/** Цвет по 12-балльной шкале: высокие зелёным, низкие предупреждающим. */
function tone(g) {
  if (g.kind === 'missing') return 'missing';
  const scale = g.value == null ? '' : g.value >= 10 ? ' ok' : g.value <= 3 ? ' danger' : g.value <= 6 ? ' warn' : '';
  return `${g.kind === 'summary' ? 'final' : ''}${scale}`;
}
const chip = (g) => {
  const c = el('span', { className: `chip ${tone(g)}`, textContent: g.label });
  c.title = [shortDate(g.date), g.type].filter(Boolean).join(' · ');
  return c;
};

function renderGrades() {
  const grades = data.grades ?? [];
  if (!grades.length) {
    return [empty(data.syncing ? 'Завантажую оцінки…' : 'Оцінок поки немає. Натисни ↻, щоб завантажити.')];
  }
  const marks = grades.filter((g) => g.kind !== 'missing'); // сервер отдаёт от новых к старым
  const missed = grades.length - marks.length;
  const avg = average(grades);

  const bySubject = new Map();
  for (const g of grades) {
    if (!bySubject.has(g.subject)) bySubject.set(g.subject, []);
    bySubject.get(g.subject).push(g);
  }
  const subjects = [...bySubject.keys()].sort((a, b) => a.localeCompare(b, 'uk'));

  return [
    el('div', { className: 'overview' },
      el('div', {}, el('div', { className: 'big', textContent: avg == null ? '—' : num(avg) }), el('div', { className: 'muted', textContent: 'середній бал' })),
      el('div', { className: 'muted' },
        el('div', { textContent: `Оцінок: ${marks.length}` }),
        el('div', { textContent: `Пропусків: ${missed}` }))),
    el('p', { className: 'muted legend', textContent: 'Середній бал рахується з поточних оцінок. В обведених рамкою — тематичні й підсумкові.' }),

    el('h2', { textContent: 'Останні' }),
    el('ul', {}, ...marks.slice(0, 6).map((g) => el('li', { className: 'grade' },
      chip(g),
      el('div', { className: 'body' },
        el('div', { className: 'subject', textContent: g.subject }),
        el('div', { className: 'meta' },
          el('span', { textContent: shortDate(g.date) }),
          g.type && el('span', { textContent: g.type }),
          g.topic && el('span', { textContent: g.topic })),
        g.comment && el('div', { className: 'note', textContent: `«${g.comment}»` }))))),

    el('h2', { textContent: 'За предметами' }),
    el('ul', {}, ...subjects.map((subject) => {
      const list = bySubject.get(subject).slice().reverse(); // от старых к новым, как в журнале
      const a = average(list);
      return el('li', { className: 'card' },
        el('div', { className: 'row' },
          el('span', { className: 'subject', textContent: subject }),
          el('span', { className: 'avg', textContent: a == null ? '—' : num(a) })),
        el('div', { className: 'chips' }, ...list.map(chip)),
        el('details', {},
          el('summary', { textContent: `Докладно (${list.length})` }),
          el('ul', { className: 'rows' }, ...list.slice().reverse().map((g) => el('li', {},
            el('b', { textContent: g.label }),
            ` · ${[shortDate(g.date), g.kind === 'missing' ? 'пропуск' : g.type, g.topic, g.comment && `«${g.comment}»`].filter(Boolean).join(' · ')}`)))));
    })),
  ];
}

// ---------- общий каркас ----------

function render() {
  if (!data?.loggedIn) return renderLogin(data?.error);
  const today = todayIso();

  const refresh = el('button', { className: `icon-btn${busy || data.syncing ? ' spin' : ''}`, textContent: '↻', title: 'Оновити' });
  refresh.setAttribute('aria-label', 'Оновити');
  refresh.addEventListener('click', sync);

  const logout = el('button', { className: 'link', textContent: 'Вийти і стерти мої дані' });
  logout.addEventListener('click', async () => {
    if (!confirm('Стерти токен, завдання, розклад і оцінки?')) return;
    data = await api('/api/logout', {});
    render();
  });

  const body = view === 'schedule' ? renderSchedule(today) : view === 'grades' ? renderGrades() : renderHomework(today);

  app.replaceChildren(...[
    el('header', {},
      el('div', {},
        el('h1', { textContent: data.student || 'Щоденник' }),
        el('div', { className: 'who', textContent: data.school ?? '' })),
      refresh),
    data.error && el('p', { className: 'error', textContent: `Не вдалося оновити: ${data.error}` }),
    switcher('nav', [['homework', 'Домашка'], ['schedule', 'Розклад'], ['grades', 'Оцінки']], view, (id) => {
      view = id;
      remember('view', id);
      scrollToToday = id === 'schedule';
      window.scrollTo(0, 0);
      render();
    }),
    ...body,
    data.lastSync && el('p', { className: 'muted center', textContent: `Оновлено ${new Date(data.lastSync).toLocaleString('uk-UA', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}` }),
    logout].filter(Boolean));

  // При переходе в расписание показываем сразу сегодняшний день, а не понедельник.
  if (scrollToToday) {
    scrollToToday = false;
    document.getElementById('today')?.scrollIntoView({ block: 'start' });
  }
}

async function sync() {
  if (busy || data.syncing) return;
  busy = true;
  render();
  try { data = await api('/api/sync', {}); } catch (e) { data.error = e.message; }
  busy = false;
  render();
  watchSync();
}

// Пока сервер синхронизируется в фоне, раз в 2 секунды спрашиваем, не закончил ли,
// и только после этого забираем обновлённые данные целиком.
let watching = false;
async function watchSync() {
  if (watching || !data?.syncing) return;
  watching = true;
  try {
    for (let i = 0; i < 90; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      if (!(await api('/api/status')).syncing) break;
    }
    data = await api('/api/state');
    render();
  } catch { /* связь пропала: данные обновятся при следующем открытии */ }
  watching = false;
}

try {
  data = await api('/api/state');
  scrollToToday = view === 'schedule';
  render();
  watchSync();
} catch (e) {
  app.replaceChildren(empty(e.message));
}
