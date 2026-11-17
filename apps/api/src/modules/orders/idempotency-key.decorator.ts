import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { idempotencyKeySchema, IDEMPOTENCY_KEY_HEADER } from '@iorder/shared';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';

const pipe = new ZodValidationPipe(idempotencyKeySchema);

/**
 * The `Idempotency-Key` request header, required and validated at the boundary (a missing or
 * malformed key is a 422 naming the header). Express lower-cases header names.
 */
export const IdempotencyKey = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const request = context
    .switchToHttp()
    .getRequest<{ headers: Record<string, string | string[] | undefined> }>();
  const value = request.headers[IDEMPOTENCY_KEY_HEADER.toLowerCase()];
  // A repeated header arrives as an array (or comma-joined): never accept it as one key.
  return pipe.transform(value);
});
