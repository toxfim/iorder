import { describe, expect, it } from 'vitest';
import { orderIdOfStartParam, orderStartParam } from './mini-app-start.js';

const ORDER_ID = '0193e4a2-7c1b-7d3e-9f00-1a2b3c4d5e6f';

describe('the Mini App start value of an order', () => {
  it('round-trips an order id and stays inside what Telegram allows in startapp', () => {
    const param = orderStartParam(ORDER_ID);
    expect(param).toBe(`order_${ORDER_ID}`);
    expect(param).toMatch(/^[A-Za-z0-9_-]{1,512}$/);
    expect(orderIdOfStartParam(param ?? '')).toBe(ORDER_ID);
  });

  it('builds nothing for an id that is not a UUID', () => {
    for (const id of ['', 'o-1', '../prices', `${ORDER_ID}?x=1`, `${ORDER_ID} `]) {
      expect(orderStartParam(id), id).toBeNull();
    }
  });

  it('reads nothing from any other value', () => {
    for (const param of [
      '',
      'prices',
      'order_',
      'order_123',
      ORDER_ID,
      `order-${ORDER_ID}`,
      `order_${ORDER_ID}/placed`,
      `order_${ORDER_ID}_x`,
      `ORDER_${ORDER_ID}`,
    ]) {
      expect(orderIdOfStartParam(param), param).toBeNull();
    }
  });
});
