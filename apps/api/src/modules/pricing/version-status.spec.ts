import { describe, expect, it } from 'vitest';
import { ConflictError } from '../../common/errors/domain-errors.js';
import {
  assertVersionTransition,
  canTransitionVersion,
  type VersionStatus,
} from './version-status.js';

const ALL: VersionStatus[] = ['DRAFT', 'PUBLISHED', 'ARCHIVED'];
const ALLOWED: [VersionStatus, VersionStatus][] = [
  ['DRAFT', 'PUBLISHED'],
  ['PUBLISHED', 'ARCHIVED'],
];

describe('price list version transitions', () => {
  it.each(ALLOWED)('allows %s -> %s', (from, to) => {
    expect(canTransitionVersion(from, to)).toBe(true);
    expect(() => assertVersionTransition(from, to)).not.toThrow();
  });

  const forbidden = ALL.flatMap((from) =>
    ALL.map((to): [VersionStatus, VersionStatus] => [from, to]),
  ).filter(([from, to]) => !ALLOWED.some(([f, t]) => f === from && t === to));

  it.each(forbidden)('forbids %s -> %s', (from, to) => {
    expect(canTransitionVersion(from, to)).toBe(false);
    expect(() => assertVersionTransition(from, to)).toThrow(ConflictError);
  });

  it('covers all 9 pairs', () => {
    expect(forbidden.length + ALLOWED.length).toBe(9);
  });
});
