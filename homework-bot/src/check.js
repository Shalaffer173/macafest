// Проверка связи с «Єдиною Школою» без Telegram и сервера: npm run check
// Спрашивает логин и пароль, входит и печатает задания. Ничего не сохраняет.
import { createInterface } from 'node:readline';
import { login, fetchTasks } from './eschool.js';

function ask(question, hidden = false) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    if (hidden) {
      // Пароль не показываем на экране.
      rl._writeToOutput = (s) => { if (s.includes(question)) process.stdout.write(question); };
    }
    rl.question(question, (answer) => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(answer); });
  });
}

const shift = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

const username = (await ask('Логин ученика: ')).trim();
const password = await ask('Пароль (не отображается): ', true);

try {
  console.log('\n1. Вход…');
  const session = await login(username, password, (m) => console.log(`   ${m}`));
  console.log(`   OK: ${session.studentName ?? 'имя не получено'}, ${session.schoolName ?? 'школа не получена'}`);

  console.log('2. Загрузка заданий за 2 недели назад и 2 вперёд…');
  const tasks = await fetchTasks(session, shift(-14), shift(14));
  console.log(`   OK: заданий найдено ${tasks.length}`);
  for (const t of tasks.sort((a, b) => (a.due < b.due ? -1 : 1))) {
    console.log(`   ${t.due}  ${t.subject}: ${t.text.replace(/\s+/g, ' ').slice(0, 80)}`);
  }
  console.log('\nВсё работает.');
} catch (e) {
  console.error(`\nНе получилось: [${e.code ?? e.name}] ${e.message}`);
  console.error('Пришли этот вывод целиком — пароля в нём нет.');
  process.exitCode = 1;
}
