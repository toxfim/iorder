// Prose of the "My profile" page and of the own bot connection card (also on the bot settings
// page). Merged under `staffProfile` after a dynamic import, for the staff area only. Uzbek
// (Latin) is the source of truth for the shape.

export const staffProfileUz = {
  title: 'Mening profilim',
  subtitle: "Shaxsiy ma'lumotlar, hisob xavfsizligi va bildirishnomalar.",
  workspace: 'Ish maydoni',
  personal: {
    title: "Shaxsiy ma'lumotlar",
    subtitle: "Ism va telefonni o'zingiz o'zgartirasiz. Login va rolni administrator o'zgartiradi.",
    name: 'Ism',
    phone: 'Telefon raqami',
    phoneMissing: 'Kiritilmagan',
    phoneLoading: 'Yuklanmoqda…',
    phoneError: "O'qib bo'lmadi",
    retry: 'Qayta urinish',
    edit: "O'zgartirish",
    language: 'Interfeys tili',
    theme: 'Mavzu',
    timezone: 'Vaqt mintaqasi',
    timezoneValue: 'Toshkent · UTC+05:00',
  },
  edit: {
    title: "Ism va telefonni o'zgartirish",
    description: "Hamkasblaringiz buyurtmalar tarixida va xodimlar ro'yxatida shu ismni ko'radi.",
    name: 'Ism va familiya',
    phone: 'Telefon raqami',
    phoneHint: "Masalan +998 90 123 4567. Bo'sh qoldirsangiz, raqam o'chiriladi.",
    save: 'Saqlash',
    saved: "Ma'lumotlaringiz saqlandi",
    errors: {
      name: 'Ismingizni kiriting',
      phone: "Raqamni to'liq kiriting, masalan +998 90 123 4567",
      rateLimited: "Juda ko'p urinish. Birozdan keyin qayta urinib ko'ring.",
    },
  },
  role: {
    title: 'Sizning rolingiz: {roles}',
    change: 'Rolni faqat administrator o‘zgartiradi.',
    describe: {
      ADMIN:
        'Tizimni sozlaydi va xato kiritilgan to‘lovni tuzatadi. Buyurtma bosqichlarini bajarmaydi.',
      MANAGER:
        "Buyurtmalarni tasdiqlaydi yoki rad etadi, to'lov usulini tanlaydi, buyurtmani bekor qiladi va tashkilot to'lovlarini kiritadi.",
      ACCOUNTANT: 'Menejer tasdiqlagan buyurtmalarni tasdiqlaydi yoki rad etadi.',
      WAREHOUSE_MANAGER: 'Buyurtmalarni ombordan chiqaradi va haydovchini biriktiradi.',
      DRIVER: 'Sizga biriktirilgan buyurtmalarni yetkazadi.',
      PURCHASING_MANAGER:
        "Menejer sahifalarini ko'radi, hech narsani o'zgartirmaydi. Markirovkali tovarli buyurtmalar haqida bot xabari oladi.",
    },
  },
  security: {
    title: 'Xavfsizlik',
    subtitle: 'Hisobingizga kirish',
    password: 'Parol',
    passwordHint:
      "Parolni o'zingiz o'zgartira olmaysiz. Yangi parol yoki login kerak bo'lsa, administratorga murojaat qiling.",
  },
  bot: {
    title: 'Bildirishnomalar',
    subtitle: 'Buyurtma xabarlari sizga Telegram bot orqali keladi',
    telegram: 'Telegram hisobi',
    botState: 'Bot',
    linked: "Bog'langan",
    notLinked: "Bog'lanmagan",
    connected: 'Ulangan',
    notConnected: 'Ulanmagan',
    connectedHint: "Bot sizga o'z rolingizga tegishli har bir buyurtma o'zgarishi haqida yozadi.",
    adminNote: 'Administratorga bot buyurtma xabarlarini yubormaydi.',
    loadError: "Ulanish holatini o'qib bo'lmadi.",
    retry: 'Qayta urinish',
  },
};

export type StaffProfileMessages = typeof staffProfileUz;
