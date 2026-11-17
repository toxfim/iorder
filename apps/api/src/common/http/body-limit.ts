import type { NestExpressApplication } from '@nestjs/platform-express';

/**
 * Largest JSON request body the api accepts. Nothing in the product sends large JSON (carts,
 * orders and price-list edits are small; no file upload goes through JSON), so the Express default
 * of 100 kb is kept but written down, so it is a decision and not an accident. A bigger body is
 * refused with 413 PAYLOAD_TOO_LARGE before it is parsed. [P]
 */
export const JSON_BODY_LIMIT = '100kb';

/** Applies the body limit. Shared by main.ts and the test apps so tests run the real setting. */
export function applyBodyLimit(app: NestExpressApplication): void {
  app.useBodyParser('json', { limit: JSON_BODY_LIMIT });
}
