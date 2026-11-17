/**
 * The "newer model" proposal generator [C, owner 2026-11-09]: pairs (older product -> newer
 * product) read from product names, for a manager or admin to confirm or reject. Conservative on
 * purpose: a missed pair costs nothing, a wrong proposal costs a manager one click. Pure: the
 * service loads the products and writes the pairs.
 *
 * Two products form a pair when they have the SAME brand, the same product line (every word
 * before the generation number), the same letter suffix glued to the number ("13C" and "14C",
 * never "13" and "13C") and the same words after it ("4/128GB", a colour), and differ ONLY in the
 * generation number. In a line with several generations every older product points to the newest.
 */

export interface SuccessionCandidate {
  id: string;
  name: string;
  /** The resolved brand, lower-case; null = no brand, the product cannot be paired. */
  brandKey: string | null;
  isActive: boolean;
}

export interface SuccessionProposal {
  olderProductId: string;
  newerProductId: string;
}

export interface ProposalOptions {
  /** Products in the published price list: a newer model must be orderable to be worth showing. */
  pricedProductIds: ReadonlySet<string>;
  /** Products some organization received: only a bought older product can ever be shown a successor. */
  boughtProductIds: ReadonlySet<string>;
}

interface ModelName {
  line: string;
  generation: number;
  suffix: string;
  tail: string;
}

/**
 * Numbers glued to one of these are capacities, powers and sizes, not generations: 20W, 65W,
 * 128GB, 6.5L (no match anyway), 80mm, 5V, 3A, 4K, 12MP, 10X.
 */
const UNIT_SUFFIXES: ReadonlySet<string> = new Set([
  'w',
  'gb',
  'tb',
  'mb',
  'mah',
  'ah',
  'mm',
  'cm',
  'm',
  'l',
  'ml',
  'v',
  'a',
  'k',
  'x',
  'hz',
  'mp',
  'g',
  'kg',
  'in',
  'd',
  'h',
  'kw',
  'db',
]);

/** A whole number of one to three digits, optionally with one or two letters glued to it. */
const GENERATION = /^(\d{1,3})([a-z]{0,2})$/u;

const tokensOf = (name: string): string[] =>
  name
    .toLowerCase()
    .split(/[\s,;()[\]{}«»"'|]+/u)
    .map((token) => token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter((token) => token !== '');

/** The first generation number of a name with the words around it; null when the name has none. */
export function parseModelName(name: string): ModelName | null {
  const tokens = tokensOf(name);
  for (let i = 1; i < tokens.length; i += 1) {
    const match = GENERATION.exec(tokens[i] ?? '');
    if (match === null) continue;
    const suffix = match[2] ?? '';
    if (UNIT_SUFFIXES.has(suffix)) continue;
    // "80 mm", "10000 mAh" (the number alone is a unit value when a unit word follows it).
    const next = tokens[i + 1];
    if (suffix === '' && next !== undefined && UNIT_SUFFIXES.has(next)) continue;
    const generation = Number(match[1]);
    if (generation === 0) continue;
    return {
      line: tokens.slice(0, i).join(' '),
      generation,
      suffix,
      tail: tokens.slice(i + 1).join(' '),
    };
  }
  return null;
}

/**
 * The pairs to propose. Each older product (bought by someone) points to every active, priced
 * product of its line with the HIGHEST generation; a line with one generation yields nothing.
 */
export function proposeSuccessions(
  candidates: readonly SuccessionCandidate[],
  options: ProposalOptions,
): SuccessionProposal[] {
  const lines = new Map<string, { candidate: SuccessionCandidate; model: ModelName }[]>();
  for (const candidate of candidates) {
    if (candidate.brandKey === null) continue;
    const model = parseModelName(candidate.name);
    if (model === null) continue;
    const key = [candidate.brandKey, model.line, model.suffix, model.tail].join('|');
    const members = lines.get(key) ?? [];
    members.push({ candidate, model });
    lines.set(key, members);
  }

  const proposals: SuccessionProposal[] = [];
  for (const members of lines.values()) {
    const newest = Math.max(...members.map((m) => m.model.generation));
    const newer = members.filter(
      (m) =>
        m.model.generation === newest &&
        m.candidate.isActive &&
        options.pricedProductIds.has(m.candidate.id),
    );
    if (newer.length === 0) continue;
    for (const older of members) {
      if (older.model.generation >= newest) continue;
      if (!options.boughtProductIds.has(older.candidate.id)) continue;
      for (const target of newer) {
        proposals.push({ olderProductId: older.candidate.id, newerProductId: target.candidate.id });
      }
    }
  }
  return proposals;
}
