/** The grammY `Bot`, or null when no bot token is configured. */
export const TELEGRAM_BOT = Symbol('TELEGRAM_BOT');

/**
 * The sender of the STAFF bot (the staff Mini App bot), or null when no staff bot is
 * configured. Only the staff bot's `/start` reply uses it; everything else goes through
 * `TelegramSender` (the main bot).
 */
export const STAFF_BOT_SENDER = Symbol('STAFF_BOT_SENDER');

/**
 * Optional replacement for the network (see `TelegramApiTransport`). Null in production; tests
 * provide a recording fake so that nothing can reach api.telegram.org.
 */
export const TELEGRAM_API_TRANSPORT = Symbol('TELEGRAM_API_TRANSPORT');
