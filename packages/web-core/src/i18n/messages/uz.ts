// Uzbek is the default and the source of truth for the shape of the shared catalog.

export const coreUz = {
  signIn: {
    journeySubmit: 'Buyurtma berish',
    journeyAccepted: 'Buyurtmangiz qabul qilindi',
    journeyPacking: 'Tovarlar qadoqlanmoqda',
    journeyLoading: 'Mashinaga ortilmoqda',
    journeyDriving: "Buyurtma yo'lda",
    journeyShop: "SIZNING DO'KONINGIZ",

    previewPlaced: 'Buyurtma berildi',
    previewConfirmed: 'Buyurtma tasdiqlandi',
    previewDelivered: 'Yetkazildi',

    login: 'Login',
    password: 'Parol',
    loginPlaceholder: 'Loginingizni kiriting',
    passwordPlaceholder: 'Parolingizni kiriting',
    showPassword: "Parolni ko'rsatish",
    hidePassword: 'Parolni yashirish',
    show: "Ko'rsatish",
    hide: 'Yashirish',
    forgotPassword: 'Parolni unutdingizmi?',
    submit: 'Kirish',
    wait: 'Kuting: {seconds} s',
    or: 'yoki',
    telegram: 'Telegram orqali davom etish',
    telegramUnavailable: 'Telegram orqali kirish hozir sozlanmagan.',
    previewOrder: 'BUYURTMA № 1048',
    previewQuantity: '4 ta mahsulot · 12 dona',
  },
  common: {
    currency: "so'm",
    close: 'Yopish',
    /** Closes a dialog that only explains something. */
    understood: 'Tushunarli',
    cancel: 'Bekor qilish',
    undo: 'Bekor qilish',
    back: 'Orqaga',
    language: 'Til',
    theme: 'Mavzu',
    themeSystem: 'Tizim',
    themeLight: "Yorug'",
    themeDark: "Qorong'u",
    search: 'Qidiruv',
    /** The one sales unit (PIECE_UNIT): the company sells whole pieces only. */
    unitPiece: 'dona',
  },
  state: {
    loading: 'Yuklanmoqda…',
    retry: 'Qayta urinish',
    reload: 'Qayta yuklash',
    outdated: {
      title: 'Yangilanish kerak',
      description: 'Ilova yangilanishi kerak. Sahifani qayta yuklang.',
    },
    empty: {
      title: "Hozircha ma'lumot yo'q",
      description: "Yangi ma'lumot paydo bo'lganda shu yerda ko'rinadi.",
    },
    error: {
      title: "Yuklab bo'lmadi",
      description: "Internet aloqasini tekshirib, qayta urinib ko'ring.",
    },
    denied: {
      title: "Ruxsat yo'q",
      description: 'Bu sahifa sizning rolingiz uchun yopiq.',
    },
  },
  apiErrors: {
    // All new: the design has no error copy for the price screens.
    denied: "Bu amal uchun ruxsatingiz yo'q.",
    timeout: "Server javob bermadi (vaqt tugadi). Qayta urinib ko'ring.",
    network: "Internet aloqasi yo'q. Tekshirib, qayta urinib ko'ring.",
    invalidResponse: "Server kutilmagan javob qaytardi. Keyinroq qayta urinib ko'ring.",
    generic: "Amalni bajarib bo'lmadi. Qayta urinib ko'ring.",
    draftAlreadyOpen: "Qoralama allaqachon ochiq. Uni nashr qiling yoki o'chiring.",
    draftClosed:
      "Bu qoralama endi tahrirlanmaydi: u nashr qilingan yoki o'chirilgan. Sahifani yangilang.",
    // One message per shared CONFLICT reason (see CONFLICT_REASON_MESSAGES).
    draftNotOpen: 'Bu qoralama allaqachon nashr qilingan. Sahifani yangilang.',
    versionNotDraft: "Bu versiya qoralama emas, uni o'zgartirib bo'lmaydi.",
    invalidTransition: "Versiya holatini bunday o'zgartirib bo'lmaydi. Sahifani yangilang.",
    emptyDraft: "Qoralama bo'sh: nashr qilish uchun kamida bitta tovar narxini kiriting.",
    noPublishedVersion: "Nusxa olish uchun nashr qilingan ro'yxat yo'q. Bo'sh qoralama yarating.",
    anotherPublished:
      "Boshqa versiya oldinroq nashr qilindi. Sahifani yangilab, qayta urinib ko'ring.",
    productCodeExists: 'Bu Tovar ID allaqachon mavjud (harf registri hisobga olinmaydi).',
    removalRequestNotPending: "Bu o'chirish so'rovi allaqachon ko'rib chiqilgan.",
    orderChanged:
      "Buyurtma boshqa foydalanuvchi tomonidan o'zgartirildi. Sahifani yangilab, qayta urinib ko'ring.",
    illegalOrderTransition: "Buyurtmaning hozirgi holatida bu amalni bajarib bo'lmaydi.",
    orderNotEditable: "Bu buyurtma tovarlarini endi o'zgartirib bo'lmaydi.",
    paymentMethodNotChangeable: "Bu buyurtmaning savdo turini endi o'zgartirib bo'lmaydi.",
    paymentPlanNotChangeable: "Bu buyurtmaning to'lov turini endi o'zgartirib bo'lmaydi.",
    paymentPlanWindowEnded: "To'lov turini o'zgartirish vaqti tugadi.",
    currencyConversionUnavailable:
      "Hozir summani hisoblab bo'lmaydi. Birozdan keyin qayta urinib ko'ring.",
    cartTotalChanged: "Narx o'zgardi, buyurtma berilmadi. Yangi summani tekshirib, qayta yuboring.",
    deferredPriceUnavailable: "Bo'lib to'lash mumkin emas: tovarlardan birida bunday narx yo'q.",
    emptyCart: "Savat bo'sh.",
    productNotOrderable: "Savatdagi ba'zi tovarlarni hozir buyurtma qilib bo'lmaydi.",
    stockLimitExceeded: "Omborda buncha tovar yo'q. Savatdagi miqdorni kamaytiring.",
    stockLimitExceededOne: 'Omborda faqat {count} dona bor. Miqdorni kamaytiring.',
    stockLimitExceededNone: 'Bu tovar omborda qolmagan.',
    idempotencyKeyReused:
      "Bu buyurtma so'rovi allaqachon boshqa foydalanuvchi tomonidan yuborilgan.",
    orderingOrganizationInactive: 'Bu tashkilot buyurtma bera olmaydi.',
    staffOrderingDisabled: 'Kompaniya xodimlari bu yerda buyurtma bera olmaydi.',
    contactRequired: 'Avval ismingiz va telefon raqamingizni kiriting.',
    lastAdmin: 'Tizimda kamida bitta faol administrator qolishi kerak.',
    telegramIdRequired: "Telegram ID si yo'q odam xodim rolida qolishi kerak.",
    organizationNotLinked:
      "Bu tashkilot Telegramga hali ulanmagan: mijoz ulanish havolasini ishlatganda u o'zi faollashadi.",
    organizationAlreadyLinked:
      'Bu tashkilot Telegramga allaqachon ulangan: yangi havola kerak emas.',
    personOrganization:
      "Shaxs tashkilotida faqat ulangan odam do'kon egasi bo'ladi: uning rolini o'zgartirib bo'lmaydi.",
    organizationArchived:
      "Bu tashkilot arxivda: uni o'zgartirishdan oldin administrator arxivdan tiklashi kerak.",
    botNotConfigured: 'Telegram bot hali sozlanmagan. Administratorga xabar bering.',
    unitCodeDuplicate: 'Bu kod boshqa donaga allaqachon yozilgan.',
    unitCodeNotRequired: 'Bu mahsulot uchun bunday kod kerak emas.',
    unitCodesNotEditable: 'Kodlar faqat tasdiqdan ombordan chiqarishgacha skanerlanadi.',
    goodsReturnNotPending: "Bu buyurtmada qaytarilishi kutilayotgan tovar yo'q.",
    allocationChanged: "Qoldiq o'zgardi. Yangi rejani tekshirib, tasdiqlang.",
    stockInsufficient: 'Bu buyurtma uchun qoldiq yetmaydi.',
    supplyPartyConflict: 'Mavjud partiya raqamlari bilan nima qilishni tanlang.',
    supplyPartyChanged:
      "Boshqa menejer bu partiyani o'zgartirdi. Ro'yxatni tekshirib, qayta saqlang.",
    supplyNotAvailable: "Tanlangan postavka sheetda endi yo'q.",
    allocationNotChangeable: "Bu buyurtma uchun endi tovar band qilib bo'lmaydi.",
    unitCodesIncomplete:
      'Ayrim donalarning kodi kiritilmagan. Chiqarishdan oldin ularni skanerlang.',
    duplicateCategoryName: 'Bu nomdagi kategoriya allaqachon mavjud.',
    categoryArchived: 'Kategoriya arxivda. Uni tiklang yoki boshqasini tanlang.',
    paymentVoided: "Bu to'lov bekor qilingan, uni endi o'zgartirib bo'lmaydi.",
    priceListChanged:
      "Narxlar ro'yxati shu orada boshqa xodim tomonidan yangilandi. Joriy narxlar qayta yuklandi; o'zgarishlaringizni tekshirib, yana saqlang.",
    emptyPriceList: "Narxlar ro'yxati bo'sh qolmasligi kerak: kamida bitta tovar narxi qolsin.",
    reservedProductCodePrefix:
      "«IO-» bilan boshlanadigan kodni qo'lda kiritib bo'lmaydi: bu prefiks tizim beradigan kodlar uchun.",
    notGeneratedCode:
      "Faqat sheetda yo'q (qo'lda qo'shilgan) tovarni sheet tovari bilan bog'lash mumkin.",
    targetIsGenerated: "Bog'lash uchun sheetdagi tovarni tanlang, qo'lda qo'shilganini emas.",
    productAlreadyMerged:
      "Bu tovar allaqachon sheet tovari bilan bog'langan; uni o'zgartirib bo'lmaydi.",
    sheetSyncQueueUnavailable:
      "Bu serverda fon ishlari o'chiq: sinxronizatsiyani ishga tushirib bo'lmaydi.",
    duplicateBrandName: 'Bunday nomli brend allaqachon bor (harf registri hisobga olinmaydi).',
    productImageDuplicate: 'Bu rasm tovarda allaqachon bor.',
    primaryImageExists:
      'Tovarning asosiy rasmi allaqachon bor. Yangi rasmni alohida tugma bilan asosiy qiling.',
    inactiveProducts:
      "{count} ta faol bo'lmagan tovarga narx qo'yib bo'lmaydi. Ularni ro'yxatdan olib tashlang.",
    inactiveInDraft:
      "Qoralamada {count} ta faol bo'lmagan tovar bor. Nashr qilishdan oldin ularni olib tashlang.",
    conflict: "Amal hozirgi holat bilan to'qnashdi. Sahifani yangilab, qayta urinib ko'ring.",
    unknownProducts: '{count} ta tovar topilmadi.',
    notFound: 'Topilmadi.',
    gone: 'Bu element endi mavjud emas. Sahifani yangilang.',
    validation: "Kiritilgan ma'lumotlarda xato bor. Qizil belgilangan qatorlarni tekshiring.",
  },
  // Payment status (UNPAID / PAID): one wording for customers and staff alike.
  paymentStatus: { UNPAID: "To'lanmagan", PAID: "To'langan" },
  telegramWidget: {
    unavailable: "Telegram tugmasini yuklab bo'lmadi. Login va parol bilan kiring.",
  },
} as const;

type Widen<T> = T extends string ? string : { [K in keyof T]: Widen<T[K]> };
export type CoreMessageSchema = Widen<typeof coreUz>;
