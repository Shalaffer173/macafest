// Клиент «Єдиної Школи». Официального API нет: адреса и форматы взяты из
// кода сайта diary.eschool-ua.com (ноябрь 2026) и могут измениться.
//
// Схема сессии:
//   вход на eschool-ua.com/login     -> cookie session_token + refresh_token
//   POST diary/api/v1/seplogin       -> cookie application_token (привязка к школе и роли)
//   POST diary/api/auth/refresh      -> новые токены по refresh_token
// Пароль нужен только для первого шага и нигде не сохраняется.

const PORTAL = 'https://eschool-ua.com';
const DIARY = 'https://diary.eschool-ua.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const EMBED = 'Topic,Rate,TargetHomework,Teacher,Meeting';

export class EschoolError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/** Мини-хранилище cookie: имя -> значение. Все нужные cookie живут на .eschool-ua.com. */
export function absorbCookies(jar, res) {
  // Сайт в одном ответе и выдаёт cookie, и удаляет одноимённую старую (с другим доменом).
  // Домены мы не различаем, поэтому сначала применяем удаления, потом установки.
  const set = {};
  for (const line of res.headers.getSetCookie?.() ?? []) {
    const m = /^([^=;\s]+)=([^;]*)/.exec(line);
    if (!m) continue;
    const expired = /max-age=(0|-\d+)/i.test(line) || m[2] === '';
    if (expired) delete jar[m[1]]; else set[m[1]] = m[2];
  }
  return Object.assign(jar, set);
}
const cookieHeader = (jar) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');

let trace = null;
/** Включает пошаговый журнал запросов (для npm run check). Токены и пароль в него не попадают. */
export function setTrace(fn) { trace = fn; }

async function request(jar, url, opts = {}) {
  const res = await fetch(url, {
    redirect: 'manual',
    signal: AbortSignal.timeout(20000),
    ...opts,
    headers: { 'User-Agent': UA, Accept: 'application/json', Cookie: cookieHeader(jar), ...opts.headers },
  });
  absorbCookies(jar, res);
  if (trace) {
    const names = (res.headers.getSetCookie?.() ?? []).map((c) => c.split('=')[0] + (/=;|max-age=(0|-\d+)/i.test(c) ? '(удалена)' : ''));
    let line = `${opts.method ?? 'GET'} ${new URL(url).host}${new URL(url).pathname} -> ${res.status}`;
    if (names.length) line += `, cookie: ${names.join(', ')}`;
    if (res.status >= 400) line += `, ответ: ${(await res.clone().text()).slice(0, 200)}`;
    trace(line);
  }
  return res;
}

/** Id серверного действия входа меняется при каждом обновлении сайта, поэтому ищем его в скриптах. */
export function findLoginActionId(js) {
  const m = /createServerReference\)\("([0-9a-f]{30,})"[^)]{0,200}"loginAction"/.exec(js);
  return m ? m[1] : null;
}

async function discoverLoginAction(jar) {
  const page = await request(jar, `${PORTAL}/login`, { headers: { Accept: 'text/html' } });
  const html = await page.text();
  const chunks = [...new Set(html.match(/\/_next\/static\/chunks\/[^"\\ ]+\.js/g) ?? [])];
  // Сначала скрипт самой страницы входа, потом остальные.
  chunks.sort((a, b) => Number(b.includes('login')) - Number(a.includes('login')));
  for (const c of chunks) {
    const res = await fetch(PORTAL + c, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) continue;
    const id = findLoginActionId(await res.text());
    if (id) return id;
  }
  throw new EschoolError('site_changed', 'Не нашёл форму входа на сайте: похоже, он обновился');
}

async function bindIdentity(jar, identity) {
  const res = await request(jar, `${DIARY}/api/v1/seplogin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(identity),
  });
  if (!res.ok) throw new EschoolError('bind_failed', `Дневник не принял выбор школы (${res.status})`);
}

/** Вход по логину и паролю. Возвращает сессию для сохранения (без пароля). */
export async function login(username, password, log = () => {}) {
  const jar = {};
  const actionId = await discoverLoginAction(jar);
  log(`форма входа найдена, id действия ${actionId.slice(0, 8)}…`);

  const form = new FormData();
  // Аргументы серверного действия: (prevState, formData). Порядок важен: сначала поля
  // формы, в конце ссылка на них — так отправляет сам сайт, иначе сервер видит пустую форму.
  form.set('1_username', username);
  form.set('1_password', password);
  form.set('1_from', '');
  form.set('0', '[{"ok":true},"$K1"]');
  const res = await request(jar, `${PORTAL}/login`, {
    method: 'POST',
    headers: { 'Next-Action': actionId, Accept: 'text/x-component', Origin: PORTAL, Referer: `${PORTAL}/login` },
    body: form,
  });
  const answer = await res.text();
  log(`ответ на вход: ${res.status}, cookie: ${Object.keys(jar).join(', ') || 'нет'}`);
  if (!jar.session_token && !jar.refresh_token) {
    log(`начало ответа: ${answer.slice(0, 400)}`);
    throw new EschoolError('bad_credentials', 'Неверный логин или пароль');
  }

  const list = await request(jar, `${DIARY}/api/v1/seplogin`);
  if (!list.ok) throw new EschoolError('no_diary', `Дневник не открылся после входа (${list.status})`);
  const items = ((await list.json()).Items ?? []).filter(Boolean);
  log(`роли в аккаунте: ${items.map((i) => i.role).join(', ') || 'нет'}`);
  const identity = items.find((i) => i.role === 'schoolboy');
  if (!identity) {
    throw new EschoolError('not_student', 'В этом аккаунте нет роли ученика. Нужен логин ученика, а не родителя или учителя');
  }
  const session = {
    jar,
    identity: { user_id: identity.user_id, school_id: identity.school_id, role: identity.role },
    schoolName: identity.school_name ?? null,
  };
  await bindIdentity(jar, session.identity);
  const profile = await getProfile(session);
  session.schoolboyId = profile.Id;
  session.schoolId = profile.SchoolId;
  session.studentName = [profile.LastName, profile.FirstName].filter(Boolean).join(' ') || null;
  return session;
}

/** Продление сессии по refresh_token. Бросает session_expired, если нужно входить заново. */
export async function refresh(session) {
  const res = await request(session.jar, `${DIARY}/api/auth/refresh`, { method: 'POST' });
  if (!res.ok) throw new EschoolError('session_expired', 'Сессия истекла, нужно войти заново');
  await bindIdentity(session.jar, session.identity);
}

/** GET к API дневника с одним повтором после продления сессии. */
async function api(session, path, params) {
  const url = new URL(`${DIARY}/api/${path}`);
  for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v);
  let res = await request(session.jar, url);
  if (res.status === 401 || res.status === 403) {
    await refresh(session);
    res = await request(session.jar, url);
    if (res.status === 401 || res.status === 403) {
      throw new EschoolError('session_expired', 'Сессия истекла, нужно войти заново');
    }
  }
  if (!res.ok) throw new EschoolError('api_error', `Дневник ответил ${res.status} на ${path}`);
  return res.json();
}

const getProfile = (session) => api(session, 'profile');
const day = (s) => (typeof s === 'string' ? s.slice(0, 10) : null);

/** Уроки из ответа дневника -> плоский список заданий. */
export function appointmentsToTasks(appointments) {
  const tasks = new Map();
  for (const a of appointments ?? []) {
    if (!a) continue;
    for (const h of a.Embed?.TargetHomeworks ?? []) {
      if (!h || !(h.Description ?? '').trim()) continue;
      tasks.set(String(h.Id), {
        id: String(h.Id),
        subject: (a.Subject ?? '').trim() || 'Без предмета',
        text: h.Description.trim(),
        topic: (h.Topic ?? '').trim() || null,
        due: day(h.TargetAppointmentDate) ?? day(a.Date),
        assigned: day(h.AppointmentDate),
        files: h.FilesCount ?? 0,
      });
    }
  }
  return [...tasks.values()].filter((t) => t.due);
}

function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Задания за период [from, to]. Сайт сам запрашивает по неделе, делаем так же. */
export async function fetchTasks(session, from, to) {
  const all = [];
  for (let start = from; start <= to; start = addDays(start, 7)) {
    const end = addDays(start, 6) < to ? addDays(start, 6) : to;
    const data = await api(session, `v1/${session.schoolId}/SchoolBoy/${session.schoolboyId}/Appointment`, {
      start, end, embed: EMBED, fileRole: 'schoolboy',
    });
    all.push(...(data.Items ?? []));
    await new Promise((r) => setTimeout(r, 400)); // не частим
  }
  return appointmentsToTasks(all);
}
