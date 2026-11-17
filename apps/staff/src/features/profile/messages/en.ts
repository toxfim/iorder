import type { StaffProfileMessages } from './uz';

// First draft: needs a native-speaker review.
export const staffProfileEn: StaffProfileMessages = {
  title: 'My profile',
  subtitle: 'Personal details, account security and notifications.',
  workspace: 'Workspace',
  personal: {
    title: 'Personal details',
    subtitle:
      'You change your name and phone yourself. An administrator changes your login and role.',
    name: 'Name',
    phone: 'Phone number',
    phoneMissing: 'Not entered',
    phoneLoading: 'Loading…',
    phoneError: 'Could not be read',
    retry: 'Try again',
    edit: 'Edit',
    language: 'Interface language',
    theme: 'Theme',
    timezone: 'Time zone',
    timezoneValue: 'Tashkent · UTC+05:00',
  },
  edit: {
    title: 'Edit name and phone',
    description: 'Colleagues see this name in the order history and in the staff list.',
    name: 'Full name',
    phone: 'Phone number',
    phoneHint: 'For example +998 90 123 4567. Leave it empty to remove the number.',
    save: 'Save',
    saved: 'Your details are saved',
    errors: {
      name: 'Enter your name',
      phone: 'Enter the full number, for example +998 90 123 4567',
      rateLimited: 'Too many attempts. Try again a little later.',
    },
  },
  role: {
    title: 'Your role: {roles}',
    change: 'Only an administrator changes roles.',
    describe: {
      ADMIN:
        'Configures the system and corrects a wrongly recorded payment. Performs no order steps.',
      MANAGER:
        'Approves or rejects orders, chooses the payment method, cancels orders and records organization payments.',
      ACCOUNTANT: 'Approves or rejects the orders a manager approved.',
      WAREHOUSE_MANAGER: 'Releases orders from the warehouse and assigns the driver.',
      DRIVER: 'Delivers the orders assigned to you.',
      PURCHASING_MANAGER:
        'Reads the manager pages and changes nothing. Gets bot messages about orders with marked goods.',
    },
  },
  security: {
    title: 'Security',
    subtitle: 'Signing in to your account',
    password: 'Password',
    passwordHint:
      'You cannot change your password yourself. If you need a new password or login, ask an administrator.',
  },
  bot: {
    title: 'Notifications',
    subtitle: 'Order messages reach you through the Telegram bot',
    telegram: 'Telegram account',
    botState: 'Bot',
    linked: 'Linked',
    notLinked: 'Not linked',
    connected: 'Connected',
    notConnected: 'Not connected',
    connectedHint: 'The bot writes to you about every order update that concerns your role.',
    adminNote: 'The bot sends no order messages to an administrator.',
    loadError: 'The connection state could not be read.',
    retry: 'Try again',
  },
};
