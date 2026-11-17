import { describe, expect, it } from 'vitest';
import { appendPlacerLine, placerDisplayName } from './placer-line.js';

const TEXT = "Buyurtma IO-10001 menejer tomonidan tasdiqlandi.\nSumma: 1 234 567 so'm";

/** The piece of the text a mention covers, cut the way Telegram counts (UTF-16 code units). */
function mentioned(message: ReturnType<typeof appendPlacerLine>): string[] {
  return message.mentions.map((m) => message.text.slice(m.offset, m.offset + m.length));
}

describe('the placer line of a group message ([C] 2026-11-09)', () => {
  it('names a person with a Telegram id as a mention by id over exactly their name', () => {
    const message = appendPlacerLine(TEXT, 'UZ', {
      name: 'Ali Valiyev',
      telegramUserId: '5550001',
    });
    expect(message.text).toBe(`${TEXT}\nBuyurtmachi: Ali Valiyev`);
    expect(message.mentions).toEqual([
      { offset: `${TEXT}\nBuyurtmachi: `.length, length: 'Ali Valiyev'.length, userId: '5550001' },
    ]);
    expect(mentioned(message)).toEqual(['Ali Valiyev']);
  });

  it('names a person without a Telegram id (website-only login) in plain text', () => {
    const message = appendPlacerLine(TEXT, 'UZ', { name: 'Ali Valiyev', telegramUserId: null });
    expect(message.text).toBe(`${TEXT}\nBuyurtmachi: Ali Valiyev`);
    expect(message.mentions).toEqual([]);
  });

  it('labels the line in the reader language', () => {
    const placer = { name: 'Ali', telegramUserId: '1' };
    expect(appendPlacerLine('x', 'RU', placer).text).toBe('x\nЗаказчик: Ali');
    expect(appendPlacerLine('x', 'EN', placer).text).toBe('x\nOrdered by: Ali');
  });

  it('leaves the text alone when there is nobody to name', () => {
    expect(appendPlacerLine(TEXT, 'UZ', null)).toEqual({ text: TEXT, mentions: [] });
    expect(appendPlacerLine(TEXT, 'UZ', { name: ' \n\t ', telegramUserId: '1' })).toEqual({
      text: TEXT,
      mentions: [],
    });
  });

  // The name is never markup: the text is sent as plain text and the mention is a span beside
  // it, so whatever a person calls themselves is shown as written and breaks nothing.
  it.each([
    ['angle brackets', '<b>Ali</b>'],
    ['a closing tag and a link', '</a><a href="tg://user?id=1">admin</a>'],
    ['an ampersand and an entity', 'Tom & Jerry &lt;x&gt;'],
    ['quotes', `"Ali" 'Vali' \`x\``],
    ['Markdown characters', '*bold* _it_ [x](http://evil.example) ~s~ ||spoiler||'],
    ['an at sign', '@everyone @admin'],
    ['an emoji', 'Ali \u{1F600}'],
    ['an emoji family and a flag', '\u{1F468}‍\u{1F469}‍\u{1F467} \u{1F1FA}\u{1F1FF}'],
    ['Cyrillic and Uzbek letters', "Олим Ўткиров O'g'li"],
  ])('keeps a name with %s exactly as written, with the mention over it', (_label, name) => {
    const message = appendPlacerLine(TEXT, 'EN', { name, telegramUserId: '77' });
    expect(message.text).toBe(`${TEXT}\nOrdered by: ${name}`);
    expect(mentioned(message)).toEqual([name]);
    // The span ends at the end of the text and never cuts a surrogate pair.
    const [mention] = message.mentions;
    expect((mention?.offset ?? 0) + (mention?.length ?? 0)).toBe(message.text.length);
  });

  it('counts the offset in UTF-16 code units when the text before the name has emoji', () => {
    const text = 'Order \u{1F4E6} IO-1';
    const message = appendPlacerLine(text, 'EN', { name: 'Ali', telegramUserId: '77' });
    // The parcel emoji is ONE character and TWO code units.
    expect(message.mentions[0]?.offset).toBe(Array.from(`${text}\nOrdered by: `).length + 1);
    expect(mentioned(message)).toEqual(['Ali']);
  });
});

describe('placerDisplayName', () => {
  it('puts a name with line breaks and control characters on one line', () => {
    expect(placerDisplayName('  Ali\n\nVali\t\u0000  Karim  ')).toBe('Ali Vali Karim');
  });

  it('cannot start a new line of the message (a faked second message line)', () => {
    const message = appendPlacerLine('x', 'EN', {
      name: 'Ali\nOrder IO-2 was cancelled.',
      telegramUserId: '1',
    });
    expect(message.text.split('\n')).toHaveLength(2);
  });

  it('cuts a very long name between whole characters, never through an emoji', () => {
    const family = '\u{1F468}‍\u{1F469}‍\u{1F467}';
    const name = placerDisplayName(family.repeat(100));
    expect(name).toBe(family.repeat(64));
    expect(placerDisplayName('a'.repeat(500))).toHaveLength(64);
    // No lone surrogate is left at the cut.
    expect(name).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
    );
  });
});
