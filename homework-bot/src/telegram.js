// Минимальный клиент Telegram Bot API на long polling, без зависимостей.
//
// commands: { '/today': { description, run: async (tgId) => ({ text, button }) }, ... }
// Команды с description показываются в меню бота.
// onMessage(from) вызывается на каждое личное сообщение — чтобы знать, кто запускал бота.
export function createBot(token, { publicUrl, commands = {}, onMessage }) {
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

  const openButton = { inline_keyboard: [[{ text: '📋 Відкрити щоденник', web_app: { url: publicUrl } }]] };

  async function send(chatId, text, withButton = false) {
    try {
      await call('sendMessage', { chat_id: chatId, text, ...(withButton ? { reply_markup: openButton } : {}) });
    } catch (e) {
      console.error(`[tg] не удалось отправить ${chatId}:`, e.message); // например, бота заблокировали
    }
  }

  const help = () => [
    'Привіт! Я показую домашку, розклад і оцінки з «Єдиної Школи» в одному місці: ' +
    'завдання списком із галочками, здача відповіді прямо звідси, сповіщення про нові завдання й оцінки.',
    'Пароль від щоденника я не зберігаю: він потрібен один раз для входу, далі працює тимчасовий токен.',
    Object.entries(commands).filter(([, c]) => c.description).map(([name, c]) => `${name} — ${c.description}`).join('\n'),
  ].join('\n\n');

  async function handle(update) {
    const msg = update.message;
    if (!msg?.text || msg.chat.type !== 'private') return;
    onMessage?.(msg.from);
    const cmd = msg.text.split(/[\s@]/)[0].toLowerCase();
    if (cmd === '/start' || cmd === '/help') return send(msg.chat.id, help(), true);
    if (commands[cmd]) {
      const { text, button = false } = await commands[cmd].run(msg.from.id);
      return send(msg.chat.id, text, button);
    }
    return send(msg.chat.id, 'Відкрий щоденник кнопкою нижче або надішли /help.', true);
  }

  async function poll() {
    let offset = 0;
    const warn = (e) => console.error('[tg]', e.message);
    await call('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Домашка', web_app: { url: publicUrl } } }).catch(warn);
    await call('setMyCommands', {
      commands: Object.entries(commands).filter(([, c]) => c.description).map(([name, c]) => ({ command: name.slice(1), description: c.description })),
    }).catch(warn);
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

  return { send, poll, handle };
}
