// Запуск бота на своём компьютере через бесплатный тоннель localhost.run: npm run tunnel
// Тоннель часто меняет адрес и обрывается. Этот скрипт сам переподключается, ловит новый
// адрес и перезапускает бота с ним. Бот при старте обновляет кнопку меню «Домашка»,
// поэтому открывать приложение нужно этой кнопкой, а не старыми сообщениями.
// Для постоянной работы нужен хостинг, а не тоннель.
import { spawn } from 'node:child_process';

const port = process.env.PORT || '8080';
const tunnelCmd = process.env.TUNNEL_CMD // для проверки скрипта без сети
  || `ssh -o ServerAliveInterval=30 -o ServerAliveCountMax=2 -o StrictHostKeyChecking=accept-new -o ExitOnForwardFailure=yes -R 80:localhost:${port} nokey@localhost.run`;

let bot = null;
let currentUrl = null;
let stopping = false;

let botRestarts = 0;

function startBot(url) {
  if (url === currentUrl) return;
  currentUrl = url;
  const launch = () => {
    console.log(`\n[tunnel] адрес: ${currentUrl}\n[tunnel] запускаю бота; открывай приложение кнопкой меню «Домашка»`);
    const child = spawn(process.execPath, ['--env-file-if-exists=.env', 'src/server.js'], {
      stdio: 'inherit',
      env: { ...process.env, PUBLIC_URL: currentUrl, PORT: port },
    });
    const startedAt = Date.now();
    bot = child;
    child.on('exit', (code, signal) => {
      if (bot === child) bot = null;
      // Бот упал сам (а не мы его остановили ради нового адреса): перезапускаем, иначе тоннель
      // жив, служба «работает», а бот молчит. Пауза растёт, если он падает сразу после запуска.
      if (stopping || child.replaced) return;
      botRestarts = Date.now() - startedAt > 60_000 ? 0 : botRestarts + 1;
      const wait = Math.min(5 * 2 ** botRestarts, 300);
      console.error(`[tunnel] бот завершился (код ${code ?? signal}), перезапускаю через ${wait} с`);
      setTimeout(() => { if (!bot && !stopping) launch(); }, wait * 1000);
    });
  };
  if (bot) { bot.replaced = true; bot.once('exit', launch); bot.kill(); } else launch();
}

// Пауза перед переподключением растёт от 5 секунд до 5 минут: если стучаться каждые
// несколько секунд, сервис тоннелей начинает отказывать совсем.
let delay = 5;
let tunnel = null;

function startTunnel() {
  console.log('[tunnel] подключаюсь…');
  const startedAt = Date.now();
  let lastLine = '';
  tunnel = spawn(tunnelCmd, { shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const onData = (chunk) => {
    const text = String(chunk);
    const m = /https:\/\/[a-z0-9-]+\.lhr\.life/.exec(text);
    if (m) startBot(m[0]);
    // Последняя строка вывода ssh — обычно это и есть причина обрыва.
    const line = text.split('\n').map((l) => l.trim()).filter(Boolean).pop();
    if (line && !/^[█▀▄ ]+$/.test(line)) lastLine = line.slice(0, 200);
  };
  tunnel.stdout.on('data', onData);
  tunnel.stderr.on('data', onData);
  tunnel.on('exit', (code) => {
    if (stopping) return;
    // Соединение продержалось больше минуты — считаем его удачным и начинаем отсчёт заново.
    delay = Date.now() - startedAt > 60_000 ? 5 : Math.min(delay * 2, 300);
    console.log(`[tunnel] соединение оборвалось (код ${code}${lastLine ? `, ответ: ${lastLine}` : ''}), переподключаюсь через ${delay} с`);
    setTimeout(startTunnel, delay * 1000);
  });
}

process.once('SIGINT', stop);
process.once('SIGTERM', stop);
function stop() {
  stopping = true;
  tunnel?.kill();
  bot?.kill();
  setTimeout(() => process.exit(0), 300);
}

startTunnel();
