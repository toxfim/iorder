import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { SheetReadError } from './sheet-read-error.js';

// Only these two fields are read from the key file; everything else in it is ignored.
const keySchema = z.object({
  client_email: z.string().min(3).regex(/^\S+$/),
  private_key: z.string().min(50).includes('PRIVATE KEY'),
});

/** A Google service account key. A secret: never logged, never part of an error. */
export interface ServiceAccountKey {
  readonly clientEmail: string;
  readonly privateKey: string;
}

export type KeyReader = () => Promise<ServiceAccountKey>;

/**
 * Reads the key file when asked (not at startup, so an unconfigured or broken file cannot stop the
 * API from booting). A missing, unreadable or invalid file is an AUTH error with no detail: the
 * parse error of a key file would quote its content.
 */
export function createFileKeyReader(path: string): KeyReader {
  return async () => {
    let parsed: z.infer<typeof keySchema>;
    try {
      parsed = keySchema.parse(JSON.parse(await readFile(path, 'utf8')));
    } catch {
      throw new SheetReadError('AUTH');
    }
    return { clientEmail: parsed.client_email, privateKey: parsed.private_key };
  };
}
