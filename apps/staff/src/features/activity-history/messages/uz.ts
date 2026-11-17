// Staff-only prose of the activity history page. Merged under `activityHistory` after a dynamic
// import, for the staff area only. Uzbek (Latin) is the source of truth for the shape.

export const activityHistoryUz = {
  title: 'Faoliyat tarixi',
  subtitle: 'Buyurtmalar oqimi, narxlar, xodimlar va tashkilotlarning yagona audit jurnali.',
  info: {
    title: "Har bir o'zgarishning o'z tarixi bor",
    summary: '{count} ta yozuv · oldingi va yangi qiymatlar bilan',
    retention: 'Saqlash: muddatsiz',
    noDelete: "O'chirish taqiqlangan",
  },
  search: 'Buyurtma, xodim, tashkilot yoki izoh',
  filters: {
    group: 'Tarix filtrlari',
    object: 'Obyekt',
    allObjects: 'Barcha obyektlar',
  },
  results: '{count} ta natija',
  footer: '{shown} / {total} ta yozuv · Yangi → eski',
  tableLabel: 'Faoliyat tarixi yozuvlari',
  columns: {
    at: 'Sana va vaqt',
    actor: 'Muallif',
    object: 'Obyekt',
    action: 'Amal',
    change: 'Oldingi → yangi qiymat',
  },
  time: '{time} · UTC+5',
  actor: {
    system: 'Tizim',
    systemRole: 'Avtomatik',
    customer: 'Mijoz · {organization}',
  },
  objects: {
    ORDER: 'Buyurtma',
    PRICE_LIST: 'Narxlar ro‘yxati',
    PAYMENT: "To'lov",
    STAFF: 'Xodim',
    ORGANIZATION: 'Tashkilot',
  },
  actions: {
    ORDER_SUBMITTED: 'Buyurtma yuborildi',
    ORDER_APPROVED: 'Menejer tasdiqladi',
    ORDER_ACCOUNTING_CLEARED: 'Buxgalteriya tasdiqladi',
    ORDER_RELEASED: 'Ombordan chiqarildi',
    ORDER_DELIVERED: 'Yetkazildi',
    ORDER_CANCELLED: 'Bekor qilindi',
    PRICE_LIST_PUBLISHED: "Narxlar e'lon qilindi",
    PAYMENT_RECORDED: "To'lov kiritildi",
    STAFF_BLOCKED: "Kirish to'xtatildi",
    STAFF_ROLE_GRANTED: 'Rol berildi',
    ORGANIZATION_ACTIVATED: 'Tashkilot faollashtirildi',
  },
  values: {
    none: '—',
    active: 'Faol',
    inactive: "To'xtatilgan",
    version: 'v{number}',
  },
  detail: {
    title: 'Voqea tafsilotlari · {action}',
    meta: '{date}, {time} · {actor}',
    object: 'Obyekt',
    before: 'Oldingi qiymat',
    after: 'Yangi qiymat',
    note: 'Izoh',
    noNote: 'Izoh yozilmagan.',
  },
  noMatch: 'Qidiruvga mos yozuv topilmadi',
  empty: {
    title: "Hali yozuv yo'q",
    description: "Birinchi amal bajarilgach, u shu yerda ko'rinadi.",
  },
  unavailable: {
    title: 'Faoliyat tarixi hali mavjud emas',
    description:
      "Har bir amal serverda yozib borilmoqda, lekin uni ko'rsatadigan sahifa hali ulanmagan. Ulangach, yozuvlar shu yerda chiqadi.",
  },
};

export type ActivityHistoryMessages = typeof activityHistoryUz;
