import type { BotSettingsMessages } from './uz';

// First draft: needs a native-speaker review.
export const botSettingsEn: BotSettingsMessages = {
  title: 'Bot settings',
  subtitle: 'The Telegram bot connection, how it looks and the messages it sends.',
  connection: {
    title: 'Connection details',
    subtitle: 'What this app knows about the bot',
    token: 'API key (token)',
    tokenHidden: 'The token is kept on the server only and is never shown on this page.',
    username: 'Bot username',
    usernameMissing: 'Not configured in this app',
    openBot: 'Open in Telegram',
    checkUnavailable:
      'The server does not report the webhook state or a connection check yet, so they are not shown here.',
  },
  appearance: {
    title: 'Bot profile',
    subtitle: 'The name, picture and description shown in Telegram',
    unavailable:
      "The bot's name, picture and description cannot be changed on this page: they are changed through {'@'}BotFather in Telegram.",
  },
  own: {
    title: 'Your connection',
    subtitle: 'Whether the bot can message you privately',
  },
  rules: {
    title: 'Order notifications',
    subtitle: 'Who is told what and when is set by the system rules and is not changed here',
    fixed: 'Rule',
    staff: {
      title: 'Private message to staff',
      body: 'Every staff member except an administrator, about every order update that concerns their role, with two buttons that open the order.',
    },
    customer: {
      title: "To the customer's group",
      body: 'When a staff member approves, rejects, cancels, releases or delivers an order: with the order number, status, total and reason.',
    },
  },
};
