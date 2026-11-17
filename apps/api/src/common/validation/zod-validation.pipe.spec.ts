import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { InputValidationError } from '../errors/domain-errors.js';
import { ZodValidationPipe } from './zod-validation.pipe.js';

const pipe = new ZodValidationPipe(
  z.object({ quantity: z.coerce.number().positive(), note: z.string().optional() }),
);

describe('ZodValidationPipe', () => {
  it('returns parsed and coerced data', () => {
    expect(pipe.transform({ quantity: '3' })).toEqual({ quantity: 3 });
  });

  it('strips unknown fields instead of passing them through', () => {
    expect(pipe.transform({ quantity: 1, isAdmin: true })).toEqual({ quantity: 1 });
  });

  it('throws InputValidationError with the failing path', () => {
    try {
      pipe.transform({ quantity: -1 });
      expect.unreachable('transform should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(InputValidationError);
      expect((error as InputValidationError).issues[0]?.path).toBe('quantity');
    }
  });

  it('rejects a non-object body', () => {
    expect(() => pipe.transform(undefined)).toThrow(InputValidationError);
  });
});
