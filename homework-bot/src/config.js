import { randomBytes } from 'node:crypto';

const env = process.env;
export const DEMO = env.DEMO === '1';

function need(name) {
  const v = env[name];
  if (!v && !DEMO) throw new Error(`Не задана переменная окружения ${name} (см. .env.example)`);
  return v || '';
}

export const config = {
  demo: DEMO,
  botToken: need('BOT_TOKEN'),
  publicUrl: (need('PUBLIC_URL') || 'http://localhost:8080').replace(/\/+$/, ''),
  // В демо-режиме ключ случайный: данные всё равно вымышленные.
  secretKey: need('SECRET_KEY') || randomBytes(32).toString('hex'),
  port: Number(env.PORT || 8080),
  dbPath: env.DB_PATH || (DEMO ? ':memory:' : './data/bot.sqlite'),
  syncMinutes: Math.max(10, Number(env.SYNC_MINUTES || 30)),
  daysBack: 35, // сколько дней назад перечитывать, чтобы ловить задания задним числом
  fullSyncHours: 24, // как часто перечитывать весь учебный год с 1 сентября
  daysForward: 14,
};

if (!/^[0-9a-f]{64}$/i.test(config.secretKey)) {
  throw new Error('SECRET_KEY должен быть 64 hex-символа (openssl rand -hex 32)');
}
