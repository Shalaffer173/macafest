// Вымышленный дневник для режима DEMO=1: позволяет посмотреть приложение без аккаунта.
// Расписание одинаковое каждую неделю, оценки псевдослучайные, но от запуска к запуску не меняются.

const TIMETABLE = {
  1: ['Алгебра', 'Українська мова', 'Фізика', 'Історія України', 'Англійська мова', 'Фізична культура'],
  2: ['Геометрія', 'Хімія', 'Українська література', 'Біологія', 'Алгебра', 'Інформатика'],
  3: ['Англійська мова', 'Фізика', 'Алгебра', 'Географія', 'Українська мова', 'Історія України', 'Фізична культура'],
  4: ['Хімія', 'Геометрія', 'Зарубіжна література', 'Біологія', 'Інформатика', 'Алгебра'],
  5: ['Фізика', 'Українська мова', 'Англійська мова', 'Географія', 'Геометрія'],
};
const STARTS = ['08:30', '09:25', '10:25', '11:25', '12:20', '13:15', '14:10'];
const TEACHERS = {
  'Алгебра': 'Коваленко О. М.', 'Геометрія': 'Коваленко О. М.', 'Фізика': 'Шевчук І. В.', 'Хімія': 'Мельник Т. П.',
  'Українська мова': 'Бондаренко Н. С.', 'Українська література': 'Бондаренко Н. С.', 'Зарубіжна література': 'Ткаченко Л. А.',
  'Історія України': 'Кравченко В. Д.', 'Англійська мова': 'Олійник Ю. Р.', 'Біологія': 'Мороз С. І.',
  'Географія': 'Мороз С. І.', 'Інформатика': 'Лисенко А. О.', 'Фізична культура': 'Савченко Д. Г.',
};
const ROOMS = {
  'Алгебра': '214', 'Геометрія': '214', 'Фізика': '305', 'Хімія': '308', 'Українська мова': '112', 'Українська література': '112',
  'Зарубіжна література': '115', 'Історія України': '201', 'Англійська мова': '120', 'Біологія': '310', 'Географія': '310',
  'Інформатика': '401', 'Фізична культура': 'спортзал',
};

const todayIso = () => new Date().toISOString().slice(0, 10);
function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const weekday = (iso) => new Date(`${iso}T00:00:00Z`).getUTCDay(); // 1 = понедельник
const subjectsOn = (iso) => TIMETABLE[weekday(iso)] ?? [];

/** Число 0..n-1, зависящее только от строки. */
function pick(str, n) {
  let h = 2166136261;
  for (const ch of str) h = Math.imul(h ^ ch.codePointAt(0), 16777619) >>> 0; // FNV-1a
  return (h >>> 8) % n;
}

/** Дата k-го урока по предмету после сегодняшнего дня (k > 0) или до него (k < 0). */
function lessonDate(subject, k) {
  const step = k > 0 ? 1 : -1;
  let date = todayIso();
  for (let left = Math.abs(k), guard = 0; left > 0 && guard < 60; guard++) {
    date = addDays(date, step);
    if (subjectsOn(date).includes(subject)) left--;
  }
  return date;
}

let tick = 0;

export async function login(username) {
  await new Promise((r) => setTimeout(r, 1200)); // настоящий вход тоже не мгновенный
  if (username === 'wrong') throw Object.assign(new Error('Невірний логін або пароль'), { code: 'bad_credentials' });
  return { demo: true, studentName: 'Демо Учень', schoolName: 'Демо-ліцей' };
}

function makeLessons(from, to) {
  const today = todayIso();
  const lessons = [];
  for (let date = from; date <= to; date = addDays(date, 1)) {
    subjectsOn(date).forEach((subject, i) => {
      const thisWeek = Math.abs((new Date(date) - new Date(today)) / 86400000) < 7;
      let status = 'normal', reason = null, shown = subject;
      if (thisWeek && weekday(date) === 5 && i === 4) { status = 'canceled'; reason = 'Вчитель на курсах'; }
      if (thisWeek && weekday(date) === 3 && i === 3) { status = 'replacement'; shown = 'Хімія'; }
      lessons.push({
        id: `${date}-${i + 1}`, date, number: i + 1, start: STARTS[i], duration: 45, subject: shown,
        room: ROOMS[shown] ?? null, teacher: TEACHERS[shown] ?? null,
        topic: date <= today ? `Тема уроку ${pick(date + subject, 30) + 1}` : null, status, reason,
      });
    });
  }
  return lessons;
}

function makeGrades(lessons) {
  const today = todayIso();
  const grades = [];
  for (const l of lessons) {
    if (l.date > today || l.status === 'canceled') continue;
    const roll = pick(`g${l.id}`, 20);
    const base = { subject: l.subject, date: l.date, lessonDate: l.date, topic: l.topic, comment: null };
    if (roll < 5) {
      const value = 6 + pick(`v${l.id}`, 7); // 6..12
      const type = ['Урок', 'Урок', 'Практична робота', 'Самостійна робота', 'Контрольна робота'][pick(`k${l.id}`, 5)];
      grades.push({ ...base, id: `g-${l.id}`, label: String(value), value, kind: 'current', type });
    } else if (roll === 5) {
      const value = 7 + pick(`t${l.id}`, 5);
      grades.push({ ...base, id: `t-${l.id}`, label: String(value), value, kind: 'summary', type: 'Тематична' });
    } else if (roll === 6 && pick(`m${l.id}`, 3) === 0) {
      grades.push({ ...base, id: `m-${l.id}`, label: 'Н', value: null, kind: 'missing', type: null });
    }
  }
  return grades;
}

// ---------- ответы на задания (хранятся в памяти) ----------
const answers = new Map();
let nextFileId = 1000;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
function answerOf(id) {
  if (!answers.has(id)) {
    answers.set(id, {
      status: 'todo', answerId: null, text: '', submittedAt: null, teacherComment: null, files: [],
      teacherFiles: id === '103' ? [{ id: 900, name: 'Зразок хронологічної таблиці.docx', size: 48213 }] : [],
    });
  }
  return answers.get(id);
}
Object.assign(answerOf('106'), { status: 'submitted', answerId: 1, text: 'Розв’язання у файлі', submittedAt: new Date(Date.now() - 86400000).toISOString(),
  files: [{ id: 990, name: 'geometry-318.jpg', size: 734003 }] });
Object.assign(answerOf('109'), { status: 'checked', answerId: 2, text: 'Прочитав, відгук написав у зошиті.', submittedAt: new Date(Date.now() - 3 * 86400000).toISOString(),
  teacherComment: 'Добре, але відгук варто було здати сюди.' });

export async function getAnswer(_session, id) {
  await pause(300);
  return structuredClone(answerOf(String(id)));
}
export async function uploadAnswerFile(_session, id, file, name) {
  await pause(700);
  const a = answerOf(String(id));
  if (a.status === 'checked') throw Object.assign(new Error('Вчитель уже перевірив роботу — змінювати відповідь не можна'), { code: 'answer_locked' });
  a.files.push({ id: nextFileId++, name, size: file.size });
  return a.files[a.files.length - 1].id;
}
export async function removeAnswerFile(_session, id, fileId) {
  await pause(300);
  const a = answerOf(String(id));
  a.files = a.files.filter((f) => f.id !== Number(fileId));
}
export async function submitAnswer(_session, id, text) {
  await pause(600);
  const a = answerOf(String(id));
  if (a.status === 'checked') throw Object.assign(new Error('Вчитель уже перевірив роботу — змінювати відповідь не можна'), { code: 'answer_locked' });
  Object.assign(a, { status: 'submitted', answerId: a.answerId ?? 3, text: String(text ?? '').trim(), submittedAt: new Date().toISOString() });
  return structuredClone(a);
}

export async function openFile(_session, id, fileId) {
  const a = answerOf(String(id));
  const file = [...a.files, ...a.teacherFiles].find((f) => f.id === Number(fileId));
  if (!file) throw Object.assign(new Error('Файл не знайдено'), { code: 'file_missing' });
  const res = new Response(`Демо-файл «${file.name}»\n`);
  return { name: file.name, mime: 'text/plain', size: null, body: res.body };
}

export async function fetchYear() {
  const today = todayIso();
  const y = Number(today.slice(0, 4)) - (today.slice(5, 7) >= '08' ? 0 : 1);
  return { start: `${y}-09-01`, end: `${y + 1}-05-31`, semester2: `${y + 1}-01-12` };
}

function makeTasks() {
  const task = (id, subject, text, dueK, extra = {}) => ({
    id, subject, text, topic: null,
    // как в настоящем дневнике: сданным считается задание с ответом или файлами ученика
    files: answerOf(id).files.length,
    answered: answerOf(id).status !== 'todo' || answerOf(id).files.length > 0,
    due: lessonDate(subject, dueK),
    assigned: lessonDate(subject, dueK > 0 ? -1 : dueK - 1),
    ...extra,
  });
  const tasks = [
    task('101', 'Алгебра', '§12, № 245, 247, 251', 1, { topic: 'Квадратні рівняння' }),
    task('102', 'Українська мова', 'Вправа 134 (письмово), вивчити правило на с. 87', 1),
    task('103', 'Історія України', 'Опрацювати §9, скласти хронологічну таблицю', 1, { topic: 'Козацька доба' }),
    task('104', 'Англійська мова', 'Workbook p. 34 ex. 2–4. Тест: https://example.com/test/start/abc123', 1),
    task('105', 'Фізика', 'Задачі 8.3, 8.7; підготуватися до лабораторної', -1, { topic: 'Закони Ньютона' }),
    task('106', 'Геометрія', '№ 318, 322', -1),
    task('107', 'Біологія', 'Конспект §14, намалювати будову клітини', 1),
    task('110', 'Фізична культура', '', 1), // без текста: учитель задал устно, но ответ прикрепить можно
    task('109', 'Зарубіжна література', 'Прочитати повість і написати короткий відгук: https://example.com/povist', -1),
  ];
  // Со второй синхронизации «учитель» добавляет задание задним числом.
  if (tick > 1) tasks.push(task('108', 'Хімія', 'Розв’язати задачі 1–5 на с. 61', -1));
  return tasks;
}

export async function fetchDiary(_session, from, to) {
  tick += 1;
  await new Promise((r) => setTimeout(r, 1500)); // как настоящий дневник: не мгновенно
  const lessons = makeLessons(from, to);
  const grades = makeGrades(lessons);
  // Со второй синхронизации появляется новая оценка — так проверяются уведомления.
  if (tick > 1) {
    const date = lessonDate('Алгебра', -1);
    grades.push({ id: 'g-new', subject: 'Алгебра', date, lessonDate: date, label: '11', value: 11, kind: 'current', type: 'Урок', topic: null, comment: 'Молодець!' });
  }
  return { tasks: makeTasks(), lessons, grades };
}
