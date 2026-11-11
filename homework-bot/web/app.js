const tg = window.Telegram?.WebApp;
tg?.ready();
tg?.expand();

const app = document.getElementById('app');
let data = null;
let filter = 'todo';
let busy = false;

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
const DAYS = ['неділя', 'понеділок', 'вівторок', 'середа', 'четвер', 'п’ятниця', 'субота'];
function dayLabel(iso, today) {
  const diff = Math.round((new Date(iso) - new Date(today)) / 86400000);
  const date = `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;
  if (diff === 0) return `Сьогодні, ${date}`;
  if (diff === 1) return `Завтра, ${date}`;
  return `${DAYS[new Date(iso).getUTCDay()]}, ${date}`.replace(/^./, (c) => c.toUpperCase());
}

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
    el('h1', { textContent: 'Домашка' }),
    el('p', { className: 'muted', textContent: 'Увійди в «Єдину Школу» один раз. Пароль не зберігається: далі працює тимчасовий токен, який можна стерти будь-коли.' }),
    form);
}

function taskNode(t, today) {
  const box = el('input', { type: 'checkbox', checked: t.done, disabled: t.removed });
  box.setAttribute('aria-label', `Зроблено: ${t.subject}`);
  const li = el('li', { className: `task${t.done ? ' done' : ''}${t.removed ? ' removed' : ''}` },
    box,
    el('div', { className: 'body' },
      el('div', { className: 'subject', textContent: t.subject }),
      el('div', { className: 'text', textContent: t.text }),
      el('div', { className: 'meta' },
        t.removed && el('span', { className: 'tag danger', textContent: 'прибрано вчителем' }),
        t.backdated && el('span', { className: 'tag warn', textContent: 'додано заднім числом' }),
        t.changed && el('span', { className: 'tag warn', textContent: 'змінено' }),
        !t.done && !t.removed && t.due < today && el('span', { className: 'tag danger', textContent: 'прострочено' }),
        t.files > 0 && el('span', { textContent: `📎 ${t.files}` }),
        t.topic && el('span', { textContent: t.topic }))));
  const toggle = async () => {
    if (t.removed) return;
    t.done = !t.done;
    t.changed = false;
    tg?.HapticFeedback?.impactOccurred('light');
    render();
    try { await api(`/api/tasks/${encodeURIComponent(t.id)}/done`, { done: t.done }); }
    catch { t.done = !t.done; render(); }
  };
  li.addEventListener('click', (e) => { e.preventDefault(); toggle(); });
  return li;
}

function render() {
  if (!data?.loggedIn) return renderLogin(data?.error);
  const today = todayIso();
  // Прогресс считаем по текущей неделе и дальше, плюс всё несделанное из прошлого.
  const d0 = new Date(today);
  const monday = new Date(d0.getTime() - ((d0.getUTCDay() + 6) % 7) * 86400000).toISOString().slice(0, 10);
  const live = data.tasks.filter((t) => !t.removed && (t.due >= monday || !t.done));
  const doneCount = live.filter((t) => t.done).length;
  const pct = live.length ? Math.round((doneCount / live.length) * 100) : 0;

  const shown = data.tasks.filter((t) => (filter === 'todo' ? !t.done && !t.removed : filter === 'done' ? t.done : true));
  const groups = new Map();
  for (const t of shown) {
    const key = filter === 'todo' && t.due < today ? 'overdue' : t.due;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  const keys = [...groups.keys()].sort((a, b) => (a === 'overdue' ? -1 : b === 'overdue' ? 1 : a < b ? -1 : 1));
  if (filter !== 'todo') keys.reverse();

  const refresh = el('button', { className: `icon-btn${busy || data.syncing ? ' spin' : ''}`, textContent: '↻', title: 'Оновити' });
  refresh.setAttribute('aria-label', 'Оновити');
  refresh.addEventListener('click', sync);

  const tab = (id, label) => {
    const b = el('button', { textContent: label });
    b.setAttribute('aria-pressed', String(filter === id));
    b.addEventListener('click', () => { filter = id; render(); });
    return b;
  };

  const logout = el('button', { className: 'link', textContent: 'Вийти і стерти мої дані' });
  logout.addEventListener('click', async () => {
    if (!confirm('Стерти токен і список завдань?')) return;
    data = await api('/api/logout', {});
    render();
  });

  app.replaceChildren(...[
    el('header', {},
      el('div', {},
        el('h1', { textContent: 'Домашка' }),
        el('div', { className: 'who', textContent: [data.student, data.school].filter(Boolean).join(' · ') })),
      refresh),
    data.syncing && !data.tasks.length && el('p', { className: 'muted', textContent: 'Завантажую завдання зі щоденника…' }),
    data.error && el('p', { className: 'error', textContent: `Не вдалося оновити: ${data.error}` }),
    el('div', { className: 'progress' },
      el('div', { className: 'row' },
        el('span', {}, 'Зроблено ', el('b', { textContent: `${doneCount} з ${live.length}` })),
        el('span', { className: 'muted', textContent: `залишилось ${live.length - doneCount}` })),
      el('div', { className: 'bar' }, el('i', { style: `width:${pct}%` }))),
    el('div', { className: 'tabs' }, tab('todo', 'Треба зробити'), tab('done', 'Зроблено'), tab('all', 'Усі')),
    ...(keys.length
      ? keys.flatMap((k) => [
          el('h2', { className: k === 'overdue' ? 'overdue' : '', textContent: k === 'overdue' ? 'Прострочено' : dayLabel(k, today) }),
          el('ul', {}, ...groups.get(k).map((t) => taskNode(t, today))),
        ])
      : [el('p', { className: 'empty', textContent: filter === 'todo' ? '🎉 Усе зроблено' : 'Тут поки порожньо' })]),
    data.lastSync && el('p', { className: 'muted center', textContent: `Оновлено ${new Date(data.lastSync).toLocaleString('uk-UA', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}` }),
    logout].filter(Boolean));
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

// Пока сервер синхронизируется в фоне, раз в 2 секунды спрашиваем, не закончил ли.
let watching = false;
async function watchSync() {
  if (watching) return;
  watching = true;
  for (let i = 0; i < 60 && data?.syncing; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    try { data = await api('/api/state'); } catch { break; }
    render();
  }
  watching = false;
}

try {
  data = await api('/api/state');
  render();
  watchSync();
} catch (e) {
  app.replaceChildren(el('p', { className: 'empty', textContent: e.message }));
}
