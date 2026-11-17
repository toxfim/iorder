import type { Locale } from '@iorder/shared';
import type { TextMention } from '../telegram/index.js';

// The line that names the person who placed the order, under a customer-side message in the
// organization's group ([C] owner 2026-11-09). PURE.
//
// The name is a mention by Telegram id (a `text_mention` entity), which notifies the person with
// or without a username; usernames are not stored. The name is part of a PLAIN text: the mention
// is a span beside the text, so nothing a person calls themselves can become markup. A person
// without a Telegram id (a website-only login) is named in plain text.

export interface OrderPlacer {
  name: string;
  /** Decimal string; null when the person cannot be mentioned. */
  telegramUserId: string | null;
}

export interface NamedMessage {
  text: string;
  mentions: TextMention[];
}

const LABEL: Record<Locale, string> = {
  UZ: 'Buyurtmachi',
  RU: 'Заказчик',
  EN: 'Ordered by',
};

const NAME_MAX_CHARACTERS = 64;
const characters = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/**
 * The name as one short line: line breaks and control characters become spaces, and a long name
 * is cut between whole characters (never through an emoji, which would leave a broken half).
 */
export function placerDisplayName(raw: string): string {
  const oneLine = raw.replace(/[\p{Cc}\p{Zl}\p{Zp}\s]+/gu, ' ').trim();
  const kept = Array.from(characters.segment(oneLine), (part) => part.segment);
  return kept.slice(0, NAME_MAX_CHARACTERS).join('').trimEnd();
}

/**
 * The text with the placer line added and, when the person has a Telegram id, the mention over
 * their name. Offsets count UTF-16 code units (what Telegram expects and what a JS string index
 * is). Unchanged text when there is nobody to name.
 */
export function appendPlacerLine(
  text: string,
  locale: Locale,
  placer: OrderPlacer | null,
): NamedMessage {
  const name = placer === null ? '' : placerDisplayName(placer.name);
  if (placer === null || name === '') return { text, mentions: [] };
  const before = `${text}\n${LABEL[locale]}: `;
  return {
    text: `${before}${name}`,
    mentions:
      placer.telegramUserId === null
        ? []
        : [{ offset: before.length, length: name.length, userId: placer.telegramUserId }],
  };
}
