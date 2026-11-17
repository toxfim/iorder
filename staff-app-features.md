# Staff ilovasi (`apps/staff`): funksiyalar va sahifalar

Holat: 2026-10-26, `master` + ishchi nusxadagi o'zgarishlar. Bu hujjat kod asosida yozilgan (`apps/staff/src`), sahifalarning **nima qilishini** tasvirlaydi, ko'rinishini emas.

Umumiy qoida: ilovadagi rol tekshiruvlari faqat qulaylik uchun (tugma yashirish). Har bir ruxsatni server o'zi qayta tekshiradi.

---

## 1. Rollar va kim qaysi sahifaga kiradi

| Sahifa (yo'l)                                             | ADMIN | MANAGER |    ACCOUNTANT    | WAREHOUSE | DRIVER |
| --------------------------------------------------------- | :---: | :-----: | :--------------: | :-------: | :----: |
| Bosh sahifa (`/staff/dashboard`)                          |   ✓   |    ✓    |                  |           |        |
| Barcha buyurtmalar (`/staff/orders`)                      |   ✓   |    ✓    |                  |           |        |
| Buyurtma sahifasi (`/staff/orders/:id`)                   |   ✓   |    ✓    |        ✓         |     ✓     |   ✓    |
| Buxgalteriya navbati (`/staff/accounting`)                |       |         |        ✓         |           |        |
| Ombor: chiqarishga (`/staff/warehouse`)                   |       |         |                  |     ✓     |        |
| Yetkazishlar (`/staff/deliveries`)                        |       |         |                  |           |   ✓    |
| Narxlar (`/staff/prices`)                                 |   ✓   |    ✓    | ✓ (faqat o'qish) |           |        |
| Narx versiyalari, Mahsulotlar, Kategoriyalar              |   ✓   |    ✓    |                  |           |        |
| Qoldiq / Ombor ma'lumoti (`/staff/stock`)                 |   ✓   |    ✓    |        ✓         |           |        |
| Buyurtma orqali (`/staff/by-order`)                       |   ✓   |    ✓    |        ✓         |           |        |
| Mijozlar (`/staff/customers`)                             |   ✓   |    ✓    |                  |           |        |
| Tashkilotlar / Telegram guruhlar (`/staff/organizations`) |   ✓   |    ✓    |                  |           |        |
| Xodimlar (`/staff/employees`)                             |   ✓   |    ✓    |                  |           |        |

- Kirgandan keyin har kim o'zi ocha oladigan **birinchi** sahifaga tushadi: admin/menejer → Bosh sahifa, buxgalter → Buxgalteriya navbati, ombor → Chiqarishga, haydovchi → Yetkazishlar.
- Staff roli yo'q odam (masalan, mijoz) → "Ruxsat yo'q" sahifasi.
- Sidebar va router bitta ro'yxatdan (`features/staff-shell/nav-config.ts`) quriladi, shuning uchun ko'rinadigan, lekin ochilmaydigan menyu bo'lmaydi.

### Real API va faqat fake (demo) ma'lumot

| Holat                                                         | Bo'limlar                                                                                                                                                             |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Real API bor                                                  | Kirish, buyurtmalar (hamma rollar), bosh sahifa xulosasi (summary), narxlar, katalog, qoldiq/sinx, USD kursi, tashkilotlar, xodimlar, bloklash, bot bildirishnomalari |
| Backend route **yo'q** (real build'da xato holati yoki bo'sh) | **Mijozlar** bo'limi (Customers, Organization card, Member), **"So'nggi amallar"** lentasi, **Savdo statistikasi** grafigi                                            |

---

## 2. Kirish (Login) va sessiya

- **Saytda kirish:** login + parol yoki **Telegram Login Widget** (bot nomi sozlangan bo'lsa).
- **Telegram Mini App ichida:** login ekrani yo'q, Telegram init data orqali avtomatik kiradi.
- Har qanday rad javobi bir xil xabar beradi ("Kirib bo'lmadi..."). Juda ko'p urinishda (429) teskari sanoq bilan ikkala usul ham vaqtincha bloklanadi.
- Sessiya tokeni faqat `sessionStorage`da (tab yopilsa yo'qoladi).
- Sessiya tugasa (401) → login sahifasi, keyin xavfsiz `redirect` bilan avvalgi sahifaga qaytadi (faqat shu rolga ruxsat bo'lsa).
- Tarmoq xatosida "Sessiya xatosi" sahifasi, qayta urinish tugmasi bilan.
- Chiqish (Sign out) foydalanuvchi menyusida.

---

## 3. Bosh sahifa (Dashboard) — admin, menejer

- **Salomlashuv** (Toshkent vaqti bo'yicha ertalab/kunduzi/kechqurun), sana va rollar.
- **Narx ro'yxati belgisi:** "Narx ro'yxati vN · nashr vaqti", narxsiz mahsulotlar soni.
- **KPI kartalar:**
  - _Tasdiq kutmoqda:_ soni + eng eski buyurtma yoshi, "Navbatni ochish" → `stage=SUBMITTED` filtri.
  - _Bugungi buyurtmalar:_ soni va summasi (rad etilgan/bekor qilinganlarsiz), → `period=today`.
  - _Chiqqandan keyin to'lanmagan:_ summa, buyurtmalar va mijozlar soni, → `period=debt`.
- **Xulosa paneli** (pastda 9-bo'limga qarang).
- **"Tasdiq kutayotgan buyurtmalar" ro'yxati:** tashkilot, raqam, vaqt, kim joylagan, summa, pozitsiyalar.
  - "Ochish" → buyurtma sahifasi.
  - "Tasdiqlash" (faqat **menejer**) → tasdiqlash oynasi: buyurtma tarkibi (4 qator + "yana N ta"), jami, joylagan odamga qo'ng'iroq havolasi, **to'lov usuli majburiy** (Naqd / Rasmiy), ixtiyoriy "buxgalteriyasiz davom ettirish".
- **"Yetkazildi, lekin to'lanmagan":** birinchi 4 ta, "To'langan deb belgilash" (admin, menejer).
- **Bosqichlar bo'yicha taqsimot:** har bosqichdagi buyurtmalar soni, bosilsa shu bosqich filtri bilan ro'yxat ochiladi.
- **Savdo statistikasi** (7/30 kun, grafik): **faqat fake API'da**, real build'da chizilmaydi.
- **So'nggi amallar:** real build'da endpoint yo'q, doim "Hali amallar yo'q".

---

## 4. Buyurtmalar ro'yxati — admin, menejer

- Barcha buyurtmalarni yuklaydi (100 tadan, 20 sahifagacha); kesilsa "ro'yxat to'liq emas" eslatmasi chiqadi. Filtrlash brauzerda.
- **Sarlavha:** "N ta buyurtma · jami X UZS" (rad/bekor qilinganlarsiz).
- **Ustunlar** (hammasi saralanadi): raqam, mijoz (tashkilot), holat, kim joylagan*, to'lov holati*, jami*, pozitsiyalar soni, yuborilgan vaqt, buyurtma yoshi. (* faqat pul ko'radigan rollarga)
- **Filtrlar** (URL'da saqlanadi, havola va "Orqaga" ishlaydi):
  - Qidiruv: raqam, tashkilot, joylagan odam ismi.
  - Holat tablari soni bilan: Hammasi, Menejerda, Buxgalteriyada, Omborda, Ombordan chiqdi, Yetkazildi, Yakunlandi, Rad/bekor. Menejer uchun "Menejerda" tabi "(sizning qadamingiz)" belgisi bilan ikkinchi o'rinda.
  - Filtr oynasi: to'lov (To'lanmagan/To'langan), davr ("Bugun" — Toshkent vaqti; "Yetkazilgan, to'lanmagan").
  - Olib tashlanadigan chiplar, natija soni, "Filtrlarni tozalash".
- Standart tartib: ochiq buyurtmalar bosqich bo'yicha, eng yangisi oldin; yopilganlari oxirida.
- Ro'yxatning o'zida amal yo'q, qatorni bosish buyurtmani ochadi.

---

## 5. Buyurtma sahifasi — barcha staff rollari

Har bir rol faqat **o'z qadamini** ko'radi. Boshqa holatda "Keyingi qadam: kim" yoziladi. Adminga: "Administrator ish oqimi qadamlarini bajarmaydi".

### 5.1 Nimalar ko'rsatiladi

- Raqam, tashkilot, holat, to'lov holati*, kim joylagan, yaratilgan vaqt, yoshi.
- **6 bosqichli progress:** Yuborildi → Menejer → Buxgalteriya → Ombor → Yetkazildi → Yakunlandi (buxgalteriya o'tkazib yuborilgan bo'lsa "o'tkazib yuborildi").
- Yopilgan buyurtmada: "Rad etildi / Bekor qilindi · sabab: ...".
- **Tarkib:** nomi, buyurtma paytidagi narx* (ombor/haydovchiga mahsulot kodi), miqdor × birlik, qator summasi*, jami.
- _*Mijoz izohi*._*
- **Yetkazish kontakti:** tashkilot, odamlar ("Buyurtma bergan", "Do'kon egasi"), bosib qo'ng'iroq qilinadigan telefon. Buxgalterga telefonlar ko'rsatilmaydi.
- **Haydovchi:** ismi va telefoni (yoki "hali ombordan chiqmagan").
- **Tarix (timeline):** har bir hodisa, kim (ombor/haydovchiga faqat rol), qachon, holat o'zgarishi, sabab/izoh, buxgalteriya rejimi, haydovchi tayinlanishi, tarkib o'zgarishlari (eski → yangi miqdor, eski/yangi jami), to'lov holati va usuli o'zgarishi, yuborilgan bildirishnomalar (yuborildi / navbatda / yetmadi).

\* Pul ma'lumoti faqat menejer, admin, buxgalterga. Ombor va haydovchi serverdan **pulsiz "fulfilment" ko'rinishi**ni oladi (narx, jami, to'lov holati, joylagan odam ismi yo'q).

### 5.2 Amallar (rol va holat bo'yicha)

**Menejer, `SUBMITTED` holatida**

1. **To'lov usuli majburiy:** Naqd yoki Rasmiy (oldindan tanlanmagan). Tanlanmaguncha "Tasdiqlash" o'chiq.
2. **"Buxgalteriya tasdig'isiz davom ettirish"** belgisi (ixtiyoriy). Belgilansa ikkinchi tasdiqlash so'raladi ("bu qaytarilmaydi").
3. **Tasdiqlash** → buyurtma buxgalteriyaga (yoki to'g'ridan omborga) o'tadi.
4. **Rad etish** → sabab oynasi; mijozga xabar boradi.
5. **Bekor qilish** ("Boshqa amallar" ichida) → sabab oynasi.
6. **Tarkibni tahrirlash** (faqat shu holatda): har qatorda −, +, × (o'chirish). Birinchi o'zgarishda "Miqdorlarni o'zgartirasizmi? Mijozga xabar boriladi" tasdig'i. Saqlanmagan o'zgarishlar paneli: nima o'zgardi, eski → yangi jami va farq. "Saqlash" = bitta tarix hodisasi + bitta mijoz xabari. Saqlanmagan o'zgarish bor ekan, Tasdiqlash/Rad o'chiq; sahifadan chiqishda "Qolish / Saqlamasdan chiqish / Saqlash" oynasi.

**Menejer, `MANAGER_APPROVED` yoki `ACCOUNTING_CLEARED`:** faqat **Bekor qilish** (sabab bilan). Haydovchi olib ketgandan (`RELEASED`) keyin bekor qilib bo'lmaydi.

**Buxgalter, `MANAGER_APPROVED`:** **Buxgalteriya tasdig'i** yoki **Rad etish** (sabab bilan).

**Ombor, `ACCOUNTING_CLEARED`:**

- Haydovchini tanlash (faol haydovchilar ro'yxati).
- Barcha talab qilingan **mahsulot kodlari skanerlanmaguncha** "Ombordan chiqarish" o'chiq ("Tayyor: x/y" va yetishmayotgan mahsulotlar ro'yxati).
- "Ombordan chiqarish" = chiqarish + haydovchiga topshirish bitta qadam (`RELEASED`).

**Haydovchi, `RELEASED`:** ixtiyoriy izoh (1000 belgigacha, masalan "eshik oldida qoldirildi") + **"Yetkazildi"**.

**Qabul qilish (`RECEIVED`)** staff tomonida yo'q, uni mijoz tasdiqlaydi.

**Sabab oynasi** (rad va bekor): tez tanlov chiplari ("Omborda yo'q", "Narx eskirgan", "Mijoz so'rovi bilan") + matn. Bo'sh sabab qabul qilinmaydi.

### 5.3 To'lov holati va to'lov usuli

- **To'lov holati** (To'lanmagan/To'langan): menejer va admin, istalgan holatda. Bekor qilish (Undo) toasti bor. Ish oqimini hech qachon to'xtatmaydi.
- **To'lov usuli** (Naqd/Rasmiy): faqat menejer va buxgalter ko'radi. Menejer tasdiqlangandan keyin ham o'zgartira oladi (rad/bekor qilinganda emas). Buxgalter faqat o'qiydi.

### 5.4 Mahsulot kodlarini skanerlash (Picking)

- Kodlarni menejer, buxgalter, admin, ombor ko'radi; haydovchi ko'rmaydi.
- **Faqat ombor**, faqat `ACCOUNTING_CLEARED` holatida skanerlaydi.
- Har bir dona uchun joylar: IMEI 1, IMEI 2 (ixtiyoriy), SN, Markirovka kodi (mahsulot qoidasiga qarab). "Sonli" mahsulotlarda skanerlash yo'q.
- Skaner Enter yuboradi; avval brauzerda tekshiriladi (IMEI 15 raqam + nazorat raqami, faqat lotin, soxta takrorlar, SN formati, markirovka uzunligi, buyurtma ichida takror), keyin serverga.
- Kursor keyingi bo'sh majburiy joyga o'tadi. To'ldirilgan joyda "Qayta skanerlash" va "O'chirish".
- Xatolar ro'yxati saqlanadi (masalan, "bu kod X buyurtmada allaqachon bor"). Hammasi tayyor bo'lsa "Barcha kodlar skanerlandi".

### 5.5 Bir vaqtda ishlash himoyasi

Har bir holat o'zgarishi buyurtma versiyasini yuboradi. Boshqa xodim o'zgartirgan bo'lsa: "Buyurtmani boshqa xodim o'zgartirdi" xabari va avtomatik qayta o'qish.

---

## 6. Rol navbatlari

### Buxgalteriya navbati (buxgalter)

- **"Tasdiq navbati":** `MANAGER_APPROVED` buyurtmalar, eng eskisi oldin.
- **"Buxgalteriyasiz o'tganlar":** menejer buxgalteriyani o'tkazib yuborgan buyurtmalar (oxirgi 20 ta, faqat o'qish, "Yangi · Menejer o'tkazib yubordi" belgisi bilan).
- Har bir karta ochiladi: tarkib, kontakt va amallar paneli (tasdiqlash/rad) shu yerning o'zida. "Ochish" havolasi to'liq sahifaga.

### Chiqarishga (ombor)

- `ACCOUNTING_CLEARED` buyurtmalar, eng eskisi oldin, pulsiz.
- Kartada haydovchi tanlab chiqarish mumkin; kod yetishmasa "Kodlarni skanerlash" havolasi buyurtma sahifasiga olib boradi (skanerlash faqat o'sha yerda).

### Yetkazishlar (haydovchi)

- **"Menga biriktirilgan":** `RELEASED` buyurtmalar (server faqat shu haydovchinikini beradi), kartalar ochiq, telefonlar, izoh, "Yetkazildi".
- **"Yetkazilgan":** oxirgi 10 ta, faqat o'qish.

---

## 7. Narxlar bo'limi

### 7.1 Joriy narx ro'yxati (admin, menejer, buxgalter)

- Sarlavha: "N ta mahsulot · narxlar UZS da".
- **Ustunlar:** mahsulot ID, nomi (birlik, "Faol emas" belgisi), qoldiq*, tannarx*, sotish narxi (UZS).
  - _Qoldiq:_ taxminiy son va daraja (Yo'q / Kam (<20) / Bor / Ma'lumot yo'q).
  - _Tannarx:_ oxirgi yetkazib berishdagi USD va UZS (o'sha sanadagi kurs bilan); ustiga olib borilsa oxirgi 5 ta yetkazib berish (sana, so'rov, yetkazib beruvchi, USD, kurs, UZS).
- **Filtrlar** (URL'da): "Narxlangan / Narxsiz" tab, kategoriya tablari (soni bilan), qidiruv (ID yoki nom).
- Qatorni bosish → yon panel: **Narx tarixi** (faqat admin/menejer) va **Yetkazib berish tarixi** (sana, so'rov, yetkazib beruvchi, sotib olish usuli, kategoriya, keltirilgan/mavjud, tannarx $, kurs, tannarx UZS).
- Sarlavhada **USD kursi** (7.5 ga qarang).
- Buxgalter hammasini ko'radi, lekin hech narsani o'zgartira olmaydi.

### 7.2 Qoralama (draft) bilan ishlash — admin, menejer

- **"Tahrirlash"**: ochiq qoralama bo'lsa uni ochadi; aks holda "Yangi qoralama" oynasi: _joriy narxlar nusxasi_ yoki _bo'sh_. Faol bo'lmagan mahsulotlar nusxalanmaydi. Boshqa xodim qoralama ochgan bo'lsa, o'shani tahrirlaydi.
- **Narx kiritish:** bo'shliqlar olib tashlanadi, vergul nuqtaga aylanadi, 2 xonadan ortiq kasr — xato. Enter/Shift+Enter qatorlar bo'ylab, Escape qatorni qaytaradi. Yangi qatorlarda "Yangi" belgisi. Tahrirlashda "Farq" ustuni (eski → yangi).
- **"Mahsulot qo'shish" qatori:** qoralamada yo'q faol mahsulotni tanlab narx berish.
- **Qoralamadan olib tashlash** (tasdiq bilan).
- **Saqlash paneli:** "N ta o'zgarish", Bekor qilish / Saqlash. Qisman xatoda "X dan Y tasi saqlandi". Boshqa joyda nashr qilingan/yopilgan bo'lsa, qayta yuklanadi.
- **Qoralama banneri:** "Qoralama vN · mijozlarga ko'rinmaydi", **O'chirish** va **Nashr qilish**.
  - Nashr bloklanadi: saqlanmagan o'zgarish bor, saqlash ketyapti, qoralama bo'sh.
  - Nashr oynasi: nechta narx o'zgaradi, O'zgargan · Yangi · Olib tashlangan soni, faol bo'lmagan mahsulot ogohlantirishi.
- **Saqlanmagan o'zgarishlar himoyasi:** ilova ichida chiqishda "Davom etish / Saqlamasdan chiqish / Saqlash"; tabni yopishda brauzer ogohlantirishi.

### 7.3 "Hali narxlanmagan" tab (narx ko'ruvchilar)

- Nashr qilingan ro'yxatda narxi yo'q faol mahsulotlar: ID, nom (+ jadval kategoriyasi, birlik), qoldiq, oxirgi yetkazib berish, sotish narxi.
- Tahrirlash rejimida narxni shu yerning o'zida kiritish mumkin.
- **Ustama/marja ko'rsatkichi** (faqat shu tabda): "Ustama X% · marja Y%", "Oxirgi tannarx: N UZS", narx tannarxdan past bo'lsa ogohlantirish (bloklamaydi).
- Birligi yo'q mahsulotga narx qo'yib bo'lmaydi; "Birlikni belgilash" tugmasi mahsulot oynasini ochadi.
- Faol bo'lmaganlar alohida yig'iladigan bo'limda. Narxsizlar soni sidebar belgisiga chiqadi.

### 7.4 Versiyalar (admin, menejer)

- Ro'yxat: versiya, holat (Qoralama / Nashr qilingan / Arxiv), sana va kim, izoh, mahsulotlar soni.
- Versiya sahifasi: faqat o'qish, qidiruv, narxlar jadvali (tannarxsiz), mahsulot tarixi paneli.
- Ikki versiyani solishtirish funksiyasi **yo'q**.

### 7.5 USD kursi

- "$1 = X", manba: "Markaziy bank, sana" yoki "qo'lda, kim, sana". MB yangilanishi xato bo'lsa ogohlantirish.
- **O'zgartirish** (admin, menejer; buxgalter faqat o'qiydi): `12650`, `12 650`, `12,650` qabul qilinadi; noaniq vergul rad etiladi. 5 000–30 000 oralig'idan tashqari yoki joriydan >25% farq bo'lsa qo'shimcha tasdiq.
- **"Markaziy bankka qaytish"** (qo'lda kurs bo'lsa).

### 7.6 Mahsulotlar (admin, menejer)

- Jadval: ID, nom, birlik, kategoriya (jadvaldan), kod qoidasi (Sonli / Faqat markirovka / IMEI / IMEI + markirovka / SN / SN + markirovka), holat.
- **Yaratish:** ID (keyin o'zgarmaydi, takror bo'lmaydi), birlik, kamida bitta tilda nom (UZ/RU/EN).
- **Tahrirlash:** birlik, nomlar, **kod qoidasi** (kategoriya tanlash standart qoidani to'ldiradi; identifikator: yo'q / IMEI (IMEI 2 ixtiyoriy) / SN; "Markirovka kodi majburiy").
- **Faolsizlantirish** (tasdiq bilan: mijozlarga ko'rinmaydi, yangi qoralamada narxlanmaydi) / **Faollashtirish**.

### 7.7 Mahsulot kategoriyalari (admin, menejer)

- Kategoriya = kod qoidasi shabloni: nom, standart qoida, mahsulotlar soni, holat; Tahrirlash, Arxivlash/Tiklash.
- Yangi kategoriya jadvalda shu nomli kategoriyaga ega bog'lanmagan mahsulotlarni avtomatik bog'laydi. Tahrirlash orqaga ta'sir qilmaydi.
- **Jadval kategoriyalari paneli:** Google Sheet'dagi hali kategoriyasi yo'q «Категория» qiymatlari; har biriga turini aniq tanlash kerak (Dona / IMEI / SN + markirovka), "Saqlash (N)" hammasini bitta so'rovda yaratadi.

---

## 8. Qoldiq va Google Sheet sinxronizatsiyasi (admin, menejer, buxgalter)

- Eslatma: qoldiq taxminiy, jadvaldan o'qiladi, bron emas.
- **Jadval:** ID, nom, kategoriya, qoldiq darajasi, narxlanganmi, oxirgi yetkazib berish, yetkazib berishlar soni.
- **Filtrlar:** kategoriya, qidiruv (URL'da), "Faqat bor" (server filtri).
- Qatorni bosish → narx tarixi (admin/menejer) va yetkazib berish tarixi.
- **Oxirgi sinxronizatsiya paneli** (faqat o'qish; "Hozir sinxronlash" tugmasi **yo'q**): holat, kim/qachon ishga tushgan, qatorlar statistikasi (o'qilgan, yangi, yangilangan, o'zgarmagan, rad etilgan, o'tkazib yuborilgan, yangi mahsulotlar, tannarx nomuvofiqligi), rad etilgan qatorlar sababi bilan, o'tkazib yuborilgan yetkazib beruvchilar, yangi mahsulotlar (narxlash maslahati), tannarx farqlari %.
- **Yo'qolgan qatorlar (olib tashlash so'rovlari):** jadvaldan yo'qolgan yetkazib berish qatorlari.
  - **Tasdiqlash** (admin, menejer; tasdiq bilan): qator hisobdan chiqadi (qoldiq va tannarx tarixida hisoblanmaydi, lekin saqlanadi).
  - **Rad etish:** qator qoladi.
  - Buxgalter faqat ko'radi.
- Sidebar belgisi: ochiq so'rovlar + oxirgi sinxronda yaratilgan narxsiz mahsulotlar.

### 8.1 Buyurtma orqali (2026-11-09; admin, menejer, buxgalter, zakup menejeri)

- Sheetda «Товар_ID»si yo'q, xodim qo'shgan tovarlar: omborda turmaydi, buyurtma kelganda olib kelinadi. Mijozga bu belgi **ko'rsatilmaydi**.
- **Jadval:** tovar (nom, kod, kategoriya), brend, narx (Цена / Отсрочка), **olib kelish kerak** (ochiq buyurtmalar kutayotgan dona) va shunday buyurtmalar soni. Hozir kerak bo'lgan tovarlar tepada.
- Ochiq buyurtma = Menejerda, Buxgalteriyada yoki Omborda (ombordan hali chiqmagan).
- **Qidiruv:** nom yoki kod bo'yicha.
- Qatorni bosish → kutayotgan buyurtmalar: raqam (buyurtma sahifasiga havola), mijoz, soni, holati.
- Buyurtma qatorlarida, taqsimot rejasida va Narxlarda ham shu tovar "Buyurtma orqali" deb ataladi (qoldig'i kuzatilmaydi, hech qachon "yetmaydi" bo'lmaydi).

---

## 9. Xulosa paneli (Dashboard summary)

Bosh sahifada va uchta navbat sahifasining tepasida.

- Har 60 soniyada yangilanadi (xatoda 10 daqiqagacha sekinlashadi, tab yashirin bo'lsa to'xtaydi), "Yangilash" tugmasi, "Yangilandi: vaqt".
- **Navbat plitkalari** (soni + eng uzoq kutayotgan): Tasdiq kutmoqda, Buxgalteriya kutmoqda, Buxgalteriyasiz o'tganlar, Chiqarish kutmoqda, Yetkazish kutmoqda. Faqat rolning sahifasi bor plitkalar ko'rinadi.
- **Boshqaruv plitkalari** (server yuborsa): Jarayonda, Bugungi buyurtmalar + summa, Yetkazilgan-to'lanmagan, Faollashtirish kutayotgan guruhlar, Narxsiz mahsulotlar, Oxirgi jadval sinxi (ok / xato / hech qachon / 30 soatdan eski [P]), Dollar kursi.

---

## 10. Tashkilotlar (Telegram guruhlar) — admin, menejer (real API)

- **Ro'yxat:** tashkilot, do'kon egasi, Telegram guruh (chat id), kim qo'shgan (bot qo'shgan odam yoki staff), faol a'zolar soni, holat.
- Qidiruv (nom, chat id), holat filtri: Hammasi / **Faollashtirish kutmoqda** / Faol. Kutayotganlar birinchi.
- Banner: "N ta guruh faollashtirishni kutmoqda. Faollashtirilmaguncha a'zolar narxlarni ko'rmaydi va buyurtma bera olmaydi."
- **Tashkilot sahifasi:** guruh ID, kim qo'shgan, sanalar, do'kon egasi, guruhga narx postlari (yoqilgan/o'chirilgan, faqat o'qish).
- **Faollashtirish / Faolsizlantirish** (tasdiq oynasi bilan). Faolsizlantirishda yangi buyurtmalar va guruhga holat xabarlari to'xtaydi, tarix saqlanadi.
- **A'zolar:** hozirgi va sobiq, qo'shilgan/chiqqan sana, telefon, rol. Faol a'zoni **bloklash** mumkin (11-bo'lim).
- API'da bor, lekin UI'da yo'q: nomni o'zgartirish, narx postlarini yoqish/o'chirish, do'kon egasini tayinlash, a'zo rolini o'zgartirish.

---

## 11. Mijozlar (Customers) — admin, menejer (**faqat fake ma'lumot**)

Real build'da menyu bor, lekin backend route yo'qligi uchun sahifalar xato holatini ko'rsatadi.

- **Ro'yxat:** tashkilot, manzil, Telegram guruh, a'zolar, buyurtmalar, qarz; qidiruv va holat filtri.
- **Tashkilot kartasi:** bloklash/faollashtirish, "A'zolar" va "Buyurtmalar" tablari, faol do'kon egasi yo'qligi haqida ogohlantirish.
- **A'zo sahifasi:** telefon, Telegram, rol (Do'kon egasi / Sotuvchi), bloklash/faollashtirish, joylagan buyurtmalari.

### Bloklash oynasi (real API, Tashkilotlar sahifasidan ham ishlatiladi)

- "Faqat bloklash" (standart) yoki "Bloklash va Telegram guruh(lar)dan chiqarish".
- Chiqarish holati paneli: har guruh bo'yicha Kutilmoqda / Chiqarildi / Bajarilmadi (sabab bilan, masalan, bot admin emas). Qayta urinish mumkin bo'lgan xatolarda "Qayta urinish" [P]. Holat avtomatik qayta o'qiladi (3 s dan 15 s gacha, 40 martagacha) + qo'lda "Yangilash".

---

## 12. Xodimlar (Staff accounts) — admin, menejer (real API)

- **Ro'yxat:** xodim, login, rollar, holat, parol o'rnatilganmi, Telegram bog'langanmi, oxirgi kirish. Qidiruv, rol va holat filtrlari.
- **Menejer cheklovlari:** ADMIN rolini faqat admin bera oladi; admin akkauntida menejer hech qanday amal ko'rmaydi. Bloklash/blokdan chiqarish faqat admin.
- **Akkaunt qo'shish:** to'liq ism, login (3–32 belgi yoki email ko'rinishida), parol (kamida 12 belgi), 1–5 rol, telefon (ixtiyoriy), til (UZ/RU/EN), Telegram ID (ixtiyoriy).
  - **"Kuchli parol yaratish"** (20 belgi): yaratilgan parol bir marta ko'rsatiladi, "Nusxalash" va "Saqladim".
- **"Telegram'ni sozlash":** Telegram ID ni o'rnatish yoki olib tashlash.
- **"Login va parol":** yangi login va/yoki parol; yangi parol o'sha odamning barcha sessiyalarini tugatadi.
- **Bloklash/Blokdan chiqarish** (admin): bloklangan xodim kira olmaydi, sessiyalari tugaydi.
- Xatolar: ruxsat yo'q, oxirgi faol admin qolishi kerak, juda ko'p urinish (kutish soniyasi bilan), noto'g'ri maydonlar.

---

## 13. Umumiy funksiyalar (har bir sahifada)

- **Sidebar:** rolga qarab bo'limlar (Umumiy / Savdo / Tizim). "Buyurtmalar" guruhi: admin/menejerga "Barcha buyurtmalar", menejerga "Tasdiq kutmoqda", boshqa rollarga o'z navbati. Guruh yig'iladi (sessiya davomida eslab qolinadi), yig'ilganda o'z sonini ko'rsatadi.
- **Sidebar belgilari (badge):** tasdiq kutayotganlar, rol navbatlari soni, narxsiz mahsulotlar, sheet e'tibor talab qiladiganlari, faollashtirish kutayotgan guruhlar. Tezkor filtrlar: Bugun, To'lanmagan. Narx ro'yxati kartasi "vN · vaqt".
- **Qidiruv (Ctrl/Cmd+K):** bo'sh so'rovda menejerni kutayotgan 5 ta buyurtma + ochiladigan sahifalar; so'rov bilan buyurtmalar (5), mahsulotlar (5, narx tarixiga olib boradi). Mijozlar/a'zolar guruhi real build'da doim bo'sh.
- **Bot bildirishnomalari eslatmasi** (faqat ADMIN bo'lganlardan tashqari hammaga): bot xabar yubora olmasa ko'rinadi. "Bildirishnomalarni yoqish" bir martalik `t.me/<bot>?start=` havolasini ochadi; oyna fokusga qaytganda holat qayta tekshiriladi.
- **Sozlamalar:** til (UZ / RU / EN), mavzu (Tizim / Yorug' / Qorong'i), brauzerda saqlanadi.

---

## 14. Hali yo'q yoki chala narsalar (kod bo'yicha)

- Mijozlar bo'limi, "So'nggi amallar" lentasi, savdo grafigi — backend endpoint yo'q.
- Google Sheet'ni qo'lda "hozir sinxronlash" tugmasi yo'q; sinx tarixi ro'yxati ishlatilmaydi.
- Narx versiyalarini solishtirish yo'q; qoralama izohini tahrirlash API'da bor, UI'da yo'q.
- Tashkilotni qayta nomlash, narx postlarini boshqarish, do'kon egasini tayinlash, a'zo rolini o'zgartirish — API'da bor, UI'da yo'q.
- Bosh sahifadagi tasdiqlash oynasida "buxgalteriyasiz" uchun ikkinchi tasdiq yo'q (buyurtma sahifasida bor) — nomuvofiqlik.
- Buyurtma sahifasidagi "Orqaga" havolasi har doim barcha buyurtmalar ro'yxatiga olib boradi; buxgalter, ombor va haydovchiga bu sahifa yopiq (amalda tekshirilmagan).
- `staff-orders-api.ts`dagi izohda bekor qilishni "menejer va admin" deyilgan, UI va qoidalar bo'yicha faqat menejer — izoh eskirgan yoki serverni tekshirish kerak.
