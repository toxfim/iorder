// Prose of the bot settings page. Merged under `botSettings` after a dynamic import, for the staff
// area only. Uzbek (Latin) is the source of truth for the shape.

export const botSettingsUz = {
  title: 'Bot sozlamalari',
  subtitle: "Telegram bot ulanishi, ko'rinishi va yuboriladigan xabarlar.",
  connection: {
    title: "Ulanish ma'lumotlari",
    subtitle: "Ilova bot haqida biladigan ma'lumotlar",
    token: 'API kalit (token)',
    tokenHidden: "Token faqat serverda saqlanadi va bu sahifada hech qachon ko'rsatilmaydi.",
    username: 'Bot foydalanuvchi nomi',
    usernameMissing: 'Bu ilovada sozlanmagan',
    openBot: 'Telegramda ochish',
    checkUnavailable:
      "Webhook holati va ulanish tekshiruvi hali serverdan berilmaydi, shuning uchun bu yerda ko'rsatilmaydi.",
  },
  appearance: {
    title: "Bot ko'rinishi",
    subtitle: "Telegram'da ko'rinadigan nom, rasm va tavsif",
    unavailable:
      "Bot nomi, rasmi va tavsifini bu sahifadan o'zgartirib bo'lmaydi: ular Telegram'dagi {'@'}BotFather orqali o'zgartiriladi.",
  },
  own: {
    title: 'Sizning ulanishingiz',
    subtitle: 'Bot sizga shaxsiy xabar yubora oladimi',
  },
  rules: {
    title: 'Buyurtma bildirishnomalari',
    subtitle:
      "Kimga qachon xabar borishi tizim qoidalari bilan belgilangan va bu yerda o'zgartirilmaydi",
    fixed: 'Qoida',
    staff: {
      title: 'Xodimlarga shaxsiy xabar',
      body: "Administratordan tashqari har bir xodimga o'z roliga tegishli har bir buyurtma o'zgarishi haqida, buyurtmani ochadigan ikki tugma bilan.",
    },
    customer: {
      title: 'Mijoz guruhiga',
      body: 'Xodim buyurtmani tasdiqlaganda, rad etganda, bekor qilganda, ombordan chiqarganda va yetkazganda: buyurtma raqami, holati, summasi va sababi bilan.',
    },
  },
};

export type BotSettingsMessages = typeof botSettingsUz;
