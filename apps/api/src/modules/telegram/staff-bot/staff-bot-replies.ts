import type { Locale } from '@iorder/shared';
import type { MessageButton } from '../telegram-sender.js';

// The staff bot's answer to `/start` [owner 2026-11-10: a greeting such as "Xayrli tong, <name>"
// and two buttons in one row, "open in the browser" without a colour and "open in the app" in
// blue]. Pure: the caller passes the Tashkent hour, the person and the staff app address.

export type PartOfDay = 'MORNING' | 'DAY' | 'EVENING';

/**
 * [P] Morning 05:00-10:59, day 11:00-17:59, evening 18:00-04:59 (Tashkent). There is no "night"
 * greeting: "Xayrli tun" says good night, a farewell, so late hours get the evening one.
 */
export function partOfDay(tashkentHour: number): PartOfDay {
  if (tashkentHour >= 5 && tashkentHour < 11) return 'MORNING';
  if (tashkentHour >= 11 && tashkentHour < 18) return 'DAY';
  return 'EVENING';
}

/**
 * The name a greeting uses: the first word of the stored full name ("Sardor Aliyev" -> "Sardor").
 * Null for a blank name, so the greeting simply has no name.
 */
export function greetingName(fullName: string | null | undefined): string | null {
  const first = (fullName ?? '').trim().split(/\s+/)[0] ?? '';
  return first === '' ? null : first;
}

interface StaffBotTexts {
  greeting: Record<PartOfDay, string>;
  openApp: string;
  noAddress: string;
  browserButton: string;
  appButton: string;
  notStaff: string;
  /** What each command does [C, owner 2026-11-13: explained after the language is chosen]. */
  commands: string;
}

const TEXTS: Record<Locale, StaffBotTexts> = {
  UZ: {
    greeting: { MORNING: 'Xayrli tong', DAY: 'Xayrli kun', EVENING: 'Xayrli kech' },
    openApp: 'iOrder ilovasini oching:',
    noAddress: 'Ilova manzili hali sozlanmagan. Administratorga murojaat qiling.',
    browserButton: 'Brauzerda ochish',
    appButton: 'Ilovada ochish',
    notStaff: 'Bu bot faqat iOrder xodimlari uchun.',
    commands:
      "Buyruqlar:\n/start: tilni tanlash va ilovani ochish\n/lang: tilni o'zgartirish\n/help: ilova tugmalari va shu yordam",
  },
  RU: {
    greeting: { MORNING: 'Доброе утро', DAY: 'Добрый день', EVENING: 'Добрый вечер' },
    openApp: 'Откройте приложение iOrder:',
    noAddress: 'Адрес приложения ещё не настроен. Обратитесь к администратору.',
    browserButton: 'Открыть в браузере',
    appButton: 'Открыть в приложении',
    notStaff: 'Этот бот только для сотрудников iOrder.',
    commands:
      'Команды:\n/start: выбор языка и открытие приложения\n/lang: сменить язык\n/help: кнопки приложения и эта справка',
  },
  EN: {
    greeting: { MORNING: 'Good morning', DAY: 'Good afternoon', EVENING: 'Good evening' },
    openApp: 'Open the iOrder app:',
    noAddress: 'The app address is not set up yet. Please contact an administrator.',
    browserButton: 'Open in browser',
    appButton: 'Open in the app',
    notStaff: 'This bot is for iOrder staff only.',
    commands:
      'Commands:\n/start: choose the language and open the app\n/lang: change the language\n/help: the app buttons and this help',
  },
};

export interface StaffBotReply {
  text: string;
  buttons: MessageButton[];
}

export interface StaffBotReplyInput {
  locale: Locale;
  /** False for anybody who is not an active staff member: no greeting by name, no buttons. */
  isStaff: boolean;
  name: string | null;
  tashkentHour: number;
  /** The staff app's address (`STAFF_WEB_APP_URL`), null when it is not configured. */
  staffAppUrl: string | null;
}

/**
 * The reply to `/start`. A staff member gets "<greeting>, <name>!" and one row: the browser
 * button (a plain link, no colour) and the app button (a `web_app` button, blue). The `web_app`
 * launch is signed by the staff bot that sent it, which is what signs staff in. Anybody else
 * learns only that the bot is for staff; nothing about the staff app is handed out.
 */
export function staffBotStartReply(input: StaffBotReplyInput): StaffBotReply {
  const texts = TEXTS[input.locale];
  if (!input.isStaff) return { text: texts.notStaff, buttons: [] };
  const greeting = texts.greeting[partOfDay(input.tashkentHour)];
  const hello = input.name === null ? `${greeting}!` : `${greeting}, ${input.name}!`;
  // The command list sits between the greeting and the line that points at the buttons.
  const head = `${hello}\n\n${texts.commands}\n`;
  if (input.staffAppUrl === null) return { text: `${head}\n${texts.noAddress}`, buttons: [] };
  return {
    text: `${head}\n${texts.openApp}`,
    buttons: [
      { text: texts.browserButton, url: input.staffAppUrl },
      { text: texts.appButton, webAppUrl: input.staffAppUrl, style: 'primary' },
    ],
  };
}
