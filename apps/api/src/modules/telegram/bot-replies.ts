import type { Locale } from '@iorder/shared';

// Texts of the bot's command replies. Plain text, UZ default, RU and EN. Wording is a first
// draft for a native speaker to check (see the work log).

interface ReplyTexts {
  start: (url: string | null) => string;
  /**
   * The answer after the language was chosen in a private chat [C, owner 2026-11-13]: a greeting,
   * the app link and what each command does.
   */
  commands: (url: string | null) => string;
  priceCaption: (versionNumber: number, publishedAt: string) => string;
  priceButton: string;
  priceNoList: string;
  priceFailed: string;
  priceRefused: string;
  help: string;
  /** Answers to `/start staff_<token>` (connecting the bot for staff notifications). */
  connect: Record<
    'CONNECTED' | 'INVALID_LINK' | 'OTHER_TELEGRAM_ACCOUNT' | 'TELEGRAM_TAKEN',
    string
  >;
  /**
   * Answers to an organization invite (`/start org_<token>`) [P]. `personLinked` greets the person
   * by the name Telegram gave (the owner's UZ wording, 2026-11-11); `groupLinked` goes to the group.
   */
  invite: {
    personLinked: (name: string) => string;
    groupLinked: string;
    INVALID_LINK: string;
    WRONG_CHAT: string;
    ALREADY_MEMBER_ELSEWHERE: string;
    STAFF_ACCOUNT: string;
    USER_BLOCKED: string;
    CHAT_TAKEN: string;
  };
}

const NO_URL = {
  UZ: 'Veb-ilova manzili hali sozlanmagan. Menejerga murojaat qiling.',
  RU: 'Адрес веб-приложения ещё не настроен. Обратитесь к менеджеру.',
  EN: 'The web app address is not set up yet. Please contact your manager.',
} as const satisfies Record<Locale, string>;

const REPLIES: Record<Locale, ReplyTexts> = {
  UZ: {
    start: (url) =>
      [
        'Assalomu alaykum! iOrder.uz: buyurtmalar va narxlar tizimi.',
        url === null ? NO_URL.UZ : `Ilovani oching: ${url}`,
        '',
        'Buyruqlar: /price (narxlar), /help (yordam).',
      ].join('\n'),
    commands: (url) =>
      [
        'Assalomu alaykum! iOrder.uz: buyurtmalar va narxlar tizimi.',
        url === null ? NO_URL.UZ : `Ilovani oching: ${url}`,
        '',
        'Buyruqlar:',
        '/start: tilni tanlash va ilovaga havola',
        "/lang: tilni o'zgartirish",
        "/price: joriy narxlar ro'yxati (Excel fayl)",
        "/help: buyruqlar ro'yxati",
      ].join('\n'),
    priceCaption: (n, at) => `Joriy narxlar ro'yxati (Excel). Versiya ${n}, ${at}.`,
    priceButton: 'Ilovada ochish',
    priceNoList: "Narxlar ro'yxati hali e'lon qilinmagan.",
    priceFailed: "Narxlar faylini yuborib bo'lmadi. Keyinroq urinib ko'ring.",
    priceRefused:
      "Narxlarni faqat tashkilot a'zolari ko'ra oladi. Guruhingiz ro'yxatdan o'tganini menejerdan so'rang.",
    help: "Buyruqlar:\n/start: ilovaga havola\n/lang: tilni o'zgartirish\n/price: narxlar ro'yxati (Excel fayl)\n/help: shu yordam",
    connect: {
      CONNECTED:
        'Bildirishnomalar yoqildi. Sizga tegishli buyurtma yangilanishlari shu yerga keladi.',
      INVALID_LINK:
        'Bu havola eskirgan yoki allaqachon ishlatilgan. Ilovada "Bildirishnomani yoqish" tugmasini qayta bosing.',
      OTHER_TELEGRAM_ACCOUNT:
        "Hisobingiz boshqa Telegram akkauntiga bog'langan. O'zgartirish uchun menejerga murojaat qiling.",
      TELEGRAM_TAKEN:
        "Bu Telegram akkaunt tizimda boshqa odamga bog'langan. Menejerga murojaat qiling.",
    },
    invite: {
      personLinked: (name) =>
        `Salom, ${name}! Siz iOrder'ga ulandingiz. Narx ro'yxati va buyurtmalaringiz holati shu yerga keladi.`,
      groupLinked:
        "Guruh iOrder'ga ulandi. Narx ro'yxati va buyurtmalar holati shu guruhga keladi.",
      INVALID_LINK:
        "Bu havola eskirgan yoki allaqachon ishlatilgan. Menejerdan yangi havola so'rang.",
      WRONG_CHAT:
        "Bu havola bu yerda ishlamaydi: shaxsiy havola botning o'zida, guruh havolasi guruhda ochiladi. Menejerga murojaat qiling.",
      ALREADY_MEMBER_ELSEWHERE:
        "Siz allaqachon boshqa tashkilotga ulangansiz. Bir kishi faqat bitta tashkilotda bo'la oladi. Menejerga murojaat qiling.",
      STAFF_ACCOUNT: 'Bu havola mijozlar uchun. Xodim hisobi tashkilotga ulana olmaydi.',
      USER_BLOCKED:
        "Hisobingiz bloklangan, shuning uchun ulanib bo'lmaydi. Menejerga murojaat qiling.",
      CHAT_TAKEN:
        "Bu guruh tizimda boshqa tashkilot sifatida ro'yxatdan o'tgan. Menejerga murojaat qiling.",
    },
  },
  RU: {
    start: (url) =>
      [
        'Здравствуйте! iOrder.uz: система заказов и цен.',
        url === null ? NO_URL.RU : `Откройте приложение: ${url}`,
        '',
        'Команды: /price (цены), /help (помощь).',
      ].join('\n'),
    commands: (url) =>
      [
        'Здравствуйте! iOrder.uz: система заказов и цен.',
        url === null ? NO_URL.RU : `Откройте приложение: ${url}`,
        '',
        'Команды:',
        '/start: выбор языка и ссылка на приложение',
        '/lang: сменить язык',
        '/price: актуальный прайс-лист (файл Excel)',
        '/help: список команд',
      ].join('\n'),
    priceCaption: (n, at) => `Актуальный прайс-лист (Excel). Версия ${n}, ${at}.`,
    priceButton: 'Открыть в приложении',
    priceNoList: 'Прайс-лист ещё не опубликован.',
    priceFailed: 'Не удалось отправить файл с ценами. Попробуйте позже.',
    priceRefused:
      'Цены доступны только участникам организации. Уточните у менеджера, зарегистрирована ли ваша группа.',
    help: 'Команды:\n/start: ссылка на приложение\n/lang: сменить язык\n/price: прайс-лист (файл Excel)\n/help: эта справка',
    connect: {
      CONNECTED:
        'Уведомления включены. Обновления заказов, которые касаются вас, будут приходить сюда.',
      INVALID_LINK:
        'Ссылка устарела или уже использована. Нажмите «Включить уведомления» в приложении ещё раз.',
      OTHER_TELEGRAM_ACCOUNT:
        'Ваша учётная запись привязана к другому аккаунту Telegram. Чтобы изменить, обратитесь к менеджеру.',
      TELEGRAM_TAKEN:
        'Этот аккаунт Telegram привязан к другому человеку в системе. Обратитесь к менеджеру.',
    },
    invite: {
      personLinked: (name) =>
        `Здравствуйте, ${name}! Вы подключены к iOrder. Прайс-лист и статусы ваших заказов будут приходить сюда.`,
      groupLinked:
        'Группа подключена к iOrder. Прайс-лист и статусы заказов будут приходить в эту группу.',
      INVALID_LINK: 'Ссылка устарела или уже использована. Попросите у менеджера новую.',
      WRONG_CHAT:
        'Эта ссылка здесь не работает: личная ссылка открывается в чате с ботом, ссылка группы — в группе. Обратитесь к менеджеру.',
      ALREADY_MEMBER_ELSEWHERE:
        'Вы уже подключены к другой организации. Один человек может быть только в одной организации. Обратитесь к менеджеру.',
      STAFF_ACCOUNT:
        'Эта ссылка для клиентов. Учётная запись сотрудника не может подключиться к организации.',
      USER_BLOCKED:
        'Ваша учётная запись заблокирована, подключиться нельзя. Обратитесь к менеджеру.',
      CHAT_TAKEN:
        'Эта группа уже зарегистрирована в системе как другая организация. Обратитесь к менеджеру.',
    },
  },
  EN: {
    start: (url) =>
      [
        'Hello! iOrder.uz: the ordering and price system.',
        url === null ? NO_URL.EN : `Open the app: ${url}`,
        '',
        'Commands: /price (prices), /help (help).',
      ].join('\n'),
    commands: (url) =>
      [
        'Hello! iOrder.uz: the ordering and price system.',
        url === null ? NO_URL.EN : `Open the app: ${url}`,
        '',
        'Commands:',
        '/start: choose the language and get the app link',
        '/lang: change the language',
        '/price: the current price list (Excel file)',
        '/help: the list of commands',
      ].join('\n'),
    priceCaption: (n, at) => `Current price list (Excel). Version ${n}, ${at}.`,
    priceButton: 'Open in the app',
    priceNoList: 'No price list has been published yet.',
    priceFailed: 'The price file could not be sent. Please try again later.',
    priceRefused:
      'Prices are visible to members of an organization only. Ask your manager whether your group is registered.',
    help: 'Commands:\n/start: link to the app\n/lang: change the language\n/price: the price list (Excel file)\n/help: this help',
    connect: {
      CONNECTED: 'Notifications are on. Updates of the orders that concern you will arrive here.',
      INVALID_LINK:
        'This link has expired or was already used. Press "Turn on notifications" in the app again.',
      OTHER_TELEGRAM_ACCOUNT:
        'Your account is linked to another Telegram account. Ask your manager to change it.',
      TELEGRAM_TAKEN:
        'This Telegram account is linked to another person in the system. Please contact your manager.',
    },
    invite: {
      personLinked: (name) =>
        `Hello, ${name}! You are connected to iOrder. The price list and the status of your orders will arrive here.`,
      groupLinked:
        'The group is connected to iOrder. The price list and order statuses will arrive in this group.',
      INVALID_LINK: 'This link has expired or was already used. Ask your manager for a new one.',
      WRONG_CHAT:
        'This link does not work here: a personal link opens in the chat with the bot, a group link in the group. Please contact your manager.',
      ALREADY_MEMBER_ELSEWHERE:
        'You are already connected to another organization. A person can be in one organization only. Please contact your manager.',
      STAFF_ACCOUNT: 'This link is for customers. A staff account cannot join an organization.',
      USER_BLOCKED:
        'Your account is blocked, so it cannot be connected. Please contact your manager.',
      CHAT_TAKEN:
        'This group is already registered as another organization. Please contact your manager.',
    },
  },
};

export function replyTexts(locale: Locale): ReplyTexts {
  return REPLIES[locale];
}
