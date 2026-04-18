/**
 * Telegram adapter for the PA service.
 *
 * Receives Telegram messages via webhook or polling,
 * routes them to the correct persona, and sends the response back.
 */

import { handlePaMessage, type PersonaConfig, type InboundMessage } from "./service.js";

interface TelegramMessage {
  message_id: number;
  from: { id: number; first_name: string; last_name?: string; username?: string };
  chat: { id: number; type: string };
  text?: string;
  date: number;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";

async function sendTelegramMessage(chatId: number, text: string): Promise<void> {
  if (!TELEGRAM_BOT_TOKEN) {
    console.error("[pa-telegram] No TELEGRAM_BOT_TOKEN set");
    return;
  }

  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "Markdown",
    }),
  });
}

export async function handleTelegramUpdate(
  workspace: string,
  update: TelegramUpdate,
  personaResolver: (telegramUserId: number) => PersonaConfig | null,
): Promise<void> {
  if (!update.message?.text) return;

  const msg = update.message;
  const persona = personaResolver(msg.from.id);

  if (!persona) {
    await sendTelegramMessage(msg.chat.id, "Sorry, I don't have a PA configured for you.");
    return;
  }

  const inbound: InboundMessage = {
    channel: "telegram",
    senderId: String(msg.from.id),
    senderName: [msg.from.first_name, msg.from.last_name].filter(Boolean).join(" "),
    content: msg.text ?? "",
    threadId: `telegram-${msg.chat.id}`,
  };

  // Send typing indicator
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendChatAction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: msg.chat.id, action: "typing" }),
  });

  const result = await handlePaMessage(workspace, persona, inbound);
  await sendTelegramMessage(msg.chat.id, result.response);
}

/**
 * Start Telegram polling for PA messages.
 * Simple long-polling loop — production should use webhooks.
 */
export async function startTelegramPolling(
  workspace: string,
  personaResolver: (telegramUserId: number) => PersonaConfig | null,
  pollInterval: number = 2000,
): Promise<void> {
  if (!TELEGRAM_BOT_TOKEN) {
    console.warn("[pa-telegram] No TELEGRAM_BOT_TOKEN — Telegram PA disabled");
    return;
  }

  let offset = 0;
  console.log("[pa-telegram] Polling started");

  setInterval(async () => {
    try {
      const res = await fetch(
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${offset}&timeout=1`,
      );
      const data = (await res.json()) as { ok: boolean; result: TelegramUpdate[] };

      if (!data.ok || !data.result.length) return;

      for (const update of data.result) {
        offset = update.update_id + 1;
        await handleTelegramUpdate(workspace, update, personaResolver);
      }
    } catch (err) {
      console.error("[pa-telegram] Poll error:", err);
    }
  }, pollInterval);
}
