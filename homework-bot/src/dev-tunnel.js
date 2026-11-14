// Запуск бота на своём компьютере через бесплатный тоннель localhost.run: npm run tunnel
//
// Бот запускается сразу — чат (команды, уведомления, синхронизация) тоннель не нужен.
// Тоннель нужен только для мини-приложения: как только он даёт адрес, бот перезапускается
// с ним и обновляет кнопку меню «Домашка». Пока адреса нет, бот работает со старым адресом
// (из прошлого запуска) — кнопка может не открываться, но чат отвечает.
//
// Тоннель часто меняет адрес и обрывается; скрипт сам переподключается.
// Для постоянной работы нужен хостинг, а не тоннель.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// Служба запускает этот скрипт без .env — читаем его сами (значения из окружения важнее).
try { process.loadEnvFile('.env'); } catch { /* файла нет — работаем по умолчанию */ }

const port = process.env.PORT || '8080';
// TUNNEL=none — тоннель не нужен: адрес постоянный (Tailscale Funnel, свой сервер) и задан в PUBLIC_URL.
const noTunnel = process.env.TUNNEL === 'none';
// Сколько ждать адрес от тоннеля, прежде чем считать попытку неудачной (после сна или перезагрузки
// сеть поднимается не сразу, и ssh может висеть минутами без ответа).
const waitSec = Number(process.env.TUNNEL_WAIT || 45);
const tunnelCmd = process.env.TUNNEL_CMD // для проверки скрипта без сети
  || `ssh -o ConnectTimeout=15 -o ServerAliveInterval=30 -o ServerAliveCountMax=2 -o StrictHostKeyChecking=accept-new -o ExitOnForwardFailure=yes -R 80:localhost:${port} nokey@localhost.run`;

// Последний адрес тоннеля храним рядом с базой, чтобы после перезапуска сразу было с чем стартовать.
const urlFile = `${dirname(process.env.DB_PATH || './data/bot.sqlite')}/tunnel-url`;
function savedUrl() {
  try { return readFileSync(urlFile, 'utf8').trim() || null; } catch { return null; }
}
function saveUrl(url) {
  try { mkdirSync(dirname(urlFile), { recursive: true }); writeFileSync(urlFile, url); } catch { /* не страшно */ }
}

let bot = null;
let currentUrl = null;
let stopping = false;
let botRestarts = 0;

function launch() {
  console.log(`\n[tunnel] запускаю бота, адрес приложения: ${currentUrl}`);
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
}

/** Запускает бота с адресом или перезапускает, если адрес сменился. */
function useUrl(url) {
  if (url === currentUrl && bot) return;
  currentUrl = url;
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
  let gotUrl = false;
  // Своя группа процессов: при обрыве убиваем и оболочку, и сам ssh, чтобы он не остался висеть.
  const child = spawn(tunnelCmd, { shell: true, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.killAll = () => { try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill(); } };
  tunnel = child;
  // Адреса нет слишком долго — обрываем попытку, она перезапустится с паузой.
  const watchdog = setTimeout(() => {
    if (!gotUrl) { lastLine = `адреса не дочекався за ${waitSec} с${lastLine ? `; ssh написав: ${lastLine}` : ', ssh нічого не написав'}`; child.killAll(); }
  }, waitSec * 1000);
  const onData = (chunk) => {
    const text = String(chunk);
    const m = /https:\/\/[a-z0-9-]+\.lhr\.life/.exec(text);
    if (m) {
      gotUrl = true;
      clearTimeout(watchdog);
      console.log(`[tunnel] адрес: ${m[0]}`);
      saveUrl(m[0]);
      useUrl(m[0]);
    }
    // Последняя строка вывода ssh — обычно это и есть причина обрыва.
    const line = text.split('\n').map((l) => l.trim()).filter(Boolean).pop();
    if (line && !/^[█▀▄ ]+$/.test(line)) lastLine = line.slice(0, 200);
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('exit', (code) => {
    clearTimeout(watchdog);
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
  tunnel?.killAll();
  bot?.kill();
  setTimeout(() => process.exit(0), 300);
}

if (noTunnel) {
  if (!process.env.PUBLIC_URL) { console.error('[tunnel] TUNNEL=none, но в .env нет PUBLIC_URL — кнопка приложения не заработает'); }
  currentUrl = process.env.PUBLIC_URL || 'https://example.invalid';
  console.log('[tunnel] тоннель выключен (TUNNEL=none), постоянный адрес из .env');
  launch();
} else {
  // Бот — сразу, со старым адресом (или с адресом из .env), тоннель — параллельно.
  currentUrl = savedUrl() || process.env.PUBLIC_URL || 'https://example.invalid';
  launch();
  startTunnel();
}
