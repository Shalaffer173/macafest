// Проверка связи с «Єдиною Школою» без Telegram и сервера: npm run check
// Спрашивает логин и пароль, входит и печатает задания, расписание и оценки. Ничего не сохраняет.
import { createInterface } from 'node:readline';
import { login, fetchDiary, setTrace } from './eschool.js';

setTrace((m) => console.log(`   · ${m}`));

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

  console.log('2. Загрузка дневника за 2 недели назад и 2 вперёд…');
  const { tasks, lessons, grades, debug } = await fetchDiary(session, shift(-14), shift(14));
  console.log(`   OK: заданий ${tasks.length} (с ответом ученика ${tasks.filter((t) => t.answered).length}), уроков ${lessons.length}, оценок и пропусков ${grades.length}`);

  const today = shift(0);
  // Задания без даты: сколько их и откуда они пришли — чтобы понять, как их хранит этот дневник.
  console.log(`   задания без даты: ${JSON.stringify(debug.undated)}, вложение Homework: ${debug.embedHomework}`);
  for (const t of tasks.filter((x) => x.undated)) {
    console.log(`   · без даты: ${t.subject}, задано ${t.assigned}, ближайший урок ${t.due}${t.fromTopic ? ' (из темы урока)' : ''}: ${t.text.replace(/\s+/g, ' ').slice(0, 60)}`);
  }
  console.log(`\n3. Расписание на сегодня (${today}):`);
  const todays = lessons.filter((l) => l.date === today).sort((a, b) => (a.number ?? 99) - (b.number ?? 99));
  if (!todays.length) console.log('   уроков нет');
  for (const l of todays) {
    console.log(`   ${l.number ?? '-'}. ${l.start ?? '--:--'} (${l.duration} мин) ${l.subject} | каб. ${l.room ?? '-'} | ${l.teacher ?? '-'} | ${l.status}`);
  }

  console.log('\n4. Последние оценки:');
  for (const g of grades.sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 8)) {
    console.log(`   ${g.date} ${g.subject}: ${g.label} [${g.kind}${g.type ? `, ${g.type}` : ''}${g.value != null ? `, число ${g.value}` : ''}]`);
  }

  console.log('\n5. Задания:');
  for (const t of tasks.sort((a, b) => (a.due < b.due ? -1 : 1))) {
    console.log(`   ${t.due} ${t.answered ? '✓' : ' '} ${t.subject}: ${t.text.replace(/\s+/g, ' ').slice(0, 80)}`);
  }
  console.log('\nВсё работает.');
} catch (e) {
  console.error(`\nНе получилось: [${e.code ?? e.name}] ${e.message}`);
  console.error('Пришли этот вывод целиком — пароля в нём нет.');
  process.exitCode = 1;
}
