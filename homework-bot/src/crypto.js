import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** AES-256-GCM. Формат: base64(iv[12] | tag[16] | ciphertext). */
export function encrypt(plain, keyHex) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv);
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
}

export function decrypt(blob, keyHex) {
  const buf = Buffer.from(blob, 'base64');
  const d = createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
}

/**
 * Проверка initData из Telegram Mini App.
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 * Возвращает объект пользователя или null.
 */
export function verifyInitData(initData, botToken, maxAgeSec = 86400, now = Date.now()) {
  if (!initData || !botToken) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const checkString = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = createHmac('sha256', secret).update(checkString).digest();
  let given;
  try { given = Buffer.from(hash, 'hex'); } catch { return null; }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const authDate = Number(params.get('auth_date'));
  if (!authDate || now / 1000 - authDate > maxAgeSec) return null;
  try {
    const user = JSON.parse(params.get('user') || 'null');
    return user && Number.isInteger(user.id) ? user : null;
  } catch { return null; }
}

/**
 * Короткоживущая подписанная ссылка: payload (объект) + срок действия, заверенные ключом сервера.
 * Нужна там, где нельзя передать подпись Telegram в заголовке, — например, при скачивании файла браузером.
 */
export function signToken(payload, keyHex, ttlSec, now = Date.now()) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(now / 1000) + ttlSec })).toString('base64url');
  const mac = createHmac('sha256', Buffer.from(keyHex, 'hex')).update(`link:${body}`).digest('base64url');
  return `${body}.${mac}`;
}

/** Возвращает payload или null, если подпись неверна или срок вышел. */
export function verifyToken(token, keyHex, now = Date.now()) {
  const [body, mac] = String(token ?? '').split('.');
  if (!body || !mac) return null;
  const expected = createHmac('sha256', Buffer.from(keyHex, 'hex')).update(`link:${body}`).digest();
  let given;
  try { given = Buffer.from(mac, 'base64url'); } catch { return null; }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' && payload.exp >= now / 1000 ? payload : null;
  } catch { return null; }
}
