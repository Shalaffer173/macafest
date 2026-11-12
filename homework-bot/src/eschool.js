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
  const { timeout = 20000, ...init } = opts;
  const res = await fetch(url, {
    redirect: 'manual',
    signal: AbortSignal.timeout(timeout),
    ...init,
    headers: { 'User-Agent': UA, Accept: 'application/json', Cookie: cookieHeader(jar), ...init.headers },
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
  throw new EschoolError('site_changed', 'Не знайшов форму входу на сайті щоденника: схоже, його оновили');
}

async function bindIdentity(jar, identity) {
  const res = await request(jar, `${DIARY}/api/v1/seplogin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(identity),
  });
  if (!res.ok) throw new EschoolError('bind_failed', `Щоденник не прийняв вибір школи (${res.status})`);
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
    throw new EschoolError('bad_credentials', 'Невірний логін або пароль');
  }

  const list = await request(jar, `${DIARY}/api/v1/seplogin`);
  if (!list.ok) throw new EschoolError('no_diary', `Щоденник не відкрився після входу (${list.status})`);
  const items = ((await list.json()).Items ?? []).filter(Boolean);
  log(`роли в аккаунте: ${items.map((i) => i.role).join(', ') || 'нет'}`);
  const identity = items.find((i) => i.role === 'schoolboy');
  if (!identity) {
    throw new EschoolError('not_student', 'У цьому акаунті немає ролі учня. Потрібен логін учня, а не батьків чи вчителя');
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
  if (!res.ok) throw new EschoolError('session_expired', 'Сесія закінчилась, потрібно увійти ще раз');
  await bindIdentity(session.jar, session.identity);
}

// Несколько запросов могут идти одновременно; если токен истёк у всех сразу,
// продлеваем его один раз, а не каждый сам по себе.
const refreshing = new WeakMap();
function refreshOnce(session) {
  if (!refreshing.has(session)) {
    refreshing.set(session, refresh(session).finally(() => refreshing.delete(session)));
  }
  return refreshing.get(session);
}

/**
 * Запрос к API дневника с одним повтором после продления сессии.
 * opts: { method, json, form, timeout }. Возвращает разобранный JSON или null, если тело пустое.
 */
async function api(session, path, params, opts = {}) {
  const url = new URL(`${DIARY}/api/${path}`);
  for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v);
  const method = opts.method ?? 'GET';
  const init = { method, timeout: opts.timeout };
  if (opts.json !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(opts.json);
  } else if (opts.form) {
    init.body = opts.form; // границу multipart fetch выставит сам
  }
  let res = await request(session.jar, url, init);
  if (res.status === 401 || res.status === 403) {
    await refreshOnce(session);
    res = await request(session.jar, url, init);
    if (res.status === 401 || res.status === 403) {
      // Чтение после удачного продления всё равно не пускают — сессия негодна.
      // Запись могли запретить по делу (например, работу уже проверили): это не повод разлогинивать.
      if (method === 'GET') throw new EschoolError('session_expired', 'Сесія закінчилась, потрібно увійти ще раз');
      throw new EschoolError('forbidden', `Щоденник не дозволив цю дію (${res.status})`);
    }
  }
  if (!res.ok) throw new EschoolError('api_error', `Щоденник відповів помилкою ${res.status}`);
  const text = await res.text();
  if (!text.trim()) return null;
  try { return JSON.parse(text); } catch { return null; }
}

const getProfile = (session) => api(session, 'profile');
const day = (s) => (typeof s === 'string' ? s.slice(0, 10) : null);

/** Уроки из ответа дневника -> плоский список заданий. */
export function appointmentsToTasks(appointments) {
  const tasks = new Map();
  for (const a of appointments ?? []) {
    if (!a) continue;
    for (const h of a.Embed?.TargetHomeworks ?? []) {
      if (!h) continue;
      tasks.set(String(h.Id), {
        id: String(h.Id),
        subject: (a.Subject ?? '').trim() || 'Без предмета',
        // Текста может не быть (учитель приложил только файл или задал устно) —
        // запись всё равно показываем: в дневнике на неё можно сдать ответ.
        text: (h.Description ?? '').trim(),
        topic: (h.Topic ?? '').trim() || null,
        due: day(h.TargetAppointmentDate) ?? day(a.Date),
        assigned: day(h.AppointmentDate),
        files: h.FilesCount ?? 0,
        // Ученик сдал ответ: текстом (HaveAnswer) или файлами. FilesCount при fileRole=schoolboy
        // считает файлы ученика, а не учителя — проверено на настоящем аккаунте.
        answered: h.HaveAnswer === true || (h.FilesCount ?? 0) > 0,
      });
    }
  }
  return mergeDuplicates([...tasks.values()].filter((t) => t.due));
}

/**
 * Если на уроке несколько тем, дневник хранит одно и то же задание отдельной записью
 * на каждую тему. Склеиваем записи с одинаковыми предметом, датой и текстом в одну;
 * её id — наименьший из исходных, чтобы он не менялся от синхронизации к синхронизации.
 */
export function mergeDuplicates(tasks) {
  const norm = (s) => s.replace(/\s+/g, ' ').toLowerCase();
  const byKey = new Map();
  for (const t of [...tasks].sort((a, b) => Number(a.id) - Number(b.id))) {
    const key = `${t.subject}|${t.due}|${norm(t.text)}`;
    const first = byKey.get(key);
    if (!first) { byKey.set(key, { ...t }); continue; }
    first.files = Math.max(first.files, t.files);
    first.answered = first.answered || t.answered;
    if (t.topic && !(first.topic ?? '').includes(t.topic)) first.topic = first.topic ? `${first.topic}; ${t.topic}` : t.topic;
  }
  return [...byKey.values()];
}

function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const clean = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

/** «Прізвище І. П.» из данных учителя. */
function teacherName(t) {
  if (!t) return null;
  const initials = [t.FirstName, t.SecondName].map(clean).filter(Boolean).map((n) => `${n[0]}.`).join(' ');
  return [clean(t.LastName), initials].filter(Boolean).join(' ') || null;
}

/** Уроки из ответа дневника -> расписание. Правила статусов те же, что на сайте. */
export function appointmentsToLessons(appointments) {
  const lessons = new Map();
  for (const a of appointments ?? []) {
    if (!a || !day(a.Date)) continue;
    const room = clean(a.RoomNumber);
    const topic = (a.Embed?.Topics ?? []).map((t) => clean(t?.Title)).find(Boolean)
      ?? (a.Embed?.Rates ?? []).map((r) => clean(r?.Topic)).find(Boolean) ?? null;
    let status = 'normal';
    if (a.Canceled === true) status = 'canceled';
    else if (a.ReplaceId > 0) status = 'replacement'; // этот урок поставлен вместо другого
    else if (a.ReplacementId > 0) status = 'replaced'; // вместо этого урока поставлен другой
    lessons.set(String(a.Id), {
      id: String(a.Id),
      date: day(a.Date),
      number: a.LessonNumber > 0 ? a.LessonNumber : null,
      start: typeof a.StartTime === 'string' && /^\d{2}:\d{2}/.test(a.StartTime) ? a.StartTime.slice(0, 5) : null,
      duration: a.Duration > 0 ? a.Duration : 45,
      subject: clean(a.Subject) ?? 'Без предмета',
      room: room === '0' ? null : room,
      teacher: teacherName(a.Embed?.Teacher),
      topic,
      status,
      reason: status === 'canceled' || status === 'replaced' ? clean(a.CancelReason) : null,
    });
  }
  return [...lessons.values()];
}

/**
 * Оценки и отметки об отсутствии из ответа дневника. Отбор и подписи повторяют сайт:
 * kind = current (текущая), summary (итоговая: тематическая, семестровая) или missing (пропуск).
 * value — число для среднего балла; в среднее идут только текущие оценки.
 */
export function appointmentsToGrades(appointments) {
  const grades = new Map();
  for (const a of appointments ?? []) {
    if (!a) continue;
    for (const r of a.Embed?.Rates ?? []) {
      if (!r) continue;
      const lessonDate = day(a.Date);
      const date = day(r.Date) ?? lessonDate;
      if (!date || !lessonDate) continue;
      const rate = typeof r.Rate === 'number' && Number.isFinite(r.Rate) && r.Rate !== 0 ? r.Rate : null;
      let kind, label;
      if (r.MissingTypeId != null || r.Missing > 0) {
        kind = 'missing';
        label = clean(r.MissingType) ?? 'Н';
      } else {
        kind = r.Summary === true ? 'summary' : 'current';
        // Категория 6 на сайте — числовая оценка: показывается само число.
        label = r.RateCategoryId === 6 && rate != null ? String(rate) : clean(r.RateValue) ?? (rate != null ? String(rate) : null);
        if (label == null) continue; // пустая запись без оценки
      }
      grades.set(String(r.Id), {
        id: String(r.Id),
        subject: clean(a.Subject) ?? clean(r.Subject) ?? 'Без предмета',
        date,
        lessonDate,
        label,
        value: kind === 'missing' ? null : rate,
        kind,
        type: clean(r.RateType),
        topic: clean(r.Topic),
        comment: clean(r.SchoolboyDescription),
      });
    }
  }
  return [...grades.values()];
}

/**
 * Сводка по отметкам об отсутствии в сыром ответе дневника — без имён и текстов.
 * Нужна, чтобы разобраться, если число пропусков расходится с официальным приложением.
 */
export function missingStats(appointments) {
  const st = { rates: 0, marks: 0, unique: 0, repeated: 0, byTypeId: 0, byMissingField: 0, typeTextOnly: 0, missingValues: {}, onCanceled: 0, byMonth: {} };
  const seen = new Set();
  for (const a of appointments ?? []) {
    for (const r of a?.Embed?.Rates ?? []) {
      if (!r) continue;
      st.rates++;
      const byType = r.MissingTypeId != null;
      const byField = r.Missing > 0;
      if (!byType && !byField) {
        if (clean(r.MissingType)) st.typeTextOnly++;
        continue;
      }
      st.marks++;
      if (byType) st.byTypeId++;
      if (byField) { st.byMissingField++; st.missingValues[r.Missing] = (st.missingValues[r.Missing] ?? 0) + 1; }
      if (seen.has(r.Id)) st.repeated++; else { seen.add(r.Id); st.unique++; }
      if (a.Canceled === true) st.onCanceled++;
      const month = (day(r.Date) ?? day(a.Date) ?? '?').slice(0, 7);
      st.byMonth[month] = (st.byMonth[month] ?? 0) + 1;
    }
  }
  return st;
}

/**
 * Границы учебного года из дневника: { start, end, semester2 } (YYYY-MM-DD) или null.
 * Дневник хранит по записи на семестр; год — от самого раннего начала до самого позднего конца.
 */
export function parseAcademicYear(items) {
  const list = (items ?? []).filter(Boolean);
  const starts = list.map((i) => day(i.Start)).filter(Boolean).sort();
  const ends = list.map((i) => day(i.End)).filter(Boolean).sort();
  if (!starts.length || !ends.length) return null;
  const second = list.filter((i) => i.Semester === 2).map((i) => day(i.Start)).filter(Boolean).sort()[0] ?? null;
  return { start: starts[0], end: ends[ends.length - 1], semester2: second };
}

export async function fetchYear(session) {
  const data = await api(session, `v1/${session.schoolId}/AcademicYear`);
  return parseAcademicYear(data?.Items);
}

// ---------- ответы на домашние задания ----------
// Порядок действий тот же, что на сайте дневника: файлы загружаются к заданию по одному
// (UploadFile), затем ответ создаётся (AssignAnswer) или меняется (UpdateAnswer) со списком
// всех файлов ученика. После проверки учителем ответ менять нельзя.

const homeworkPath = (session, id, tail = '') => `v1/${session.schoolId}/Homework/${encodeURIComponent(id)}${tail}`;
const fileInfo = (f) => ({ id: f.Id, name: clean(f.Name) ?? `#${f.Id}`, size: typeof f.Size === 'number' ? f.Size : null });

/** Состояние ответа ученика на задание, как его хранит дневник. */
export async function getAnswer(session, homeworkId) {
  const hw = await api(session, homeworkPath(session, homeworkId), { embed: 'File' });
  const list = await api(session, homeworkPath(session, homeworkId, '/Answer'), { schoolboyId: String(session.schoolboyId), embed: 'File' });
  const answer = (list?.Items ?? []).filter(Boolean)[0] ?? null;
  const files = (hw?.Embed?.Files ?? []).filter(Boolean);
  const own = (f) => typeof f.Role === 'string' && f.Role.trim().toLowerCase() === 'schoolboy';
  let status = 'todo'; // ещё не сдано
  if (answer) {
    if (answer.AnswerChecked === true) status = 'checked'; // проверено, менять нельзя
    else if ((answer.CheckedTime ?? '').trim() !== '') status = 'reopened'; // учитель вернул на доработку
    else status = 'submitted';
  }
  return {
    status,
    answerId: answer?.Id ?? null,
    text: answer?.Answer ?? '',
    submittedAt: answer?.SubmittedTime ?? null,
    teacherComment: clean(answer?.TeacherComment),
    files: files.filter(own).map(fileInfo),
    teacherFiles: files.filter((f) => !own(f)).map(fileInfo),
  };
}

/** Адрес файла: как и сайт дневника, берём его через /fs на домене дневника. */
export function fileUrl(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const u = new URL(raw);
    return `${DIARY}/fs${u.pathname}${u.search}`;
  } catch {
    return raw.startsWith('/fs') ? `${DIARY}${raw}` : `${DIARY}/fs${raw.startsWith('/') ? '' : '/'}${raw}`;
  }
}

/**
 * Открывает файл задания (учителя или свой) для скачивания: { name, mime, size, body }.
 * Адрес берётся из самого задания в дневнике, а не из запроса приложения.
 */
export async function openFile(session, homeworkId, fileId) {
  const hw = await api(session, homeworkPath(session, homeworkId), { embed: 'File' });
  const file = (hw?.Embed?.Files ?? []).find((f) => f && f.Id === Number(fileId));
  let target = fileUrl(file?.Url);
  if (!target) throw new EschoolError('file_missing', 'Файл не знайдено');
  let res;
  for (let hop = 0; hop < 4; hop++) {
    // cookie дневника отправляем только на его же домены
    const own = /(^|\.)eschool-ua\.com$/.test(new URL(target).hostname);
    res = await fetch(target, {
      redirect: 'manual',
      signal: AbortSignal.timeout(300000),
      headers: { 'User-Agent': UA, ...(own ? { Cookie: cookieHeader(session.jar) } : {}) },
    });
    const next = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (!next) break;
    target = new URL(next, target).href;
  }
  if (!res.ok || !res.body) throw new EschoolError('file_failed', `Щоденник не віддав файл (${res.status})`);
  return {
    name: clean(file.Name) ?? `file-${file.Id}`,
    mime: clean(file.Mime) ?? res.headers.get('content-type') ?? 'application/octet-stream',
    size: res.headers.get('content-length'),
    body: res.body,
  };
}

/** Прикрепляет файл ученика к заданию. file — File или Blob с именем. Возвращает id файла в дневнике. */
export async function uploadAnswerFile(session, homeworkId, file, name) {
  const form = new FormData();
  form.append('upload-file', file, name);
  const res = await api(session, homeworkPath(session, homeworkId, '/UploadFile'), null, { method: 'POST', form, timeout: 180000 });
  const id = Array.isArray(res) ? res[0]?.Id : null;
  if (!Number.isInteger(id)) throw new EschoolError('upload_failed', 'Щоденник не прийняв файл');
  return id;
}

export async function removeAnswerFile(session, homeworkId, fileId) {
  await api(session, homeworkPath(session, homeworkId, '/RemoveFile'), null, { method: 'POST', json: { Id: Number(fileId) } });
}

/** Создаёт или меняет ответ на задание и возвращает то, что после этого реально лежит в дневнике. */
export async function submitAnswer(session, homeworkId, text) {
  const current = await getAnswer(session, homeworkId);
  if (current.status === 'checked') {
    throw new EschoolError('answer_locked', 'Вчитель уже перевірив роботу — змінювати відповідь не можна');
  }
  const answer = String(text ?? '').trim();
  const Files = current.files.map((f) => ({ Id: f.id }));
  if (!answer && !Files.length) throw new EschoolError('answer_empty', 'Напиши відповідь або додай файл');
  if (current.answerId == null) {
    const created = await api(session, homeworkPath(session, homeworkId, '/AssignAnswer'), null, { method: 'POST', json: { Answer: answer, Files } });
    if (!created || typeof created.Id !== 'number') throw new EschoolError('submit_failed', 'Щоденник не підтвердив, що відповідь збережено');
  } else {
    await api(session, homeworkPath(session, homeworkId, '/UpdateAnswer'), null, { method: 'POST', json: { Id: current.answerId, Answer: answer, Files } });
  }
  return getAnswer(session, homeworkId);
}

/** Всё за период [from, to]: задания, расписание и оценки. Сайт запрашивает по неделе, делаем так же. */
export async function fetchDiary(session, from, to) {
  const weeks = [];
  for (let start = from; start <= to; start = addDays(start, 7)) {
    weeks.push({ start, end: addDays(start, 6) < to ? addDays(start, 6) : to });
  }
  const load = async ({ start, end }) => {
    const data = await api(session, `v1/${session.schoolId}/SchoolBoy/${session.schoolboyId}/Appointment`, {
      start, end, embed: EMBED, fileRole: 'schoolboy',
    });
    return data?.Items ?? [];
  };
  // Первую неделю ждём отдельно: если токен пора продлить, это случится здесь, один раз.
  // Остальные идут по три одновременно — весь год загружается в несколько раз быстрее.
  const all = weeks.length ? [...await load(weeks[0])] : [];
  for (let i = 1; i < weeks.length; i += 3) {
    const batch = await Promise.all(weeks.slice(i, i + 3).map(load));
    for (const items of batch) all.push(...items);
    await new Promise((r) => setTimeout(r, 150)); // не частим
  }
  return {
    tasks: appointmentsToTasks(all), lessons: appointmentsToLessons(all), grades: appointmentsToGrades(all),
    debug: { appointments: all.length, missing: missingStats(all) },
  };
}
