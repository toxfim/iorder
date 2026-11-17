import { telegramUserIdSchema } from '@iorder/shared';
import { ConflictError } from '../common/errors/domain-errors.js';
import type { BootstrapAdminResult } from '../modules/identity/index.js';

/** Databases a developer can seed without an explicit `--yes`. */
export const SAFE_DATABASE_NAMES: readonly string[] = ['iorder_dev', 'iorder_test'];

export interface SeedArgs {
  allowProduction: boolean;
  yes: boolean;
}

export type ParsedSeedArgs = { ok: true; args: SeedArgs } | { ok: false; unknown: string[] };

/** Only the two known flags are accepted; anything else is an error, never silently ignored. */
export function parseSeedArgs(argv: readonly string[]): ParsedSeedArgs {
  const args: SeedArgs = { allowProduction: false, yes: false };
  const unknown: string[] = [];
  for (const arg of argv) {
    if (arg === '--allow-production') args.allowProduction = true;
    else if (arg === '--yes') args.yes = true;
    else unknown.push(arg);
  }
  return unknown.length > 0 ? { ok: false, unknown } : { ok: true, args };
}

export interface DatabaseTarget {
  host: string;
  database: string;
}

/** Host and database name only. Never returns (or throws with) the user, password or the URL. */
export function describeDatabase(databaseUrl: string | undefined): DatabaseTarget | null {
  if (!databaseUrl) return null;
  try {
    const url = new URL(databaseUrl);
    const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
    if (url.hostname === '' || database === '') return null;
    return { host: url.hostname, database };
  } catch {
    return null;
  }
}

/** Returns the reason to refuse, or null when the run may proceed. */
export function checkSeedSafeguards(input: {
  nodeEnv: string | undefined;
  args: SeedArgs;
  target: DatabaseTarget;
}): string | null {
  if (input.nodeEnv === 'production' && !input.args.allowProduction) {
    return 'NODE_ENV is production; refusing to seed. Pass --allow-production if this is intended.';
  }
  if (!SAFE_DATABASE_NAMES.includes(input.target.database) && !input.args.yes) {
    return `The database is not one of ${SAFE_DATABASE_NAMES.join(', ')}; pass --yes to confirm.`;
  }
  return null;
}

export interface SeedAdminDeps {
  /** The raw `DEVELOPER_TELEGRAM_ID` value, or undefined when it is not configured. */
  telegramId: string | undefined;
  /** Command line arguments after the script name. */
  argv: readonly string[];
  nodeEnv: string | undefined;
  /** The raw DATABASE_URL; only its host and database name are ever printed. */
  databaseUrl: string | undefined;
  bootstrapAdmin: (telegramUserId: bigint) => Promise<BootstrapAdminResult>;
  log: (line: string) => void;
}

/**
 * First-administrator bootstrap. Refuses to run unless the safeguards pass and
 * DEVELOPER_TELEGRAM_ID is valid. It never prints the id, the password or a token: the output
 * says only which database it uses and what changed. Returns the process exit code.
 */
export async function seedAdmin(deps: SeedAdminDeps): Promise<number> {
  const parsed = parseSeedArgs(deps.argv);
  if (!parsed.ok) {
    deps.log(
      `Unknown argument(s): ${parsed.unknown.join(' ')}. Allowed: --allow-production, --yes.`,
    );
    return 1;
  }
  const target = describeDatabase(deps.databaseUrl);
  if (!target) {
    deps.log('DATABASE_URL is missing or not a valid URL; refusing to seed.');
    return 1;
  }
  deps.log(`Database: host=${target.host} name=${target.database}`);
  const refusal = checkSeedSafeguards({ nodeEnv: deps.nodeEnv, args: parsed.args, target });
  if (refusal) {
    deps.log(refusal);
    return 1;
  }

  if (!deps.telegramId) {
    deps.log('DEVELOPER_TELEGRAM_ID is not set; refusing to seed an administrator.');
    return 1;
  }
  // The only place this value is validated (the API's boot-time schema does not read it).
  const id = telegramUserIdSchema.safeParse(deps.telegramId);
  if (!id.success) {
    deps.log('DEVELOPER_TELEGRAM_ID is not a valid Telegram user id; refusing to seed.');
    return 1;
  }

  let result: BootstrapAdminResult;
  try {
    result = await deps.bootstrapAdmin(BigInt(id.data));
  } catch (error) {
    if (error instanceof ConflictError && error.reason === 'USER_BLOCKED') {
      deps.log(
        'The user for DEVELOPER_TELEGRAM_ID is BLOCKED; not reactivating. Unblock them first.',
      );
      return 1;
    }
    throw error;
  }
  const changes = [
    result.userCreated ? 'user created' : null,
    result.roleAdded ? 'ADMIN role added' : null,
  ].filter((change): change is string => change !== null);
  deps.log(
    changes.length === 0
      ? 'Administrator already in place; nothing changed.'
      : `Administrator ensured: ${changes.join(', ')}.`,
  );
  return 0;
}
