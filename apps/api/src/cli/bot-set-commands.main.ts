import { loadEnv } from '../config/env.js';
import { createTelegramBot } from '../modules/telegram/bot-factory.js';
import { setBotMenus } from '../modules/telegram/bot-command-menu.js';

// Entry point of `pnpm --filter @iorder/api bot:set-commands -- --confirm`: sets the command menu
// of the main bot (BOT_TOKEN: /start, /lang, /price) and, when configured, of the staff bot
// (STAFF_MINI_APP_BOT_TOKEN: /start, /lang), in UZ (default), RU and EN. A deployment step, run
// once per environment after the menu changes (inside the api container:
// `node dist/cli/bot-set-commands.main.js --confirm`). It changes what the REAL bots show, hence
// `--confirm`. It prints which bots were set, never a token.
async function main(): Promise<number> {
  if (!process.argv.slice(2).includes('--confirm')) {
    console.error("bot:set-commands changes the real bots' menus. Add --confirm to proceed.");
    return 1;
  }
  const env = loadEnv();
  if (env.BOT_TOKEN === undefined) {
    console.error('BOT_TOKEN is not configured: nothing to set.');
    return 1;
  }
  await setBotMenus(createTelegramBot({ token: env.BOT_TOKEN }), 'CUSTOMER');
  console.log('Main bot: menu set (UZ default, RU, EN).');
  if (env.STAFF_MINI_APP_BOT_TOKEN !== undefined) {
    await setBotMenus(createTelegramBot({ token: env.STAFF_MINI_APP_BOT_TOKEN }), 'STAFF');
    console.log('Staff bot: menu set (UZ default, RU, EN).');
  }
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    // Telegram errors can echo request payloads: print only the error name.
    console.error(`bot:set-commands failed: ${error instanceof Error ? error.name : 'unknown'}`);
    process.exitCode = 1;
  });
