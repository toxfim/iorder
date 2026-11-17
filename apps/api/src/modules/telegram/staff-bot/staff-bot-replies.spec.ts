import { describe, expect, it } from 'vitest';
import { greetingName, partOfDay, staffBotStartReply } from './staff-bot-replies.js';

const URL = 'https://dashboard.example.uz/';

describe('partOfDay (Tashkent hour)', () => {
  it.each([
    [5, 'MORNING'],
    [10, 'MORNING'],
    [11, 'DAY'],
    [17, 'DAY'],
    [18, 'EVENING'],
    [23, 'EVENING'],
    [0, 'EVENING'],
    [4, 'EVENING'],
  ] as const)('%i:00 is %s', (hour, expected) => {
    expect(partOfDay(hour)).toBe(expected);
  });
});

describe('greetingName', () => {
  it('takes the first word of the full name', () => {
    expect(greetingName('Sardor Aliyev')).toBe('Sardor');
    expect(greetingName('  Azim  ')).toBe('Azim');
  });

  it('has no name for a blank or missing one', () => {
    expect(greetingName('   ')).toBeNull();
    expect(greetingName(null)).toBeNull();
  });
});

describe('staffBotStartReply', () => {
  const staff = { locale: 'UZ', isStaff: true, name: 'Sardor', staffAppUrl: URL } as const;

  it('greets a staff member by name, explains the commands, both buttons in one row', () => {
    expect(staffBotStartReply({ ...staff, tashkentHour: 8 })).toEqual({
      text:
        'Xayrli tong, Sardor!\n\nBuyruqlar:\n/start: tilni tanlash va ilovani ochish\n' +
        "/lang: tilni o'zgartirish\n" +
        '/help: ilova tugmalari va shu yordam\n\niOrder ilovasini oching:',
      buttons: [
        { text: 'Brauzerda ochish', url: URL },
        { text: 'Ilovada ochish', webAppUrl: URL, style: 'primary' },
      ],
    });
  });

  it('follows the time of day and the language', () => {
    expect(staffBotStartReply({ ...staff, tashkentHour: 14 }).text).toMatch(/^Xayrli kun, /);
    expect(staffBotStartReply({ ...staff, tashkentHour: 21 }).text).toMatch(/^Xayrli kech, /);
    const ru = staffBotStartReply({ ...staff, locale: 'RU', tashkentHour: 8 });
    expect(ru.text).toMatch(/^Доброе утро, Sardor!/);
    expect(ru.buttons.map((b) => b.text)).toEqual(['Открыть в браузере', 'Открыть в приложении']);
    expect(staffBotStartReply({ ...staff, locale: 'EN', tashkentHour: 14 }).text).toMatch(
      /^Good afternoon, Sardor!/,
    );
  });

  it('greets without a name when none is stored', () => {
    expect(staffBotStartReply({ ...staff, name: null, tashkentHour: 8 }).text).toMatch(
      /^Xayrli tong!\n/,
    );
  });

  it('says the address is missing and gives no buttons without STAFF_WEB_APP_URL', () => {
    const reply = staffBotStartReply({ ...staff, staffAppUrl: null, tashkentHour: 8 });
    expect(reply.buttons).toEqual([]);
    expect(reply.text).toContain('sozlanmagan');
  });

  it('tells anybody else only that the bot is for staff: no name, no link', () => {
    const reply = staffBotStartReply({ ...staff, isStaff: false, tashkentHour: 8 });
    expect(reply).toEqual({ text: 'Bu bot faqat iOrder xodimlari uchun.', buttons: [] });
    expect(reply.text).not.toContain('Sardor');
    expect(reply.text).not.toContain(URL);
  });
});
