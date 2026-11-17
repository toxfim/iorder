import type { CoreMessageSchema } from './uz';

export const coreRu: CoreMessageSchema = {
  signIn: {
    journeySubmit: 'Заказать',
    journeyAccepted: 'Ваш заказ принят',
    journeyPacking: 'Упаковываем товары',
    journeyLoading: 'Загружаем в машину',
    journeyDriving: 'Заказ в пути',
    journeyShop: 'ВАШ МАГАЗИН',

    previewPlaced: 'Заказ оформлен',
    previewConfirmed: 'Заказ подтверждён',
    previewDelivered: 'Доставлен',

    login: 'Логин',
    password: 'Пароль',
    loginPlaceholder: 'Введите логин',
    passwordPlaceholder: 'Введите пароль',
    showPassword: 'Показать пароль',
    hidePassword: 'Скрыть пароль',
    show: 'Показать',
    hide: 'Скрыть',
    forgotPassword: 'Забыли пароль?',
    submit: 'Войти',
    wait: 'Подождите: {seconds} с',
    or: 'или',
    telegram: 'Продолжить через Telegram',
    telegramUnavailable: 'Вход через Telegram пока не настроен.',
    previewOrder: 'ЗАКАЗ № 1048',
    previewQuantity: '4 товара · 12 единиц',
  },
  common: {
    currency: 'сум',
    close: 'Закрыть',
    /** Closes a dialog that only explains something. */
    understood: 'Понятно',
    cancel: 'Отмена',
    undo: 'Отменить',
    back: 'Назад',
    language: 'Язык',
    theme: 'Тема',
    themeSystem: 'Системная',
    themeLight: 'Светлая',
    themeDark: 'Тёмная',
    search: 'Поиск',
    /** The one sales unit (PIECE_UNIT): the company sells whole pieces only. */
    unitPiece: 'шт.',
  },
  state: {
    loading: 'Загрузка…',
    retry: 'Повторить',
    reload: 'Перезагрузить',
    outdated: {
      title: 'Нужно обновление',
      description: 'Нужно обновить приложение. Перезагрузите страницу.',
    },
    empty: {
      title: 'Пока нет данных',
      description: 'Новые данные появятся здесь.',
    },
    error: {
      title: 'Не удалось загрузить',
      description: 'Проверьте соединение и попробуйте снова.',
    },
    denied: {
      title: 'Нет доступа',
      description: 'Эта страница закрыта для вашей роли.',
    },
  },
  apiErrors: {
    denied: 'У вас нет прав на это действие.',
    timeout: 'Сервер не ответил вовремя. Попробуйте снова.',
    network: 'Нет соединения. Проверьте интернет и попробуйте снова.',
    invalidResponse: 'Сервер вернул неожиданный ответ. Попробуйте позже.',
    generic: 'Не удалось выполнить действие. Попробуйте снова.',
    draftAlreadyOpen: 'Черновик уже открыт. Опубликуйте или удалите его.',
    draftClosed:
      'Этот черновик больше нельзя редактировать: он опубликован или удалён. Обновите страницу.',
    // One message per shared CONFLICT reason (see CONFLICT_REASON_MESSAGES).
    draftNotOpen: 'Этот черновик уже опубликован. Обновите страницу.',
    versionNotDraft: 'Эта версия не является черновиком, её нельзя изменить.',
    invalidTransition: 'Статус версии нельзя изменить таким образом. Обновите страницу.',
    emptyDraft: 'Черновик пуст: укажите цену хотя бы одного товара, чтобы опубликовать.',
    noPublishedVersion: 'Нет опубликованного списка для копирования. Создайте пустой черновик.',
    anotherPublished:
      'Другая версия была опубликована раньше. Обновите страницу и попробуйте снова.',
    productCodeExists: 'Такой ID товара уже существует (регистр букв не учитывается).',
    removalRequestNotPending: 'Этот запрос на удаление уже обработан.',
    orderChanged: 'Заказ был изменён другим пользователем. Обновите страницу и попробуйте снова.',
    illegalOrderTransition: 'Это действие невозможно для заказа в его текущем статусе.',
    orderNotEditable: 'Позиции этого заказа больше нельзя изменять.',
    paymentMethodNotChangeable: 'Способ оплаты этого заказа больше нельзя изменить.',
    paymentPlanNotChangeable: 'Условия оплаты этого заказа больше нельзя изменить.',
    paymentPlanWindowEnded: 'Время для изменения условий оплаты истекло.',
    currencyConversionUnavailable:
      'Сейчас не удаётся рассчитать сумму. Повторите попытку немного позже.',
    cartTotalChanged:
      'Цена изменилась, заказ не оформлен. Проверьте новую сумму и отправьте снова.',
    deferredPriceUnavailable: 'Отсрочка недоступна: у одного из товаров нет такой цены.',
    emptyCart: 'Корзина пуста.',
    productNotOrderable: 'Некоторые товары в корзине сейчас нельзя заказать.',
    stockLimitExceeded: 'Такого количества нет в наличии. Уменьшите количество в корзине.',
    stockLimitExceededOne: 'В наличии только {count} шт. Уменьшите количество.',
    stockLimitExceededNone: 'Этого товара нет в наличии.',
    idempotencyKeyReused: 'Этот запрос на заказ уже был отправлен другим пользователем.',
    orderingOrganizationInactive: 'Эта организация не может оформлять заказы.',
    staffOrderingDisabled: 'Сотрудники компании не могут оформлять заказы здесь.',
    contactRequired: 'Сначала укажите имя и номер телефона.',
    lastAdmin: 'В системе должен остаться хотя бы один активный администратор.',
    telegramIdRequired: 'Человек без Telegram ID должен оставаться сотрудником.',
    organizationNotLinked:
      'Организация ещё не подключена к Telegram: она активируется сама, когда клиент воспользуется ссылкой.',
    organizationAlreadyLinked: 'Организация уже подключена к Telegram: новая ссылка не нужна.',
    personOrganization:
      'В организации частного лица единственный владелец магазина — подключённый человек: его роль изменить нельзя.',
    organizationArchived:
      'Организация в архиве: прежде чем что-то менять, администратор должен её восстановить.',
    botNotConfigured: 'Telegram-бот ещё не настроен. Сообщите администратору.',
    unitCodeDuplicate: 'Этот код уже записан на другую единицу товара.',
    unitCodeNotRequired: 'Для этого товара такой код не нужен.',
    unitCodesNotEditable: 'Коды сканируются только от подтверждения до выдачи со склада.',
    goodsReturnNotPending: 'По этому заказу нет товара, ожидающего возврата.',
    allocationChanged: 'Остаток изменился. Проверьте новый план и подтвердите.',
    stockInsufficient: 'Остатка не хватает для этого заказа.',
    supplyPartyConflict: 'Выберите, что делать с уже привязанными партиями.',
    supplyPartyChanged: 'Другой менеджер изменил эту партию. Проверьте список и сохраните ещё раз.',
    supplyNotAvailable: 'Выбранной поставки больше нет в таблице.',
    allocationNotChangeable: 'Для этого заказа уже нельзя резервировать товар.',
    unitCodesIncomplete: 'У некоторых единиц нет кодов. Отсканируйте их перед выдачей.',
    duplicateCategoryName: 'Категория с таким названием уже есть.',
    categoryArchived: 'Категория в архиве. Восстановите её или выберите другую.',
    paymentVoided: 'Этот платёж аннулирован, изменить его уже нельзя.',
    priceListChanged:
      'Прайс-лист тем временем обновил другой сотрудник. Текущие цены перезагружены; проверьте свои изменения и сохраните снова.',
    emptyPriceList: 'Прайс-лист не может остаться пустым: оставьте цену хотя бы одного товара.',
    reservedProductCodePrefix:
      'Код, начинающийся с «IO-», нельзя ввести вручную: этот префикс только для кодов, которые выдаёт система.',
    notGeneratedCode:
      'Связать с товаром из таблицы можно только товар, добавленный вручную (без ID из таблицы).',
    targetIsGenerated: 'Для связи выберите товар из таблицы, а не добавленный вручную.',
    productAlreadyMerged: 'Этот товар уже связан с товаром из таблицы; изменить его нельзя.',
    sheetSyncQueueUnavailable:
      'На этом сервере фоновые задачи выключены: запустить синхронизацию нельзя.',
    duplicateBrandName: 'Бренд с таким названием уже есть (регистр букв не учитывается).',
    productImageDuplicate: 'Это фото уже есть у товара.',
    primaryImageExists:
      'У товара уже есть главное фото. Сделайте новое фото главным отдельной кнопкой.',
    inactiveProducts:
      'Неактивному товару ({count}) нельзя назначить цену. Уберите его из черновика. | Неактивным товарам ({count}) нельзя назначить цену. Уберите их из черновика. | Неактивным товарам ({count}) нельзя назначить цену. Уберите их из черновика.',
    inactiveInDraft:
      'В черновике {count} неактивный товар. Уберите его перед публикацией. | В черновике {count} неактивных товара. Уберите их перед публикацией. | В черновике {count} неактивных товаров. Уберите их перед публикацией.',
    conflict: 'Действие противоречит текущему состоянию. Обновите страницу и попробуйте снова.',
    unknownProducts:
      'Не найден {count} товар. | Не найдено {count} товара. | Не найдено {count} товаров.',
    notFound: 'Не найдено.',
    gone: 'Этого элемента больше нет. Обновите страницу.',
    validation: 'В данных есть ошибки. Проверьте строки, отмеченные красным.',
  },
  // Payment status (UNPAID / PAID): one wording for customers and staff alike.
  paymentStatus: { UNPAID: 'Не оплачен', PAID: 'Оплачен' },
  telegramWidget: {
    unavailable: 'Не удалось загрузить кнопку Telegram. Войдите по логину и паролю.',
  },
};
