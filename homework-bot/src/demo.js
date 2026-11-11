// Вымышленный дневник для режима DEMO=1: позволяет посмотреть приложение без аккаунта.
const iso = (offset) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
};

let tick = 0;

export async function login() {
  return { demo: true, studentName: 'Демо Учень', schoolName: 'Демо-ліцей' };
}

export async function fetchTasks() {
  tick += 1;
  await new Promise((r) => setTimeout(r, 1500)); // как настоящий дневник: не мгновенно
  const tasks = [
    { id: '101', subject: 'Алгебра', text: '§12, № 245, 247, 251', topic: 'Квадратні рівняння', due: iso(1), assigned: iso(-1), files: 0 },
    { id: '102', subject: 'Українська мова', text: 'Вправа 134 (письмово), вивчити правило на с. 87', topic: null, due: iso(1), assigned: iso(-2), files: 0 },
    { id: '103', subject: 'Історія України', text: 'Опрацювати §9, скласти хронологічну таблицю', topic: 'Козацька доба', due: iso(2), assigned: iso(-1), files: 0 },
    { id: '104', subject: 'Англійська мова', text: 'Workbook p. 34 ex. 2–4', topic: null, due: iso(3), assigned: iso(0), files: 0 },
    { id: '105', subject: 'Фізика', text: 'Задачі 8.3, 8.7; підготуватися до лабораторної', topic: 'Закони Ньютона', due: iso(-2), assigned: iso(-5), files: 0 },
    { id: '106', subject: 'Геометрія', text: '№ 318, 322', topic: null, due: iso(-4), assigned: iso(-6), files: 0, answered: true },
    { id: '107', subject: 'Біологія', text: 'Конспект §14, намалювати будову клітини', topic: null, due: iso(5), assigned: iso(0), files: 0 },
  ];
  // Со второй синхронизации «учитель» добавляет задание задним числом.
  if (tick > 1) {
    tasks.push({ id: '108', subject: 'Хімія', text: 'Розв’язати задачі 1–5 на с. 61', topic: null, due: iso(-1), assigned: iso(-3), files: 0 });
  }
  return tasks;
}
