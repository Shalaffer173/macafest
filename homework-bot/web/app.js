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

let loginName = ''; // чтобы логин не пропадал, пока форма перерисовывается

function renderLogin(error) {
  const pending = !!data?.loggingIn;
  const user = el('input', { type: 'text', name: 'username', autocomplete: 'username', required: true, value: loginName, disabled: pending });
  const pass = el('input', { type: 'password', name: 'password', autocomplete: 'current-password', required: true, disabled: pending });
  const btn = el('button', { className: 'primary', type: 'submit', textContent: pending ? 'Входжу…' : 'Увійти', disabled: pending });
  const err = el('p', { className: 'error', textContent: pending ? '' : error ?? '' });
  const form = el('form', {},
    el('label', {}, 'Логін учня', user),
    el('label', {}, 'Пароль', pass),
    pending && el('p', { className: 'muted', textContent: 'Перевіряю логін і пароль у щоденнику, це кілька секунд…' }),
    err, btn);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    loginName = user.value;
    btn.disabled = true;
    btn.textContent = 'Входжу…';
    err.textContent = '';
    try {
      data = await api('/api/login', { username: user.value, password: pass.value });
      render();
      if (data.loggedIn) watchSync(); else watchLogin();
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

// Сервер входит в дневник в фоне; спрашиваем раз в полторы секунды, чем кончилось.
let watchingLogin = false;
async function watchLogin() {
  if (watchingLogin || !data?.loggingIn) return;
  watchingLogin = true;
  try {
    for (let i = 0; i < 80; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      const st = await api('/api/status');
      if (st.loggingIn) continue;
      data = st.loggedIn ? await api('/api/state') : { loggedIn: false, error: st.loginError ?? 'Не вдалося увійти. Спробуй ще раз' };
      break;
    }
  } catch (e) {
    data = { loggedIn: false, error: e.message };
  }
  watchingLogin = false;
  render();
  watchSync();
}

// ---------- вкладка «Домашка» ----------

function taskNode(t, today) {
  const box = el('input', { type: 'checkbox', checked: t.done, disabled: t.removed });
  box.setAttribute('aria-label', `Зроблено: ${t.subject}`);
  const li = el('li', { className: `task${t.done ? ' done' : ''}${t.removed ? ' removed' : ''}${t.archived ? ' archived' : ''}` },
    box,
    el('div', { className: 'body' },
      el('div', { className: 'subject', textContent: t.subject }),
      el('div', { className: t.text ? 'text' : 'text none', textContent: t.text || 'Без тексту завдання' }),
      el('div', { className: 'meta' },
        t.removed && el('span', { className: 'tag danger', textContent: 'прибрано вчителем' }),
        t.archived && el('span', { className: 'tag', textContent: 'до підключення бота' }),
        t.answered && el('span', { className: 'tag ok', textContent: 'відповідь здано' }),
        t.undated && el('span', { className: 'tag warn', textContent: 'дату не вказано' }),
        t.undated && t.assigned && el('span', { textContent: `задано ${shortDate(t.assigned)}` }),
        t.backdated && el('span', { className: 'tag warn', textContent: 'додано заднім числом' }),
        t.changed && el('span', { className: 'tag warn', textContent: 'змінено' }),
        !t.done && !t.removed && !t.archived && t.due < today && el('span', { className: 'tag danger', textContent: 'прострочено' }),
        t.files > 0 && el('span', { textContent: `📎 ${t.files}` }),
        t.topic && el('span', { textContent: t.topic }))));
  if (data.canAnswer && !t.removed) {
    // Отдельная кнопка: нажатие на саму карточку по-прежнему ставит галочку.
    const act = el('button', { className: 'act', textContent: t.answered ? 'Моя відповідь ›' : 'Здати ›' });
    act.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); openAnswer(t); });
    li.querySelector('.body').append(act);
  }
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

let subjectsOpen = false; // раскрыт ли список предметов в фильтре

function setHidden(list) {
  data.hiddenSubjects = list;
  render();
  api('/api/prefs', { hiddenSubjects: list }).catch(() => { /* останется до следующего открытия */ });
}

/** Фильтр предметов: кнопка с числом показанных и раскрывающийся список переключателей. */
function subjectFilter(hidden) {
  const subjects = [...new Set(data.tasks.filter((t) => !t.removed).map((t) => t.subject))].sort((a, b) => a.localeCompare(b, 'uk'));
  if (subjects.length < 2) return [];
  const shownCount = subjects.filter((x) => !hidden.has(x)).length;
  const toggle = el('button', { className: 'filter-toggle',
    textContent: `Предмети: ${shownCount === subjects.length ? 'усі' : `${shownCount} з ${subjects.length}`} ${subjectsOpen ? '▴' : '▾'}` });
  toggle.setAttribute('aria-expanded', String(subjectsOpen));
  toggle.addEventListener('click', () => { subjectsOpen = !subjectsOpen; render(); });
  if (!subjectsOpen) return [toggle];

  const chips = subjects.map((name) => {
    const b = el('button', { textContent: name });
    b.setAttribute('aria-pressed', String(!hidden.has(name)));
    b.addEventListener('click', () => {
      const next = new Set(hidden);
      if (next.has(name)) next.delete(name); else next.add(name);
      setHidden([...next]);
    });
    return b;
  });
  const all = el('button', { className: 'mini', textContent: 'Показати всі', disabled: hidden.size === 0 });
  all.addEventListener('click', () => setHidden([]));
  const none = el('button', { className: 'mini', textContent: 'Сховати всі', disabled: shownCount === 0 });
  none.addEventListener('click', () => setHidden(subjects));
  return [toggle, el('div', { className: 'subjects' }, ...chips), el('div', { className: 'subjects-actions' }, all, none)];
}

let query = ''; // строка поиска во вкладке «Домашка»

/** Список заданий, сгруппированный по дням. desc — новые сверху. */
function taskGroups(list, today, { overdue = false, desc = false } = {}) {
  const groups = new Map();
  for (const t of list) {
    const key = overdue && t.due < today ? 'overdue' : t.due;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  const keys = [...groups.keys()].sort((a, b) => (a === 'overdue' ? -1 : b === 'overdue' ? 1 : a < b ? -1 : 1));
  if (desc) keys.reverse();
  return keys.flatMap((k) => [
    el('h2', { className: k === 'overdue' ? 'overdue' : '', textContent: k === 'overdue' ? 'Прострочено' : dayLabel(k, today) }),
    el('ul', {}, ...groups.get(k).map((t) => taskNode(t, today))),
  ]);
}

function renderHomework(today) {
  if (answering) return renderAnswer();
  // Прогресс считаем по текущей неделе и дальше, плюс всё несделанное из прошлого.
  const monday = mondayOf(today);
  // Скрытые предметы не показываются и не идут в прогресс.
  const hidden = new Set(data.hiddenSubjects ?? []);
  const visible = data.tasks.filter((t) => !hidden.has(t.subject));
  const live = visible.filter((t) => !t.removed && !t.archived && (t.due >= monday || !t.done));
  const doneCount = live.filter((t) => t.done).length;
  const pct = live.length ? Math.round((doneCount / live.length) * 100) : 0;

  const shown = visible.filter((t) => (filter === 'todo' ? !t.done && !t.removed && !t.archived : filter === 'done' ? t.done : true));
  const normal = () => (shown.length
    ? taskGroups(shown, today, { overdue: filter === 'todo', desc: filter !== 'todo' })
    : [empty(hidden.size && !visible.length ? 'Усі предмети сховано' : filter === 'todo' ? '🎉 Усе зроблено' : 'Тут поки порожньо')]);

  // Поиск идёт по всем заданиям — с архивом и скрытыми предметами — и перерисовывает
  // только список, чтобы поле ввода не теряло фокус и клавиатура не пряталась.
  const controls = el('div', {},
    switcher('tabs', [['todo', 'Треба зробити'], ['done', 'Зроблено'], ['all', 'Усі']], filter, (id) => { filter = id; render(); }),
    ...subjectFilter(hidden));
  const list = el('div', {});
  const fill = () => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    controls.hidden = words.length > 0;
    if (!words.length) { list.replaceChildren(...normal()); return; }
    const found = data.tasks.filter((t) => {
      const hay = `${t.subject} ${t.text} ${t.topic ?? ''}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
    list.replaceChildren(
      el('p', { className: 'muted found', textContent: found.length
        ? `Знайдено ${found.length} — серед усіх завдань, разом з архівом і схованими предметами`
        : 'Нічого не знайдено' }),
      ...taskGroups(found, today, { desc: true }));
  };
  const search = el('input', { type: 'search', className: 'search', value: query, placeholder: 'Пошук: «§ 12», «контрольна», «фізика»…' });
  search.setAttribute('aria-label', 'Пошук по завданнях');
  search.addEventListener('input', () => { query = search.value; fill(); });
  fill();

  return [
    data.syncing && !data.tasks.length && el('p', { className: 'muted', textContent: 'Завантажую завдання зі щоденника…' }),
    el('div', { className: 'progress' },
      el('div', { className: 'row' },
        el('span', {}, 'Зроблено ', el('b', { textContent: `${doneCount} з ${live.length}` })),
        el('span', { className: 'muted', textContent: `залишилось ${live.length - doneCount}` })),
      el('div', { className: 'bar' }, el('i', { style: `width:${pct}%` }))),
    search,
    controls,
    list,
    data.tasks.length > 0 && el('p', { className: 'muted center', textContent:
      `Усього завдань: ${data.tasks.length}, найстаріше від ${shortDate(data.tasks[0].due)}. В архіві: ${data.tasks.filter((t) => t.archived).length}` }),
  ];
}

// ---------- ответ на задание ----------
// Ответ читается и сохраняется прямо в дневнике; у бота остаётся только отметка «сдано».

let answering = null; // { task, data, text, pending, busy, error, saved }
const MAX_FILE = 20 * 1024 * 1024;
const fileSize = (bytes) => (bytes == null ? '' : bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} КБ` : `${(bytes / 1024 / 1024).toFixed(1)} МБ`);
function when(iso) {
  const d = new Date(iso ?? '');
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('uk-UA', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** Текст с нажимаемыми ссылками. */
function linkified(text) {
  const frag = document.createDocumentFragment();
  let last = 0;
  for (const m of text.matchAll(/https?:\/\/[^\s<>"']+/g)) {
    const url = m[0].replace(/[.,;:!?)\]]+$/, ''); // знак в конце предложения — не часть адреса
    frag.append(text.slice(last, m.index));
    const a = el('a', { href: url, textContent: url, target: '_blank', rel: 'noopener noreferrer' });
    a.addEventListener('click', (e) => { if (tg?.openLink) { e.preventDefault(); tg.openLink(url); } });
    frag.append(a);
    last = m.index + url.length;
  }
  frag.append(text.slice(last));
  return frag;
}

function openAnswer(task) {
  answering = { task, data: null, text: '', pending: [], busy: 'Завантажую відповідь зі щоденника…', error: null, saved: false };
  window.scrollTo(0, 0);
  render();
  loadAnswer();
}

async function loadAnswer() {
  const a = answering;
  a.busy = 'Завантажую відповідь зі щоденника…';
  a.error = null;
  try {
    a.data = await api(`/api/tasks/${a.task.id}/answer`);
    a.text = a.data.text;
  } catch (e) {
    a.error = e.message;
  }
  a.busy = null;
  if (answering === a) render();
}

async function uploadFile(taskId, file) {
  const res = await fetch(`/api/tasks/${taskId}/files`, {
    method: 'POST',
    headers: {
      'Content-Type': file.type || 'application/octet-stream',
      'X-File-Name': encodeURIComponent(file.name),
      'X-Telegram-Init-Data': tg?.initData ?? '',
    },
    body: file,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Помилка ${res.status}`);
  return json;
}

/** Загружает выбранные файлы по одному, затем сохраняет ответ. Что успело загрузиться, остаётся в дневнике. */
async function sendAnswer() {
  const a = answering;
  a.error = null;
  a.saved = false;
  try {
    while (a.pending.length) {
      a.busy = `Завантажую файл «${a.pending[0].name}»…`;
      if (answering === a) render();
      a.data = await uploadFile(a.task.id, a.pending[0]);
      a.pending.shift();
    }
    a.busy = 'Надсилаю відповідь у щоденник…';
    if (answering === a) render();
    a.data = await api(`/api/tasks/${a.task.id}/answer`, { text: a.text });
    a.text = a.data.text;
    a.saved = true;
    // Список мог обновиться, пока был открыт этот экран, — отмечаем задание в актуальных данных.
    a.task = data.tasks.find((x) => x.id === a.task.id) ?? a.task;
    Object.assign(a.task, { done: true, answered: true, archived: false, changed: false, files: a.data.files.length });
    tg?.HapticFeedback?.notificationOccurred?.('success');
  } catch (e) {
    a.error = e.message;
    tg?.HapticFeedback?.notificationOccurred?.('error');
  }
  a.busy = null;
  if (answering === a) render();
}

async function removeFile(file) {
  const a = answering;
  if (!confirm(`Видалити файл «${file.name}» з відповіді?`)) return;
  a.busy = 'Видаляю файл…';
  a.error = null;
  render();
  try { a.data = await api(`/api/tasks/${a.task.id}/files/${file.id}/remove`, {}); } catch (e) { a.error = e.message; }
  a.busy = null;
  if (answering === a) render();
}

/** Открывает файл задания в браузере по одноразовой ссылке на пять минут. */
async function openTaskFile(file) {
  const a = answering;
  try {
    const { url } = await api(`/api/tasks/${a.task.id}/files/${file.id}/link`, {});
    const full = new URL(url, location.origin).href;
    if (tg?.openLink) tg.openLink(full);
    else if (!window.open(full, '_blank', 'noopener')) location.assign(full);
  } catch (e) {
    a.error = e.message;
    if (answering === a) render();
  }
}

function renderAnswer() {
  const a = answering;
  const t = a.task;
  const d = a.data;
  const back = el('button', { className: 'back', textContent: '‹ Домашка' });
  back.addEventListener('click', () => { answering = null; render(); });

  const head = [
    back,
    el('h2', { className: 'title', textContent: t.subject }),
    el('p', { className: 'muted due', textContent: [
      t.undated ? `Дату не вказано, найближчий урок — ${shortDate(t.due)}` : `На ${shortDate(t.due)}`,
      t.undated && t.assigned && `задано ${shortDate(t.assigned)}`,
      t.topic].filter(Boolean).join(' · ') }),
    el('div', { className: `card tasktext${t.text ? '' : ' none'}` }, t.text ? linkified(t.text) : 'Без тексту завдання'),
  ];
  if (!d) {
    const retry = el('button', { className: 'primary', textContent: 'Спробувати ще раз' });
    retry.addEventListener('click', () => { render(); loadAnswer(); });
    return [...head, a.busy && el('p', { className: 'muted', textContent: a.busy }), a.error && el('p', { className: 'error', textContent: a.error }), a.error && retry];
  }

  const locked = d.status === 'checked';
  const statusText = {
    todo: 'Ще не здано',
    submitted: `Здано${when(d.submittedAt) ? ` ${when(d.submittedAt)}` : ''}. Можна змінити, поки вчитель не перевірив.`,
    reopened: 'Вчитель повернув роботу на доопрацювання. Виправ відповідь і надішли ще раз.',
    checked: 'Вчитель уже перевірив роботу — змінити відповідь не можна.',
  }[d.status];

  // Сохранить можно и пустой ответ, как в приложении «Єдиної Школи»: так задание отмечается сданным без текста и файлов.
  const send = el('button', { className: 'primary', textContent: 'Зберегти', disabled: !!a.busy });
  send.addEventListener('click', () => {
    const nothing = a.text.trim() === '' && d.files.length === 0 && a.pending.length === 0;
    // Первый пустой ответ переспрашиваем: случайное нажатие отметит задание сданным у учителя.
    if (nothing && d.answerId == null && !confirm('Зберегти порожню відповідь? Учитель побачить, що завдання здано без тексту й файлів.')) return;
    sendAnswer();
  });

  const area = el('textarea', { value: a.text, placeholder: 'Напиши відповідь…', readOnly: locked, rows: 5 });
  area.setAttribute('aria-label', 'Моя відповідь');
  area.addEventListener('input', () => { a.text = area.value; a.saved = false; });

  const picker = el('input', { type: 'file', multiple: true, hidden: true });
  picker.addEventListener('change', () => {
    const big = [...picker.files].filter((f) => f.size > MAX_FILE);
    a.pending.push(...[...picker.files].filter((f) => f.size <= MAX_FILE));
    a.error = big.length ? `Файл «${big[0].name}» завеликий: можна до 20 МБ` : null;
    render();
  });
  const add = el('button', { className: 'secondary', textContent: '📎 Додати файл', disabled: !!a.busy });
  add.addEventListener('click', () => picker.click());

  // file — файл, уже лежащий в дневнике: его имя становится кнопкой «открыть».
  const fileRow = (name, note, onRemove, file) => {
    const x = onRemove && el('button', { className: 'x', textContent: '×', disabled: !!a.busy });
    if (x) { x.setAttribute('aria-label', `Видалити ${name}`); x.addEventListener('click', onRemove); }
    const title = el(file ? 'button' : 'span', { className: 'name', textContent: name });
    if (file) title.addEventListener('click', () => openTaskFile(file));
    return el('li', { className: 'file' }, title, el('span', { className: 'muted', textContent: note }), x);
  };

  return [
    ...head,
    d.teacherFiles.length > 0 && el('h2', { textContent: 'Файли вчителя' }),
    d.teacherFiles.length > 0 && el('ul', {}, ...d.teacherFiles.map((f) => fileRow(f.name, fileSize(f.size), null, f))),

    el('h2', { textContent: 'Моя відповідь' }),
    el('p', { className: `status ${d.status}`, textContent: statusText }),
    d.teacherComment && el('p', { className: 'card comment' }, el('b', { textContent: 'Коментар учителя: ' }), d.teacherComment),
    area,
    (d.files.length > 0 || a.pending.length > 0) && el('ul', {},
      ...d.files.map((f) => fileRow(f.name, fileSize(f.size), locked ? null : () => removeFile(f), f)),
      ...a.pending.map((f, i) => fileRow(f.name, `${fileSize(f.size)} · ще не надіслано`, () => { a.pending.splice(i, 1); render(); }))),
    !locked && picker,
    !locked && add,
    a.busy && el('p', { className: 'muted', textContent: a.busy }),
    a.error && el('p', { className: 'error', textContent: a.error }),
    a.saved && el('p', { className: 'saved', textContent: '✓ Відповідь збережено в щоденнику' }),
    !locked && send,
    !locked && el('p', { className: 'muted legend', textContent: 'Відповідь і файли зберігаються в «Єдиній Школі», їх побачить учитель.' }),
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
// Второй семестр — с даты, которую сообщил дневник; пока её нет, считаем с января.
const semesterOf = (iso) => (data?.semester2Start ? (iso >= data.semester2Start ? 2 : 1) : iso.slice(5, 7) >= '09' ? 1 : 2);

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

/**
 * Тренд за семестр, как на сайте дневника: средний балл второй половины текущих оценок против первой.
 * Нужно хотя бы 4 оценки в разные дни; разница от 0,2 балла — «растёт» или «падает».
 */
function trend(list) {
  const pts = list.filter((g) => g.kind === 'current' && g.value != null).slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (pts.length < 4 || new Set(pts.map((g) => g.date)).size < 2) return null;
  const half = Math.floor(pts.length / 2);
  const avg = (xs) => xs.reduce((sum, g) => sum + g.value, 0) / xs.length;
  const d = avg(pts.slice(-half)) - avg(pts.slice(0, half));
  return d >= 0.2 ? 'up' : d <= -0.2 ? 'down' : null;
}
const trendMark = (t) => t && el('span', { className: `trend ${t}`, textContent: t === 'up' ? '↑ ' : '↓ ', title: t === 'up' ? 'Бал росте' : 'Бал падає' });

/** Вид итоговой оценки по её типу в дневнике: тематическая, I/II семестр, годовая или другая. */
function finalKind(g) {
  if (g.kind !== 'summary') return null;
  const raw = (g.type ?? '').toLowerCase();
  if (/річн|(^|\s)рік(\s|$)/.test(raw)) return 'year';
  if (/семестр/.test(raw)) {
    const roman = raw.replace(/і/g, 'i'); // кириллическая «і» в римских цифрах
    if (/(^|[^a-z])ii([^a-z]|$)/.test(roman) || /2/.test(raw)) return 'sem2';
    if (/(^|[^a-z])i([^a-z]|$)/.test(roman) || /1/.test(raw)) return 'sem1';
    return semesterOf(g.date) === 2 ? 'sem2' : 'sem1';
  }
  return /темат/.test(raw) ? 'thematic' : 'other';
}

let reportCard = false; // открыт ли табель во вкладке «Оцінки»

function renderReportCard(today) {
  const grades = data.grades ?? [];
  const back = el('button', { className: 'back', textContent: '‹ Оцінки' });
  back.addEventListener('click', () => { reportCard = false; render(); });
  const semester = semesterOf(today);
  const subjects = [...new Set(grades.map((g) => g.subject))].sort((a, b) => a.localeCompare(b, 'uk'));
  let anyFinal = false;
  const cards = subjects.map((name) => {
    const list = grades.filter((g) => g.subject === name); // от новых к старым
    const latest = (kind) => list.find((g) => finalKind(g) === kind) ?? null;
    const finals = { sem1: latest('sem1'), sem2: latest('sem2'), year: latest('year') };
    if (finals.sem1 || finals.sem2 || finals.year) anyFinal = true;
    const thematic = list.filter((g) => ['thematic', 'other'].includes(finalKind(g))).reverse();
    const expected = average(list.filter((g) => semesterOf(g.date) === semester));
    const cell = (label, g, hint) => el('div', { className: 'rc-cell' },
      el('div', { className: 'label', textContent: label }),
      g ? chip(g) : el('div', { className: hint ? 'rc-hint' : 'rc-none', textContent: hint ?? '—' }));
    return el('li', { className: 'card' },
      el('div', { className: 'subject', textContent: name }),
      el('div', { className: 'rc-row' },
        cell('Очікувана', null, fmt1(expected)),
        cell('І семестр', finals.sem1),
        cell('ІІ семестр', finals.sem2),
        cell('Рік', finals.year)),
      thematic.length > 0 && el('div', { className: 'rc-them' },
        el('span', { className: 'label', textContent: 'Тематичні:' }), ...thematic.map(chip)));
  });
  return [
    back,
    el('h2', { className: 'title', textContent: 'Табель' }),
    !anyFinal && el('p', { className: 'muted legend', textContent:
      'Семестрових і річних оцінок ще немає — вони з’являться тут, коли їх виставлять у щоденник. «Очікувана» — середній бал поточних оцінок за цей семестр.' }),
    el('ul', { className: 'rc' }, ...cards),
  ];
}

function renderGrades(today) {
  const grades = data.grades ?? [];
  if (!grades.length) {
    return [empty(data.syncing ? 'Завантажую оцінки…' : 'Оцінок поки немає. Натисни ↻, щоб завантажити.')];
  }
  if (subject && grades.some((g) => g.subject === subject)) return renderSubject(subject, today);
  subject = null;
  if (reportCard) return renderReportCard(today);

  const missed = grades.filter((g) => g.kind === 'missing');
  const marks = grades.filter((g) => g.kind !== 'missing'); // сервер отдаёт от новых к старым
  const semester = semesterOf(today);
  const rows = [...new Set(grades.map((g) => g.subject))]
    .map((name) => {
      const inSemester = grades.filter((g) => g.subject === name && semesterOf(g.date) === semester);
      return { name, expected: average(inSemester), trend: trend(inSemester) };
    })
    .sort((a, b) => (b.expected ?? -1) - (a.expected ?? -1) || a.name.localeCompare(b.name, 'uk'));

  const card = el('button', { className: 'linkrow', textContent: '📄 Табель' }, el('span', { className: 'go', textContent: '›' }));
  card.addEventListener('click', () => { reportCard = true; window.scrollTo(0, 0); render(); });

  return [
    card,
    el('div', { className: 'tiles' },
      tile(String(missed.length), 'Пропусків за рік'),
      tile(String(missed.filter((g) => g.date.startsWith(today.slice(0, 7))).length), 'Пропусків за місяць')),

    el('h2', { textContent: 'Очікувана оцінка за семестр' }),
    el('ul', {}, ...rows.map((r) => {
      const open = el('button', { className: 'meter' },
        el('span', { className: 'name', textContent: r.name }),
        el('span', { className: 'fig' }, trendMark(r.trend), fmt1(r.expected)),
        el('span', { className: 'go', textContent: '›' }),
        el('span', { className: 'track' }, el('i', { style: `width:${r.expected == null ? 0 : (r.expected / 12) * 100}%` })));
      open.setAttribute('aria-label', r.expected == null ? `${r.name}: оцінок немає`
        : `${r.name}: ${fmt1(r.expected)} з 12${r.trend === 'up' ? ', росте' : r.trend === 'down' ? ', падає' : ''}`);
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

// ---------- настройки уведомлений ----------

let settingsOpen = false;
let settingsSaved = null; // какую настройку только что сохранили

function hourSelect(key, from, to, label) {
  const sel = el('select', {}, el('option', { value: '', textContent: 'Вимкнено' }),
    ...Array.from({ length: to - from + 1 }, (_, i) => el('option', { value: String(from + i), textContent: `${from + i}:00` })));
  sel.value = data[key] == null ? '' : String(data[key]);
  sel.setAttribute('aria-label', label);
  sel.addEventListener('change', async () => {
    const value = sel.value === '' ? null : Number(sel.value);
    try {
      const res = await api('/api/prefs', { [key]: value });
      data.digestHour = res.digestHour;
      data.morningHour = res.morningHour;
      settingsSaved = key;
    } catch (e) {
      settingsSaved = null;
      alert(e.message);
    }
    render();
  });
  return sel;
}

function renderSettings() {
  const back = el('button', { className: 'back', textContent: '‹ Назад' });
  back.addEventListener('click', () => { settingsOpen = false; settingsSaved = null; render(); });
  const row = (key, title, hint, from, to) => el('label', { className: 'setting' },
    el('span', { className: 'title', textContent: title }),
    el('span', { className: 'muted', textContent: hint }),
    hourSelect(key, from, to, title),
    settingsSaved === key && el('span', { className: 'saved', textContent: '✓ Збережено' }));
  return [
    back,
    el('h2', { className: 'title', textContent: 'Сповіщення в чаті' }),
    row('digestHour', 'Вечірнє зведення', 'Що задано на наступний навчальний день і ще не зроблено.', 14, 22),
    row('morningHour', 'Ранкове нагадування', 'Що треба здати сьогодні й ще не зроблено, і перший урок.', 5, 11),
    el('p', { className: 'muted legend', textContent: 'Час київський. Якщо все зроблено, бот нічого не пише. '
      + 'Про нові завдання, оцінки, пропуски й зміни в розкладі він повідомляє одразу, щойно їх помітить.' }),
    el('h2', { textContent: 'Команди в чаті' }),
    el('ul', { className: 'rows commands' },
      ...[['/now', 'який урок зараз і скільки до дзвінка'], ['/bells', 'розклад дзвінків'], ['/today', 'розклад на сьогодні'],
        ['/tomorrow', 'на наступний навчальний день'], ['/delete', 'стерти всі мої дані']]
        .map(([c, d]) => el('li', {}, el('b', { textContent: c }), ` — ${d}`))),
  ];
}

// ---------- общий каркас ----------

function render() {
  if (!data?.loggedIn) return renderLogin(data?.error);
  const today = todayIso();

  // В покое — две стрелки по кругу; во время обновления — шесть лучей, по которым шагами бежит яркость.
  const spinning = busy || data.syncing;
  const icon = spinning
    ? svg('svg', { viewBox: '0 0 24 24', class: 'spokes', 'aria-hidden': 'true' },
      ...[1, 0.82, 0.64, 0.46, 0.3, 0.16].map((opacity, i) => svg('line', { x1: 12, y1: 3, x2: 12, y2: 8.5, opacity, transform: `rotate(${-60 * i} 12 12)` })))
    : svg('svg', { viewBox: '0 0 24 24', class: 'arrows', 'aria-hidden': 'true' },
      svg('polyline', { points: '23 4 23 10 17 10' }),
      svg('polyline', { points: '1 20 1 14 7 14' }),
      svg('path', { d: 'M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15' }));
  const refresh = el('button', { className: `icon-btn${spinning ? ' spin' : ''}`, title: 'Оновити' }, icon);
  refresh.setAttribute('aria-label', 'Оновити');
  refresh.addEventListener('click', sync);

  const settings = !settingsOpen && el('button', { className: 'linkrow', textContent: '🔔 Сповіщення в чаті' }, el('span', { className: 'go', textContent: '›' }));
  if (settings) settings.addEventListener('click', () => { settingsOpen = true; settingsSaved = null; window.scrollTo(0, 0); render(); });
  const logout = el('button', { className: 'link', textContent: 'Вийти і стерти мої дані' });
  logout.addEventListener('click', async () => {
    if (!confirm('Стерти токен, завдання, розклад і оцінки?')) return;
    answering = null;
    data = await api('/api/logout', {});
    render();
  });

  const body = settingsOpen ? renderSettings()
    : view === 'schedule' ? renderSchedule(today) : view === 'grades' ? renderGrades(today) : renderHomework(today);
  // Системная кнопка «назад» в Telegram возвращает со страницы предмета или ответа к списку.
  if (settingsOpen || (view === 'grades' && (subject || reportCard)) || (view === 'homework' && answering)) tg?.BackButton?.show?.(); else tg?.BackButton?.hide?.();

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
      answering = null;
      reportCard = false;
      settingsOpen = false;
      remember('view', id);
      scrollToToday = id === 'schedule';
      window.scrollTo(0, 0);
      render();
    }),
    ...body,
    settings,
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

// Пока сервер синхронизируется в фоне, раз в 2 секунды спрашиваем, как дела. Данные забираем,
// когда что-то изменилось: после быстрого первого прохода и в самом конце.
let watching = false;
async function watchSync() {
  if (watching || !data?.syncing) return;
  watching = true;
  try {
    for (let i = 0; i < 150; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const st = await api('/api/status');
      if (st.syncing && st.lastSync === data.lastSync) continue;
      data = await api('/api/state');
      // Не перерисовываем экран, пока человек печатает ответ: сбилось бы место ввода.
      if (document.activeElement?.tagName !== 'TEXTAREA') render();
      if (!data.syncing) break;
    }
  } catch { /* связь пропала: данные обновятся при следующем открытии */ }
  watching = false;
}

tg?.BackButton?.onClick?.(() => {
  if (settingsOpen) settingsOpen = false;
  else if (answering) answering = null;
  else if (reportCard) reportCard = false;
  else subject = null;
  render();
});

try {
  data = await api('/api/state');
  scrollToToday = view === 'schedule';
  render();
  watchSync();
  watchLogin();
} catch (e) {
  app.replaceChildren(empty(e.message));
}
