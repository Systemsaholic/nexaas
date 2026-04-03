/**
 * Telegram Bridge helper for sending PA notifications.
 * Posts to the local Telegram bridge service at 127.0.0.1:8420.
 *
 * Client-side dedup: skips sending if the same (user, title) was sent in
 * the last 14 minutes. The bridge has its own dedup too (belt + suspenders).
 */

const TELEGRAM_BRIDGE_URL =
  process.env.TELEGRAM_BRIDGE_URL || "http://127.0.0.1:8420";

// Client-side dedup cache: key -> timestamp
const _notifyCache = new Map<string, number>();
const DEDUP_WINDOW_MS = 14 * 60 * 1000; // 14 minutes

export interface NotifyOptions {
  user: string;
  type: "briefing" | "alert" | "approval" | "digest";
  title: string;
  body: string;
  buttons?: Array<{ text: string; callback_data: string }>;
  priority?: "normal" | "urgent";
  session_context?: string;
  session_type?: string;
  /** Set true to bypass client-side dedup (e.g. approval callbacks). */
  skipDedup?: boolean;
}

export async function notifyTelegram(options: NotifyOptions): Promise<boolean> {
  // Client-side dedup
  if (!options.skipDedup) {
    const key = `${options.user}:${options.title}`;
    const now = Date.now();
    const lastSent = _notifyCache.get(key) ?? 0;
    if (now - lastSent < DEDUP_WINDOW_MS) {
      console.log(`Dedup: skipping duplicate notification for ${key}`);
      return true; // Treat as success — the notification was already sent
    }
    _notifyCache.set(key, now);
    // Prune old entries
    for (const [k, ts] of _notifyCache) {
      if (now - ts > DEDUP_WINDOW_MS * 2) _notifyCache.delete(k);
    }
  }

  try {
    const resp = await fetch(`${TELEGRAM_BRIDGE_URL}/api/pa/notify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(options),
    });
    return resp.ok;
  } catch (err) {
    console.error("Failed to notify Telegram:", err);
    return false;
  }
}
