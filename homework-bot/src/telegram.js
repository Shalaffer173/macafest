// Минимальный клиент Telegram Bot API на long polling, без зависимостей.
export function createBot(token, { publicUrl, onDelete }) {
  const base = `https://api.telegram.org/bot${token}`;

  async function call(method, body, timeout = 15000) {
    const res = await fetch(`${base}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(timeout),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(`Telegram ${method}: ${data.description}`);
    return data.result;
  }

  const openButton = { inline_keyboard: [[{ text: '📋 Відкрити список', web_app: { url: publicUrl } }]] };

  async function send(chatId, text, withButton = false) {
    try {
      await call('sendMessage', { chat_id: chatId, text, ...(withButton ? { reply_markup: openButton } : {}) });
    } catch (e) {
      console.error(`[tg] не удалось отправить ${chatId}:`, e.message); // например, бота заблокировали
    }
  }

  async function handle(update) {
    const msg = update.message;
    if (!msg?.text || msg.chat.type !== 'private') return;
    const cmd = msg.text.split(/[\s@]/)[0];
    if (cmd === '/start' || cmd === '/help') {
      await send(msg.chat.id,
        'Привіт! Я показую домашку, розклад і оцінки з «Єдиної Школи» в одному місці: ' +
        'завдання списком із галочками, здача відповіді прямо звідси, сповіщення про нові завдання й оцінки.\n\n' +
        'Пароль від щоденника я не зберігаю: він потрібен один раз для входу, далі працює тимчасовий токен.\n\n' +
        '/delete — стерти всі мої дані', true);
    } else if (cmd === '/delete') {
      onDelete(msg.from.id);
      await send(msg.chat.id, 'Готово: токен і список завдань стерто. Щоб почати знову, надішли /start.');
    } else {
      await send(msg.chat.id, 'Відкрий список кнопкою нижче.', true);
    }
  }

  async function poll() {
    let offset = 0;
    await call('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Домашка', web_app: { url: publicUrl } } }).catch((e) => console.error('[tg]', e.message));
    for (;;) {
      try {
        const updates = await call('getUpdates', { offset, timeout: 50, allowed_updates: ['message'] }, 60000);
        for (const u of updates) {
          offset = u.update_id + 1;
          await handle(u).catch((e) => console.error('[tg] handle:', e.message));
        }
      } catch (e) {
        console.error('[tg] poll:', e.message);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  return { send, poll };
}
