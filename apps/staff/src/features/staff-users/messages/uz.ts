// Staff-only vocabulary of the staff accounts page and of blocking a person. Merged under
// `staffUsers` after a dynamic import, for the staff area only. Uzbek (Latin) is the source of
// truth for the shape; the RU and EN files are typed against it.

export const staffUsersUz = {
  errors: {
    forbidden: "Bu amalga ruxsat yo'q.",
    notFound: 'Bunday odam topilmadi. Ro‘yxatni yangilab ko‘ring.',
    conflict:
      "Amalni bajarib bo'lmadi: ma'lumotlar allaqachon band yoki holat o'zgargan. Tekshirib, qayta urinib ko'ring.",
    lastAdmin:
      "Bu amalni bajarib bo'lmaydi: tizimda kamida bitta faol administrator qolishi kerak.",
    telegramIdRequired:
      "Telegram ID si yo'q odamni mijoz qilib bo'lmaydi: u xodim rolida qolishi kerak.",
    rateLimited: "Juda ko'p urinish. {seconds} soniyadan keyin qayta urinib ko'ring.",
    invalid: "Kiritilgan ma'lumotlar noto'g'ri. Maydonlarni tekshiring.",
    generic: "Amalni bajarib bo'lmadi. Keyinroq qayta urinib ko'ring.",
  },
  block: {
    title: 'Bloklash: {name}',
    description: 'Bloklangan odam buyurtma bera olmaydi va narxlarni ko‘rmaydi.',
    groupsTitle: 'Telegram guruhlari',
    noGroups: "Hech qaysi Telegram guruhida a'zo emas.",
    question: 'Guruhdan ham chiqarilsinmi?',
    optionOnly: 'Faqat bloklash',
    optionOnlyHint: 'Odam guruhda qoladi.',
    optionRemove: 'Bloklash va Telegram guruh(lar)dan chiqarish',
    optionRemoveHint: 'Bot odamni guruh(lar)dan chiqaradi.',
    consequence:
      'Odam guruhdan chiqariladi, lekin guruh adminlari uni qayta taklif qila oladi. Blokdan chiqarish odamni guruhga qaytarmaydi. Botga guruhda administrator huquqi kerak.',
    confirm: 'Bloklash',
    confirmRemove: 'Bloklash va chiqarish',
    blockedTitle: 'Bloklandi: {name}',
    blockedToast: '{name} bloklandi',
    close: 'Yopish',
    nothingQueued: 'Chiqariladigan guruh topilmadi: odam hech qaysi guruhda emas yoki xodim.',
    alreadyRequested: "Chiqarish so'rovi avval yuborilgan.",
  },
  removal: {
    title: 'Telegram guruhdan chiqarish',
    refresh: 'Yangilash',
    refreshing: 'Yangilanmoqda…',
    retry: 'Qayta urinish',
    retrying: 'Yuborilmoqda…',
    retryHint:
      "Qayta urinish faqat bajarilmagan guruhlarni qayta navbatga qo'yadi. Avval sababni bartaraf eting.",
    retried: "{count} ta guruh qayta navbatga qo'yildi.",
    retryNone: "Qayta navbatga qo'yadigan guruh topilmadi.",
    watching: 'Holat o‘zi yangilanib turadi.',
    stalled: "Holat uzoq vaqt o'zgarmadi. Yangilash tugmasi bilan tekshiring.",
    empty: "Chiqarish so'rovi yo'q.",
    list: 'Guruhlar bo‘yicha holat',
    status: {
      PENDING: 'Kutilmoqda',
      DONE: 'Chiqarildi',
      FAILED: 'Bajarilmadi',
    },
    banWarning:
      "Odam guruhda hali bloklangan bo'lishi mumkin. Guruh administratori uni qo'lda blokdan chiqarishi kerak, aks holda uni qayta taklif qilib bo'lmaydi.",
    reason: {
      BOT_NOT_ADMIN:
        "Bot bu guruhda administrator emas yoki a'zolarni chiqarish huquqi yo'q. Botga huquq bering.",
      NOT_A_MEMBER: "Odam bu guruhda allaqachon yo'q.",
      CHAT_NOT_FOUND: "Guruh topilmadi: o'chirilgan yoki bot undan chiqarilgan.",
      CANNOT_REMOVE_MEMBER:
        'Telegram bu odamni chiqarishga ruxsat bermaydi (guruh egasi yoki boshqa administrator).',
      REMOVAL_REJECTED: "Telegram so'rovni rad etdi.",
      REMOVAL_NOT_ALLOWED:
        "Bot chiqarishdan bosh tortdi: odam xodim, bloklanmagan yoki ma'lumotlar mos kelmadi.",
      UNBAN_FAILED: "Odam guruhdan chiqarildi, lekin blokdan chiqarib bo'lmadi.",
      CHAT_MIGRATED:
        "Guruh superguruhga aylangan, saqlangan guruh raqami eskirgan. Uni qo'lda to'g'rilash kerak.",
      RATE_LIMITED_TOO_LONG: "Telegram bir kun davomida cheklov qo'ydi, so'rov bekor qilindi.",
      RETRIES_EXHAUSTED: 'Bir necha urinishdan keyin ham bajarilmadi.',
      NO_RECIPIENT: 'Telegram hisobi yoki guruh endi tanilmaydi.',
      INVALID_PAYLOAD: "So'rov noto'g'ri tuzilgan edi, shuning uchun yuborilmadi.",
      UNKNOWN: "Chiqarib bo'lmadi. Sababi noma'lum.",
    },
  },
  accounts: {
    title: 'Xodimlar',
    info: '{count} ta hisob',
    subtitle: "Xodim hisoblari, rollari, Telegram ulanishi va kirish ma'lumotlari",
    summary: '{active} faol, {blocked} bloklangan',
    roleTiles: {
      label: 'Rol bo‘yicha saralash',
      count: '{count} xodim',
      hint: {
        ADMIN: "Sozlamalar, xodim hisoblari, to'lovni tuzatish",
        MANAGER: "Buyurtma tasdig'i, bekor qilish, to'lov kiritish",
        ACCOUNTANT: "Buyurtmaning buxgalteriya tasdig'i",
        WAREHOUSE_MANAGER: "Yig'ish va ombordan chiqarish",
        DRIVER: 'Mijozga yetkazib berish',
        PURCHASING_MANAGER: "Hamma narsani ko'radi, markirovkali tovarlar haqida bot xabari",
      },
    },
    list: "Xodim hisoblari ro'yxati",
    search: 'Ism yoki login bo‘yicha qidirish',
    add: "Hisob qo'shish",
    empty: "Hozircha xodim hisobi yo'q.",
    emptyFiltered: 'Filtrga mos hisob topilmadi.',
    filters: {
      group: 'Hisoblar filtri',
      role: 'Rol',
      status: 'Holat',
      all: 'Barchasi',
    },
    columns: {
      name: 'Xodim',
      login: 'Login',
      roles: 'Rollar',
      status: 'Holat',
      password: 'Parol',
      telegram: 'Telegram',
      lastSignIn: 'Oxirgi kirish',
      actions: 'Amallar',
    },
    status: { ACTIVE: 'Faol', BLOCKED: 'Bloklangan' },
    password: { set: "O'rnatilgan", notSet: "O'rnatilmagan" },
    telegram: { linked: 'Ulangan', notLinked: 'Ulanmagan' },
    neverSignedIn: 'Hali kirmagan',
    noLogin: 'Login yo‘q',
    actions: {
      telegram: 'Telegramni sozlash',
      credentials: 'Login va parol',
      block: 'Bloklash',
      unblock: 'Blokdan chiqarish',
      menu: 'Amallar: {name}',
    },
    create: {
      title: 'Yangi xodim hisobi',
      description:
        "Xodim shu login va parol bilan veb-saytga kiradi. Parolni xodimga o'zingiz yetkazing.",
      fullName: "To'liq ism",
      login: 'Login',
      // `@` starts a linked message in vue-i18n, so it is written as a literal.
      loginHint: "name{'@'}iorder.uz ko‘rinishida: kichik lotin harflar, raqamlar, nuqta, chiziq.",
      password: 'Parol',
      passwordHint: 'Kamida 8 belgi.',
      show: "Ko'rsatish",
      hide: 'Yashirish',
      generate: 'Kuchli parol yaratish',
      roles: 'Rollar',
      rolesHint: '1 tadan 5 tagacha rol tanlang.',
      phone: 'Telefon (ixtiyoriy)',
      phoneHint: 'Faqat raqamlar, + o‘zi qo‘yiladi: 998 90 123 4567.',
      language: 'Til',
      telegramId: 'Telegram ID',
      telegramHint:
        'Faqat raqamlar, majburiy: bot xodimni mijoz guruhlarida shu ID orqali taniydi.',
      submit: 'Hisob yaratish',
      errors: {
        fullName: 'Ismni kiriting.',
        login: "Login name{'@'}iorder.uz ko‘rinishida bo‘lishi kerak.",
        password: 'Parol kamida 8 belgidan iborat bo‘lishi kerak.',
        roles: '1 tadan 5 tagacha rol tanlang.',
        phone: 'Telefon +998901234567 ko‘rinishida bo‘lishi kerak.',
        telegramId: 'Telegram ID faqat raqamlardan iborat bo‘lishi kerak.',
      },
    },
    languages: { UZ: "O'zbekcha", RU: 'Русский', EN: 'English' },
    created: {
      title: 'Hisob yaratildi',
      text: '{name} uchun hisob yaratildi. Login: {login}',
      passwordTitle: 'Bir martalik parol',
      copy: 'Nusxa olish',
      copied: 'Nusxa olindi',
      copyFailed: "Nusxa olib bo'lmadi. Parolni qo'lda belgilab oling.",
      warning:
        "Bu parol faqat hozir ko'rsatiladi va keyin qayta ko'rsatilmaydi. Uni xavfsiz joyda saqlang va xodimga yetkazing.",
      done: 'Parolni saqladim',
    },
    telegramDialog: {
      title: 'Telegram: {name}',
      description:
        "Xodim Telegram orqali shu ID bilan kiradi. ID'ni faqat boshqasiga almashtirish mumkin, olib tashlab bo'lmaydi.",
      current: 'Hozir: {state}',
      id: 'Telegram ID',
      hint: 'Faqat raqamlar.',
      save: 'Saqlash',
      error: 'Telegram ID faqat raqamlardan iborat bo‘lishi kerak.',
      saved: 'Telegram ulanishi saqlandi',
    },
    credentialsDialog: {
      title: 'Login va parol: {name}',
      description:
        "Yangi parol xodimning barcha seanslarini tugatadi. Bo'sh qoldirilgan maydon o'zgarmaydi.",
      newLogin: 'Yangi login (ixtiyoriy)',
      newPassword: 'Yangi parol (ixtiyoriy)',
      save: 'Saqlash',
      nothing: 'Login yoki parolni kiriting.',
      saved: 'Login va parol saqlandi',
    },
    blockDialog: {
      title: 'Bloklash: {name}',
      description:
        'Bloklangan xodim tizimga kira olmaydi, seanslari tugatiladi. Xodim Telegram guruhlaridan chiqarilmaydi.',
      confirm: 'Bloklash',
      unblockTitle: 'Blokdan chiqarish: {name}',
      unblockDescription: 'Xodim yana tizimga kira oladi.',
      unblockConfirm: 'Blokdan chiqarish',
      blocked: '{name} bloklandi',
      unblocked: '{name} blokdan chiqarildi',
    },
    forbiddenNote: "Administrator hisobini faqat administrator o'zgartira oladi.",
  },
};

export type StaffUsersMessages = typeof staffUsersUz;
