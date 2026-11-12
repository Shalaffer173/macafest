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
// Устроена как раздел успеваемости в приложении «Єдиної Школи»: пропуски, список предметов
// с ожидаемой оценкой за семестр, а по нажатию — страница предмета с оценками по месяцам.

let subject = null; // предмет, открытый на вкладке «Оцінки»
const MONTHS = ['Січень', 'Лютий', 'Березень', 'Квітень', 'Травень', 'Червень', 'Липень', 'Серпень', 'Вересень', 'Жовтень', 'Листопад', 'Грудень'];
const monthName = (key) => MONTHS[Number(key.slice(5, 7)) - 1];
const fmt1 = (v) => (v == null ? '—' : v.toFixed(1)); // 10.8, как в приложении
const semesterOf = (iso) => (iso.slice(5, 7) >= '09' ? 1 : 2); // 1-й: сентябрь–декабрь, 2-й: январь–август

/** Средний балл как на сайте дневника: по текущим оценкам, а если их нет — по тематическим и итоговым. */
function average(grades) {
  const mean = (kind) => {
    const values = grades.filter((g) => g.kind === kind && g.value != null).map((g) => g.value);
    return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  };
  return mean('current') ?? mean('summary');
}

/** Цвет по 12-балльной шкале: высокие зелёным, низкие предупреждающим. */
function tone(g) {
  if (g.kind === 'missing') return 'missing';
  const scale = g.value == null ? '' : g.value >= 10 ? ' ok' : g.value <= 3 ? ' danger' : g.value <= 6 ? ' warn' : '';
  return `${g.kind === 'summary' ? 'final' : ''}${scale}`;
}
const chip = (g) => el('span', { className: `chip ${tone(g)}`, textContent: g.label });
const tile = (value, label) => el('div', { className: 'tile' },
  el('div', { className: 'value', textContent: value }),
  el('div', { className: 'label', textContent: label }));

function svg(tag, attrs = {}, ...children) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  node.append(...children);
  return node;
}

/**
 * График текущих оценок за месяц: одна линия по шкале 0–12, точки равномерно по ширине.
 * Подписи на точках не ставим — все значения перечислены под графиком; строка под графиком
 * показывает выбранную точку (касание, наведение или клавиатура).
 */
function monthChart(points, title) {
  const W = 320, H = 120, left = 24, right = 12, top = 8, bottom = 8;
  const x = (i) => left + (i * (W - left - right)) / (points.length - 1);
  const y = (v) => top + ((12 - v) * (H - top - bottom)) / 12;
  const describe = (g) => [shortDate(g.date), g.label, g.type].filter(Boolean).join(' · ');
  const readout = el('div', { className: 'readout', textContent: describe(points[points.length - 1]) });
  const line = points.map((g, i) => `${x(i)},${y(g.value)}`).join(' ');

  const dots = points.map((g, i) => svg('circle', { class: 'dot', cx: x(i), cy: y(g.value), r: 4 }));
  const select = (i) => {
    readout.textContent = describe(points[i]);
    dots.forEach((d, k) => d.setAttribute('r', k === i ? 6 : 4));
  };
  const hits = points.map((g, i) => {
    const hit = svg('circle', { class: 'hit', cx: x(i), cy: y(g.value), r: 16, tabindex: 0, role: 'img', 'aria-label': describe(g) });
    for (const type of ['pointerenter', 'focus', 'click']) hit.addEventListener(type, () => select(i));
    return hit;
  });

  return el('div', { className: 'chart' },
    svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'group', 'aria-label': `${title}: ${points.map((g) => g.label).join(', ')}` },
      ...[0, 4, 8, 12].flatMap((v) => [
        svg('line', { class: 'grid', x1: left, x2: W - right, y1: y(v), y2: y(v) }),
        svg('text', { class: 'tick', x: left - 6, y: y(v) + 3.5, 'text-anchor': 'end' }, String(v)),
      ]),
      svg('polygon', { class: 'area', points: `${x(0)},${y(0)} ${line} ${x(points.length - 1)},${y(0)}` }),
      svg('polyline', { class: 'line', points: line }),
      ...dots, ...hits),
    readout);
}

function renderSubject(name, today) {
  const list = data.grades.filter((g) => g.subject === name); // от новых к старым
  const months = [...new Set(list.map((g) => g.date.slice(0, 7)))]; // тоже от новых к старым
  const inMonth = (key) => list.filter((g) => g.date.startsWith(key));
  // «Месяц» — последний месяц, в котором есть оценки (в текущем их может ещё не быть).
  const lastGraded = months.find((key) => average(inMonth(key)) != null);

  const back = el('button', { className: 'back', textContent: '‹ Усі предмети' });
  back.addEventListener('click', () => { subject = null; render(); });

  return [
    back,
    el('h2', { className: 'title', textContent: name }),
    el('div', { className: 'tiles three' },
      tile(fmt1(lastGraded ? average(inMonth(lastGraded)) : null), lastGraded ? monthName(lastGraded) : 'Місяць'),
      tile(fmt1(average(list.filter((g) => semesterOf(g.date) === semesterOf(today)))), 'Семестр'),
      tile(fmt1(average(list)), 'Рік')),
    ...months.map((key) => {
      const all = inMonth(key).slice().reverse(); // по порядку дат
      const current = all.filter((g) => g.kind !== 'summary');
      const plotted = current.filter((g) => g.kind === 'current' && g.value != null);
      const finals = all.filter((g) => g.kind === 'summary');
      return el('section', { className: 'card month' },
        el('div', { className: 'row' },
          el('span', { className: 'subject', textContent: monthName(key) }),
          el('span', { className: 'avg', textContent: fmt1(average(all)) })),
        plotted.length >= 2 && monthChart(plotted, `Оцінки за ${monthName(key).toLowerCase()}`),
        current.length > 0 && el('div', { className: 'cells' }, ...current.map((g) => el('div', { className: 'cell' },
          el('div', { className: 'date', textContent: shortDate(g.date) }),
          chip(g),
          el('div', { className: 'kind', textContent: g.kind === 'missing' ? 'пропуск' : g.type ?? '' })))),
        ...finals.map((g) => el('div', { className: 'final-row' },
          el('div', { className: 'body' },
            el('div', { textContent: `${g.type ?? 'Підсумкова'} ${shortDate(g.date)}` }),
            g.topic && el('div', { className: 'topic', textContent: g.topic })),
          chip(g))),
        ...all.filter((g) => g.comment).map((g) => el('div', { className: 'note', textContent: `${shortDate(g.date)}: «${g.comment}»` })));
    }),
    el('p', { className: 'muted legend', textContent: 'Середній бал рахується з поточних оцінок, як на сайті щоденника; тематичні й підсумкові показано окремо.' }),
  ];
}

function renderGrades(today) {
  const grades = data.grades ?? [];
  if (!grades.length) {
    return [empty(data.syncing ? 'Завантажую оцінки…' : 'Оцінок поки немає. Натисни ↻, щоб завантажити.')];
  }
  if (subject && grades.some((g) => g.subject === subject)) return renderSubject(subject, today);
  subject = null;

  const missed = grades.filter((g) => g.kind === 'missing');
  const marks = grades.filter((g) => g.kind !== 'missing'); // сервер отдаёт от новых к старым
  const semester = semesterOf(today);
  const rows = [...new Set(grades.map((g) => g.subject))]
    .map((name) => ({ name, expected: average(grades.filter((g) => g.subject === name && semesterOf(g.date) === semester)) }))
    .sort((a, b) => (b.expected ?? -1) - (a.expected ?? -1) || a.name.localeCompare(b.name, 'uk'));

  return [
    el('div', { className: 'tiles' },
      tile(String(missed.length), 'Пропусків за рік'),
      tile(String(missed.filter((g) => g.date.startsWith(today.slice(0, 7))).length), 'Пропусків за місяць')),

    el('h2', { textContent: 'Очікувана оцінка за семестр' }),
    el('ul', {}, ...rows.map((r) => {
      const open = el('button', { className: 'meter' },
        el('span', { className: 'name', textContent: r.name }),
        el('span', { className: 'fig', textContent: fmt1(r.expected) }),
        el('span', { className: 'go', textContent: '›' }),
        el('span', { className: 'track' }, el('i', { style: `width:${r.expected == null ? 0 : (r.expected / 12) * 100}%` })));
      open.setAttribute('aria-label', r.expected == null ? `${r.name}: оцінок немає` : `${r.name}: ${fmt1(r.expected)} з 12`);
      open.addEventListener('click', () => { subject = r.name; window.scrollTo(0, 0); render(); });
      return el('li', {}, open);
    })),

    el('h2', { textContent: 'Останні оцінки' }),
    el('ul', {}, ...marks.slice(0, 5).map((g) => el('li', { className: 'grade' },
      chip(g),
      el('div', { className: 'body' },
        el('div', { className: 'subject', textContent: g.subject }),
        el('div', { className: 'meta' },
          el('span', { textContent: shortDate(g.date) }),
          g.type && el('span', { textContent: g.type }),
          g.topic && el('span', { textContent: g.topic })),
        g.comment && el('div', { className: 'note', textContent: `«${g.comment}»` }))))),
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

  const body = view === 'schedule' ? renderSchedule(today) : view === 'grades' ? renderGrades(today) : renderHomework(today);
  // Системная кнопка «назад» в Telegram возвращает со страницы предмета к списку.
  if (view === 'grades' && subject) tg?.BackButton?.show?.(); else tg?.BackButton?.hide?.();

  app.replaceChildren(...[
    el('header', {},
      el('div', {},
        el('h1', { textContent: data.student || 'Щоденник' }),
        el('div', { className: 'who', textContent: data.school ?? '' })),
      refresh),
    data.error && el('p', { className: 'error', textContent: `Не вдалося оновити: ${data.error}` }),
    switcher('nav', [['homework', 'Домашка'], ['schedule', 'Розклад'], ['grades', 'Оцінки']], view, (id) => {
      view = id;
      subject = null;
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

tg?.BackButton?.onClick?.(() => { subject = null; render(); });

try {
  data = await api('/api/state');
  scrollToToday = view === 'schedule';
  render();
  watchSync();
} catch (e) {
  app.replaceChildren(empty(e.message));
}
