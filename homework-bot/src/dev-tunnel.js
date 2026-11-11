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

function startBot(url) {
  if (url === currentUrl) return;
  currentUrl = url;
  const launch = () => {
    console.log(`\n[tunnel] адрес: ${url}\n[tunnel] запускаю бота; открывай приложение кнопкой меню «Домашка»`);
    bot = spawn(process.execPath, ['--env-file-if-exists=.env', 'src/server.js'], {
      stdio: 'inherit',
      env: { ...process.env, PUBLIC_URL: url, PORT: port },
    });
    bot.on('exit', () => { bot = null; });
  };
  if (bot) { bot.once('exit', launch); bot.kill(); } else launch();
}

function startTunnel() {
  console.log('[tunnel] подключаюсь…');
  const t = spawn(tunnelCmd, { shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const onData = (chunk) => {
    const m = /https:\/\/[a-z0-9-]+\.lhr\.life/.exec(String(chunk));
    if (m) startBot(m[0]);
  };
  t.stdout.on('data', onData);
  t.stderr.on('data', onData);
  t.on('exit', () => {
    if (stopping) return;
    console.log('[tunnel] соединение оборвалось, переподключаюсь через 3 с');
    setTimeout(startTunnel, 3000);
  });
  process.once('SIGINT', () => { stopping = true; t.kill(); bot?.kill(); setTimeout(() => process.exit(0), 300); });
}

startTunnel();
