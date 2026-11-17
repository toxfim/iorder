import type { ActivityHistoryMessages } from './uz';

// First draft: needs a native-speaker review.
export const activityHistoryRu: ActivityHistoryMessages = {
  title: 'История действий',
  subtitle: 'Единый журнал аудита заказов, цен, сотрудников и организаций.',
  info: {
    title: 'У каждого изменения есть своя история',
    summary: 'Записей: {count} · с прежними и новыми значениями',
    retention: 'Хранение: бессрочно',
    noDelete: 'Удаление запрещено',
  },
  search: 'Заказ, сотрудник, организация или комментарий',
  filters: {
    group: 'Фильтры истории',
    object: 'Объект',
    allObjects: 'Все объекты',
  },
  results: 'Найдено: {count}',
  footer: '{shown} / {total} записей · Новые → старые',
  tableLabel: 'Записи истории действий',
  columns: {
    at: 'Дата и время',
    actor: 'Автор',
    object: 'Объект',
    action: 'Действие',
    change: 'Прежнее → новое значение',
  },
  time: '{time} · UTC+5',
  actor: {
    system: 'Система',
    systemRole: 'Автоматически',
    customer: 'Клиент · {organization}',
  },
  objects: {
    ORDER: 'Заказ',
    PRICE_LIST: 'Прайс-лист',
    PAYMENT: 'Оплата',
    STAFF: 'Сотрудник',
    ORGANIZATION: 'Организация',
  },
  actions: {
    ORDER_SUBMITTED: 'Заказ отправлен',
    ORDER_APPROVED: 'Менеджер подтвердил',
    ORDER_ACCOUNTING_CLEARED: 'Бухгалтерия подтвердила',
    ORDER_RELEASED: 'Отгружен со склада',
    ORDER_DELIVERED: 'Доставлен',
    ORDER_CANCELLED: 'Отменён',
    PRICE_LIST_PUBLISHED: 'Цены опубликованы',
    PAYMENT_RECORDED: 'Оплата внесена',
    STAFF_BLOCKED: 'Доступ приостановлен',
    STAFF_ROLE_GRANTED: 'Роль выдана',
    ORGANIZATION_ACTIVATED: 'Организация активирована',
  },
  values: {
    none: '—',
    active: 'Активен',
    inactive: 'Приостановлен',
    version: 'v{number}',
  },
  detail: {
    title: 'Подробности события · {action}',
    meta: '{date}, {time} · {actor}',
    object: 'Объект',
    before: 'Прежнее значение',
    after: 'Новое значение',
    note: 'Комментарий',
    noNote: 'Комментария нет.',
  },
  noMatch: 'По запросу ничего не найдено',
  empty: {
    title: 'Записей пока нет',
    description: 'Первое действие появится здесь.',
  },
  unavailable: {
    title: 'История действий пока недоступна',
    description:
      'Каждое действие записывается на сервере, но страница для его просмотра ещё не подключена. После подключения записи появятся здесь.',
  },
};
