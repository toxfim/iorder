// Uzbek (Latin) is the default and the source of truth for the message shape.
// Strings copied from the design files (docs/private/design/v1) must stay verbatim, including the
// ASCII apostrophe (') used in the design. Entries marked "new" have no design string yet.

export const uz = {
  nav: {
    ariaLabel: 'Asosiy menyu',
    openMenu: 'Menyuni ochish',
    quickFilters: 'Tez filtrlar',
    workspace: 'Ish maydoni',
    breadcrumb: 'Joylashuv',
    workspaceCard: { title: 'iOrder savdo', subtitle: 'B2B boshqaruv paneli' },
    footer: 'iOrder.uz  /  Ish maydoni',
    // new: the top bar bell; no notification feed exists yet, so it shows the empty state.
    notifications: {
      label: 'Bildirishnomalar',
      empty: "Hozircha bildirishnoma yo'q",
      emptyHint: 'Buyurtma yangilanishlari hozircha Telegram bot orqali keladi.',
      marked: {
        ORDER_SUBMITTED: '{number}-buyurtma: yangi, markirovkali tovar bor',
        ORDER_ITEMS_EDITED: "{number}-buyurtmaga markirovkali tovar qo'shildi",
        ORDER_CANCELLED: '{number}-buyurtma bekor qilindi',
        emptyHint: "Markirovkali tovarli buyurtmalar shu yerda ko'rinadi.",
        error: "Bildirishnomalarni yuklab bo'lmadi.",
        loading: 'Yuklanmoqda…',
        quantity: '{count} dona',
      },
    },
    quick: { today: 'Bugungi', debt: "To'lanmagan" },
    ordersGroup: {
      label: 'Buyurtmalar',
      toggle: "Buyurtmalar bo'limini yig'ish yoki ochish",
      badge: '{count} ta buyurtma kutmoqda',
      all: 'Barcha buyurtmalar',
      awaitingManager: 'Tasdiq kutmoqda',
      awaitingAccounting: "Buxgalteriya tasdig'i kutmoqda",
      toRelease: 'Ombordan chiqarish kutilmoqda',
      toDeliver: 'Yetkazish kutilmoqda',
    },
    priceCard: { title: "Narx ro'yxati", version: 'v{number} · {time}', open: 'Narxlarni ochish' }, // "open" is new: v1 links to the prototype
    unpricedBadge: '{count} ta narxsiz tovar',
    waitingOrganizationsBadge: '{count} ta guruh faollashtirishni kutmoqda',
    sheetAttentionBadge: "{count} ta jadval masalasi e'tibor kutmoqda",
    groups: {
      general: 'Umumiy',
      warehouse: 'Ombor',
      sales: 'Savdo',
      system: 'Tizim',
    },
    staff: {
      dashboard: 'Bosh sahifa',
      orders: 'Buyurtmalar',
      accountingQueue: "Buxgalteriya tasdig'i",
      warehouse: 'Ombor: chiqarish',
      deliveries: 'Yetkazishlarim',
      prices: 'Narxlar',
      brands: 'Brendlar',
      stock: 'Qoldiq',
      byOrder: 'Buyurtma orqali',
      customers: 'Mijozlar',
      organizations: 'Tashkilotlar',
      employees: 'Xodimlar',
      history: 'Faoliyat tarixi',
      botSettings: 'Bot sozlamalari',
      profile: 'Mening profilim',
    },
  },
  dates: {
    // new: the design prints the date in Uzbek only ("Dushanba, 19-oktyabr").
    weekdays: {
      '0': 'Yakshanba',
      '1': 'Dushanba',
      '2': 'Seshanba',
      '3': 'Chorshanba',
      '4': 'Payshanba',
      '5': 'Juma',
      '6': 'Shanba',
    },
    months: {
      '0': 'yanvar',
      '1': 'fevral',
      '2': 'mart',
      '3': 'aprel',
      '4': 'may',
      '5': 'iyun',
      '6': 'iyul',
      '7': 'avgust',
      '8': 'sentyabr',
      '9': 'oktyabr',
      '10': 'noyabr',
      '11': 'dekabr',
    },
    dayMonth: '{weekday}, {day}-{month}',
    long: '{day} {month} {year}',
  },
  people: {
    card: {
      loading: "Ma'lumot yuklanmoqda…",
      noPhone: 'Telefon kiritilmagan',
      blocked: 'Bloklangan',
      noRole: 'Rol belgilanmagan',
      notInSystem: 'Tizimda topilmadi',
      error: "Ma'lumotni yuklab bo'lmadi",
    },
  },
  roles: {
    staff: {
      ADMIN: 'Administrator',
      MANAGER: 'Menejer',
      ACCOUNTANT: 'Buxgalter',
      WAREHOUSE_MANAGER: 'Omborchi',
      DRIVER: 'Haydovchi',
      PURCHASING_MANAGER: 'Zakup menejeri',
    },
    organization: {
      SHOP_OWNER: "Do'kon egasi",
      SELLER: 'Sotuvchi',
    },
  },
  auth: {
    signOut: 'Chiqish',
    login: {
      design: {
        audience: 'Xodimlar uchun',
        title: 'Xodimlar uchun kirish',
        subtitle: 'Buyurtmalar va ish jarayonini boshqaring.',
        footer: 'iOrder.uz · Xodimlar ish maydoni',
        heroEyebrow: 'Jarayon nazoratingizda',
        heroTitle: 'Har bir buyurtma.\nAniq bir keyingi qadam.',
        heroDescription:
          "Jamoa uchun yagona ish maydoni. Buyurtmalarni ko'ring, vazifalarni bajaring va jarayonni kuzating.",
        heroNote: 'Vazifalar aniq. Tarix saqlanadi.',
        previewStatus: 'Tasdiqlash kutilmoqda',
        previewFlow: 'Buyurtma → Tasdiqlash → Yetkazish',
        recoveryHint:
          "Parolni tiklash uchun administratorga murojaat qiling. Telegram akkauntingiz ulangan bo'lsa, Telegram orqali ham kirishingiz mumkin.",
        note: 'Kirish huquqi administrator tomonidan beriladi.',
      },
      title: 'Ulgurji narxlar va buyurtmalar',
      subtitle: "Kompaniyamiz narx ro'yxati, buyurtma berish va holatini kuzatish bir joyda.",
      note: "Faqat mijozlar guruhi a'zolari uchun",
      staffNote: 'Faqat xodimlar uchun. Mijozlar Telegram orqali kiradi.',
      // One text for every refusal: it must not say whether the login or the password was wrong.
      failed: "Kirib bo'lmadi. Ma'lumotlarni tekshirib, qayta urinib ko'ring.",
      rateLimited: "Juda ko'p urinish. Birozdan keyin qayta urinib ko'ring.",
      retryIn: '{seconds} soniyadan keyin',
      password: {
        title: 'Login va parol',
        login: 'Login',
        password: 'Parol',
        submit: 'Kirish',
        wait: 'Kuting: {seconds} s',
      },
      telegram: {
        title: 'Telegram orqali',
        ignored:
          "Biroz kuting: kirish davom etmoqda yoki qisqa tanaffus kerak. Telegram tugmasini birozdan so'ng qayta bosing.",
      },
    },
    denied: {
      title: "Kirish uchun ruxsat yo'q",
      // new: this app is for staff only; customers use the customer app.
      description:
        'Bu ilova faqat kompaniya xodimlari uchun. Ruxsat olish uchun administratorga murojaat qiling.',
    },
    // new: the app was opened from Telegram (Mini App) but the launch did not sign the person in
    // as staff. The server gives one answer for every reason, so the screen lists what to do.
    telegram: {
      pageTitle: 'Telegram orqali kirish',
      unknown: {
        title: "Telegram orqali kirib bo'lmadi",
        description:
          'Telegram akkauntingiz faol xodim hisobiga biriktirilmagan yoki kirish muddati tugagan.',
      },
      notStaff: {
        title: 'Bu ilova faqat xodimlar uchun',
        description: 'Telegram akkauntingiz bu yerda xodim sifatida tanilmadi.',
      },
      stepsTitle: 'Nima qilish kerak',
      steps: {
        reopen: "Ilovani yoping va Telegram'dagi tugma orqali qayta oching.",
        link: "Yana kirib bo'lmasa, menejer yoki administratordan Telegram ID raqamingizni xodim hisobingizga biriktirishni so'rang.",
        staffButton:
          "Xodim bo'lsangiz, ilovani botning eng so'nggi xabari ostidagi «Mini App'da ochish» tugmasi orqali oching: eski xabarlardagi tugma ishlamay qolgan bo'lishi mumkin.",
        customerApp: "Mijoz bo'lsangiz, buyurtmalarni mijozlar ilovasida bering.",
        password: "Login va parolingiz bo'lsa, shu yerning o'zida ular bilan kiring.",
      },
      yourId: 'Telegram ID raqamingiz',
      stillRefused: "Hali ham kirib bo'lmadi. Yuqoridagi qadamlarni bajaring.",
      retry: 'Qayta urinish',
      usePassword: 'Login va parol bilan kirish',
    },
  },
  // new: reminder to connect the bot for staff notifications ([C] 2026-10-25).
  // new ([C] 2026-11-09): continue on the customer site with the dashboard sign-in.
  customerSite: {
    entry: 'Mijoz sahifasi',
    openInNewTab: 'Mijoz sahifasi, yangi oynada ochiladi',
    handoff: {
      opening: 'Mijoz sahifasi ochilmoqda…',
      openingHint: 'Hisobingiz bilan avtomatik kirasiz.',
      failedTitle: "Mijoz sahifasini ochib bo'lmadi",
      failedDescription:
        "Qayta urinib ko'ring. Yana ochilmasa, mijoz sahifasiga login va parol bilan kiring.",
      rateLimited: "Juda ko'p urinish bo'ldi. Bir daqiqadan so'ng qayta urinib ko'ring.",
      unavailableTitle: 'Mijoz sahifasi bu yerdan ochilmaydi',
      unavailableDescription: "Bu hisob uchun mijoz sahifasiga o'tish yoqilmagan.",
      confirmTitle: "Mijoz sahifasiga o'tish",
      confirmDescription: "Shu hisob bilan mijoz sahifasiga o'tasiz. Davom etilsinmi?",
      continueButton: "Mijoz sahifasiga o'tish",
      backToDashboard: 'Boshqaruv paneliga qaytish',
    },
  },
  botNotifications: {
    title: 'Bildirishnomalarni yoqing',
    notLinked:
      'Buyurtma yangilanishlari Telegram botga keladi. Telegram akkauntingiz hali ulanmagan: tugmani bosing va botda Start ni bosing.',
    notConnected: 'Bot sizga xabar yubora olmayapti. Tugmani bosing va botda Start ni bosing.',
    pressStart: "Telegram'da botni oching, Start ni bosing va shu yerga qayting.",
    connect: 'Bildirishnomani yoqish',
    check: 'Tekshirish',
  },
  // Price list screens. Entries without "new" are copied from docs/private/design/v1 verbatim.
  prices: {
    title: 'Narxlar',
    // new (v8 page subtitle).
    subtitle: "Ulgurji narxlar, ombor qoldiqlari va o'zgarishlar tarixi.",
    tabs: {
      all: 'Barcha mahsulotlar',
      ariaLabel: "Narxlar bo'limlari",
      noWholesale: "Ulgurji narxi yo'q",
      versions: 'Versiyalar',
      products: 'Tovarlar',
    },
    // The footer of the table; `currency` is one of `pricesIn` (the page shows USD or so'm).
    info: '{count} ta tovar · {currency}',
    pricesIn: { USD: 'narxlar dollarda', UZS: "narxlar so'mda" },
    version: "Narx ro'yxati v{number}",
    publishedAt: '{date} da nashr qilingan',
    search: { label: 'Qidiruv', placeholder: 'Tovar ID yoki tovar nomi' },
    noMatch: "Filtrga mos tovar yo'q",
    tableLabel: 'Narxlar jadvali',
    // new (v8): the list subtitle, the orange "add from stock" action and the history link.
    listSummary: "Narx ro'yxati v{number} · {count} ta tovar",
    addFromStock: "Qoldiqdan qo'shish",
    addFromStockLabel: "Qoldiqdan qo'shish: {count} ta narxsiz tovar",
    historyLink: 'Narxlar tarixi',
    openRow: 'Tovar tarixini ochish',
    // The row's context menu (right click, Shift+F10, the touch "⋯" button) [owner 2026-11-12].
    rowMenu: {
      label: '{code} {name}: amallar',
      photos: "Rasmlarni o'zgartirish",
      stock: "Qoldiqda ko'rish",
      copyCode: 'Tovar ID ni nusxalash',
      copied: 'Tovar ID nusxalandi: {code}',
      copyFailed: "Nusxalab bo'lmadi. Tovar ID: {code}",
      alreadyRemoved: '{name} allaqachon price listdan olib tashlangan',
    },
    columns: {
      markup: 'Ustama',
      product: 'Tovar',
      productCode: 'Tovar ID',
      name: 'Nomi',
      // The owner's own column names (2026-10-29); the currency sign follows them.
      price: 'Цена',
      deferredPrice: 'Отсрочка',
      groupStandard: 'Standart',
      groupWholesale: 'Ulgurji / Hamkor',
      groupAlif: 'Alif factoring',
    },
    currency: { label: 'Narxlar valyutasi', USD: '$', UZS: "so'm" },
    empty: {
      title: "Narx ro'yxati hali nashr qilinmagan",
      description:
        "Ostatok sahifasida tovarga narx qo'ying: birinchi narx ro'yxatni nashr qiladi va mijozlar uni darhol ko'radi.",
    },
    saved: 'Narxlar saqlandi · v{number}',
    skipped: "{count} ta nofaol tovar ro'yxatdan chiqarildi",
    row: {
      invalid: "Narx noto'g'ri: faqat raqam, kasr qismi ko'pi bilan 2 xona",
      inactive: "Faol bo'lmagan tovarga narx qo'yib bo'lmaydi",
      inactiveBadge: 'Faol emas',
      fromStandard: 'standartdan',
      fromStandardHint:
        "Ulgurji narx qo'yilmagan: Ulgurji va Hamkor mijozlar standart narxni ko'radi",
      notOffered: "ko'rinmaydi",
      notOfferedAlifHint:
        "Alif narxi yo'q: Alif factoring mijozlar bu mahsulotni ko'rmaydi va buyurtma qila olmaydi",
    },
    history: {
      title: 'Narx tarixi',
      heading: "Narx o'zgarishlari",
      empty: "Hozircha narx tarixi yo'q",
      added: "Ro'yxatga qo'shildi",
      removed: "Ro'yxatdan olib tashlandi",
      // new: the v8 history table and its notice (hard rule 4).
      ruleNote:
        "Yangi narx faqat keyingi buyurtmalarga qo'llanadi. Avvalgi buyurtmalar narxi o'zgarmaydi.",
      columns: {
        when: 'Sana va vaqt',
        change: 'Oldingi → yangi',
        author: 'Muallif',
        version: 'Versiya',
      },
    },
    versions: {
      title: 'Versiyalar',
      subtitle:
        "Har bir saqlash yangi versiya sifatida nashr qilinadi; nashr qilingan versiya o'zgarmaydi.",
      columns: {
        number: 'Versiya',
        status: 'Holat',
        when: 'Sana',
        note: 'Izoh',
        items: 'Tovarlar',
      },
      empty: "Versiyalar hali yo'q",
      items: '{count} ta tovar',
      createdAt: '{date} da yaratilgan',
      readOnly: "Faqat ko'rish uchun: versiya o'zgartirilmaydi.",
      status: { DRAFT: 'Qoralama', PUBLISHED: 'Nashr qilingan', ARCHIVED: 'Arxiv' },
    },
    dialog: {
      titleEdit: "Narxni o'zgartirish",
      titleAdd: "Narx qo'yish",
      current: 'Joriy narx',
      notListed: 'hali narxlarda emas',
      newPrice: 'Yangi narx (Цена), $',
      price: 'Цена, $',
      perUnit: 'Bir {unit} uchun narx',
      deferredPrice: 'Отсрочка, $ (ixtiyoriy)',
      deferredHint:
        "Bo'lib to'lashga olinganda qo'llanadigan narx. Bo'sh qolsa, bo'lib to'lash narxi yo'q",
      deferredShort: 'Отсрочка',
      rrp: 'Tavsiya etilgan narx (RRP), $ (ixtiyoriy)',
      rrpHint:
        "Mijoz savatda ko'radi; buyurtma summasiga ta'sir qilmaydi. Bo'sh qolsa, ko'rsatilmaydi",
      rrpShort: 'RRP',
      sectionStandard: 'Standart',
      sectionWholesale: 'Ulgurji / Hamkor',
      sectionWholesaleHint:
        "Ixtiyoriy. Bo'sh qolsa, Ulgurji va Hamkor mijozlar standart narxni ko'radi.",
      wholesalePrice: 'Цена, $ (ixtiyoriy)',
      wholesaleDeferredPrice: 'Отсрочка, $ (ixtiyoriy)',
      wholesaleDeferredHint: "Bo'sh qolsa, bu turda bo'lib to'lash narxi yo'q",
      wholesaleNeedsPrice: 'Avval shu turning Цена sini kiriting',
      alifPrice: 'Цена, $ (ixtiyoriy)',
      alifDeferredPrice: 'Отсрочка, $ (ixtiyoriy)',
      alifDeferredHint: "Bo'sh qolsa, Alif factoring mijozlar bo'lib to'lay olmaydi",
      alifNeedsPrice: 'Avval Alif Цена sini kiriting',
      wholesaleShort: 'Ulgurji',
      alifShort: 'Alif',
      sectionAlif: 'Alif factoring',
      sectionAlifHint: "Ixtiyoriy. Bo'sh qolsa, Alif factoring mijozlar bu mahsulotni ko'rmaydi.",
      rrpTiersHint:
        "Barcha turlar uchun bitta. Mijoz savatda ko'radi; buyurtma summasiga ta'sir qilmaydi.",
      publishNoteTiers:
        "Saqlash yangi narx ro'yxati versiyasini nashr qiladi: har bir mijoz o'z label narxini darhol ko'radi, avvalgi buyurtmalar narxi o'zgarmaydi.",
      publishNote:
        "Saqlash yangi narx ro'yxati versiyasini nashr qiladi: mijozlar yangi narxni darhol ko'radi, avvalgi buyurtmalar narxi o'zgarmaydi.",
      remove: 'Price listdan olib tashlash',
      removeQuestion: "Tovar price listdan olib tashlansinmi? Mijozlar uni ko'rmay qoladi.",
      removeConfirm: 'Olib tashlash',
      save: 'Saqlash',
      add: 'Narxlarga chiqarish',
    },
    // new (2026-10-28): the published list as the groups' Excel file, and posting it now.
    tiers: {
      STANDARD: 'Standart',
      WHOLESALE_PARTNER: 'Ulgurji / Hamkor',
      ALIF_FACTORING: 'Alif factoring',
    },
    file: {
      download: 'Excel yuklab olish',
      downloadMenu: 'Qaysi narx turidagi fayl',
      downloadStandardHint: 'Standart label mijozlari oladigan fayl',
      downloadWholesaleHint: 'Ulgurji va Hamkor mijozlar oladigan fayl',
      downloadAlifHint: 'Alif factoring mijozlar oladigan fayl',
      downloaded: 'Fayl yuklab olindi: {name}',
      post: 'Guruh va lichkalarga yuborish',
      postTitle: "Narx ro'yxati yuborilsinmi?",
      postDescription:
        "Excel fayl har bir faol tashkilotga o'z label narxlari bilan boradi: guruhlarga guruhning o'ziga, shaxslarga bot lichkasiga.",
      postConfirm: 'Yuborish',
      postConfirmCount: 'Yuborish ({count})',
      byTier: "Narx turi bo'yicha",
      byDestination: 'Qayerga',
      toGroups: 'Guruhlarga',
      toPrivate: 'Shaxslarga (lichka)',
      skipped:
        "O'tkazib yuboriladi: {unbound} ta ulanmagan, {inactive} ta nofaol, {postingOff} ta narx yuborish o'chirilgan, {noPrices} ta narxi yo'q turdagi tashkilot.",
      recipientsLoading: 'Qabul qiluvchilar sanalmoqda…',
      recipientsFailed: "Qabul qiluvchilarni sanab bo'lmadi. Baribir yuborish mumkin.",
      posted: "Narx ro'yxati v{number} yuborilmoqda: {count} ta chat",
      postedNone: "Narx ro'yxatini qabul qiladigan tashkilot yo'q: hech narsa yuborilmadi.",
    },
  },
  // new (2026-10-28): products whose brand was not found in the name.
  brands: {
    title: 'Brendlar',
    subtitle: '{count} ta tovarga brend tanlash kerak',
    explanation:
      "Brend tovar nomidan avtomatik topiladi. Bu tovarlarning nomida ma'lum brend topilmadi: brendni qo'lda tanlang. Tanlov shu tovar uchun eslab qolinadi.",
    tableLabel: 'Brendsiz tovarlar',
    columns: { product: 'Tovar', category: 'Kategoriya', brand: 'Brend' },
    inPriceList: "Narx ro'yxatida",
    noCategory: 'Kategoriyasiz',
    empty: {
      title: 'Hamma tovarlarning brendi bor',
      description: "Nomidan brend topilmagan yangi tovar shu yerda paydo bo'ladi.",
    },
    picker: {
      label: '{product}: brend',
      placeholder: 'Brendni tanlang yoki yozing',
      saving: 'Saqlanmoqda…',
      create: 'Yangi brend yaratish: «{name}»',
      noMatch: "Mos brend yo'q",
      noBrands: "Brendlar hali yo'q: nomini yozing",
    },
    saved: '{product}: brend «{brand}»',
    existing: '«{brand}» brendi allaqachon bor edi va tanlandi',
  },
  // Cost, stock, USD rate and sheet sync screens (staff only). Strings from docs/private/design/v1 are
  // kept verbatim ("Kurs $1 = ...", "Tannarx", "Qoldiq", "Postavka tarixi"); the rest is new.
  // new (2026-10-29): product photos on Qoldiq and Narxlar, managed by the manager and the admin.
  // "Yangi modellar" [C, 2026-11-09]: the pairs the system proposes and the manager confirms, so
  // the customer home may show a bought model's newer generation.
  newerModels: {
    title: 'Yangi modellar',
    subtitle: '{count} ta taklif qarorni kutmoqda',
    explanation:
      "Tizim tovar nomlaridan «eski model → yangi model» juftliklarini taklif qiladi. Tasdiqlangan juftlik mijozning bosh sahifasida ko'rinadi: eski modelni olgan mijozga yangisi tavsiya qilinadi. Rad etilgan juftlik hech kimga ko'rsatilmaydi.",
    find: 'Takliflarni topish',
    found: '{count} ta yangi taklif',
    foundNone: "Yangi taklif yo'q",
    tabs: {
      label: 'Holat',
      PROPOSED: 'Kutilmoqda',
      CONFIRMED: 'Tasdiqlangan',
      REJECTED: 'Rad etilgan',
    },
    tableLabel: 'Yangi model juftliklari',
    columns: { older: 'Eski model', newer: 'Yangi model', decision: 'Qaror' },
    notPriced: "Narx ro'yxatida yo'q",
    inactive: 'Sotuvdan olingan',
    confirm: 'Tasdiqlash',
    reject: 'Rad etish',
    confirmLabel: 'Tasdiqlash: {older} → {newer}',
    rejectLabel: 'Rad etish: {older} → {newer}',
    decidedBy: '{name} · {date}',
    confirmed: 'Tasdiqlandi: {older} → {newer}',
    rejected: 'Rad etildi: {older} → {newer}',
    readOnly: 'Qarorni menejer yoki administrator qabul qiladi.',
    empty: {
      PROPOSED: {
        title: "Qaror kutayotgan taklif yo'q",
        description: '«Takliflarni topish» tovar nomlaridan yangi juftliklarni qidiradi.',
      },
      CONFIRMED: {
        title: "Tasdiqlangan juftlik yo'q",
        description: "Tasdiqlangan juftliklar mijozning bosh sahifasida ko'rinadi.",
      },
      REJECTED: {
        title: "Rad etilgan juftlik yo'q",
        description: 'Rad etilgan juftlik qayta taklif qilinmaydi.',
      },
    },
  },
  photos: {
    title: 'Rasmlar',
    dialogTitle: 'Tovar rasmlari',
    none: "Rasm yo'q",
    zoom: '{name}: rasmni kattalashtirish',
    close: 'Yopish',
    alt: '{name}, {index}-rasm',
    empty: "Bu tovarda hali rasm yo'q.",
    upload: "Rasm qo'shish",
    uploading: 'Yuklanmoqda…',
    hint: "JPEG, PNG yoki WebP, {mb} MB gacha. Birinchi rasm asosiy bo'ladi.",
    primary: 'Asosiy',
    makePrimary: 'Asosiy qilish',
    makePrimaryLabel: '{index}-rasmni asosiy qilish',
    remove: "O'chirish",
    removeLabel: "{index}-rasmni o'chirish",
    removeQuestion:
      "Rasm o'chirilsinmi? Asosiy rasm o'chirilsa, boshqa rasm o'zi asosiy bo'lmaydi.",
    removeConfirm: "Ha, o'chirish",
    uploaded: "Rasm qo'shildi",
    primarySet: "Asosiy rasm o'zgardi",
    removed: "Rasm o'chirildi",
    loadFailed: "Rasmlarni yuklab bo'lmadi.",
    denied: "Rasmlarni boshqarishga ruxsatingiz yo'q.",
    errors: {
      type: 'Faqat JPEG, PNG yoki WebP rasm yuklash mumkin.',
      size: "Fayl juda katta: {mb} MB gacha bo'lishi kerak.",
      tooLarge: "Fayl juda katta: {mb} MB gacha bo'lishi kerak.",
      invalid:
        "Bu faylni rasm sifatida qabul qilib bo'lmadi: kamida 200 px, animatsiyasiz JPEG, PNG yoki WebP bo'lsin.",
      retry: 'Bu yuklash boshqa fayl bilan yuborilgan edi. Rasmni qayta tanlang.',
    },
  },
  demo: {
    identities: 'Demo foydalanuvchilar',
  },
} as const;

type Widen<T> = T extends string ? string : { [K in keyof T]: Widen<T[K]> };
export type MessageSchema = Widen<typeof uz>;
