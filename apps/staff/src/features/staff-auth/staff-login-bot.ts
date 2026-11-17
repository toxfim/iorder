import { parseBotUsername, TELEGRAM_BOT_USERNAME } from '@core/app/env';

/**
 * The bot of the Login Widget on the STAFF login page. Telegram allows one widget domain per bot,
 * so the staff site may use its own login bot (VITE_STAFF_TELEGRAM_BOT_USERNAME); unset, the main
 * bot as before. Bot linking and notifications always use TELEGRAM_BOT_USERNAME. Lives in the
 * staff app (not web-core) so the customer bundle never carries the staff bot's name.
 */
export const STAFF_TELEGRAM_BOT_USERNAME: string | null =
  parseBotUsername(import.meta.env.VITE_STAFF_TELEGRAM_BOT_USERNAME) ?? TELEGRAM_BOT_USERNAME;
