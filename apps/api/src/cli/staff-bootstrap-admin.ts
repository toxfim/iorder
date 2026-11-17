import { isStaffLogin, STAFF_PASSWORD_MAX_LENGTH } from '@iorder/shared/staff-auth';
import { ConflictError, InputValidationError } from '../common/errors/domain-errors.js';
import type {
  BootstrapAdminAccountInput,
  BootstrapAdminAccountResult,
} from '../modules/identity/index.js';
import { checkSeedSafeguards, describeDatabase } from './seed-admin.js';

export interface BootstrapArgs {
  allowProduction: boolean;
  yes: boolean;
}

export type ParsedBootstrapArgs =
  { ok: true; args: BootstrapArgs } | { ok: false; unknown: string[] };

/** Only the known flags are accepted; anything else is an error, never silently ignored. */
export function parseBootstrapArgs(argv: readonly string[]): ParsedBootstrapArgs {
  const args: BootstrapArgs = { allowProduction: false, yes: false };
  const unknown: string[] = [];
  for (const arg of argv) {
    if (arg === '--allow-production') args.allowProduction = true;
    else if (arg === '--yes') args.yes = true;
    else unknown.push(arg);
  }
  return unknown.length > 0 ? { ok: false, unknown } : { ok: true, args };
}

export interface BootstrapDeps {
  /** The raw values of BOOTSTRAP_ADMIN_LOGIN / BOOTSTRAP_ADMIN_PASSWORD (read at run time from the environment). */
  login: string | undefined;
  password: string | undefined;
  argv: readonly string[];
  nodeEnv: string | undefined;
  /** The raw DATABASE_URL; only its host and database name are ever printed. */
  databaseUrl: string | undefined;
  /**
   * True when this login is not an existing administrator but ACTIVE administrators already exist,
   * so the run would add another one. Optional so a caller without a database can skip it.
   */
  hasOtherAdmins?: (login: string) => Promise<boolean>;
  bootstrap: (input: BootstrapAdminAccountInput) => Promise<BootstrapAdminAccountResult>;
  log: (line: string) => void;
}

/**
 * Creates or updates the administrator account (login + password). It never prints the password or
 * its hash and never reads either from a file: both come from the environment of this run. Returns
 * the process exit code.
 */
export async function bootstrapStaffAdmin(deps: BootstrapDeps): Promise<number> {
  const parsed = parseBootstrapArgs(deps.argv);
  if (!parsed.ok) {
    deps.log(
      `Unknown argument(s): ${parsed.unknown.join(' ')}. Allowed: --allow-production, --yes.`,
    );
    return 1;
  }
  const target = describeDatabase(deps.databaseUrl);
  if (!target) {
    deps.log('DATABASE_URL is missing or not a valid URL; refusing to run.');
    return 1;
  }
  deps.log(`Database: host=${target.host} name=${target.database}`);
  const refusal = checkSeedSafeguards({ nodeEnv: deps.nodeEnv, args: parsed.args, target });
  if (refusal) {
    deps.log(refusal);
    return 1;
  }
  const login = deps.login?.trim().toLowerCase();
  if (!login || !isStaffLogin(login)) {
    deps.log(
      'BOOTSTRAP_ADMIN_LOGIN is missing or is not a valid login (for example admin@iorder.uz).',
    );
    return 1;
  }
  if (deps.hasOtherAdmins && (await deps.hasOtherAdmins(login))) {
    deps.log(
      `WARNING: other administrator accounts already exist and "${login}" is a different login; this run adds another administrator.`,
    );
    if (!parsed.args.yes) {
      deps.log(
        'Refusing without --yes. Run again with --yes if you really want another administrator.',
      );
      return 1;
    }
  }
  const password = deps.password;
  if (!password) {
    deps.log('BOOTSTRAP_ADMIN_PASSWORD is not set; refusing to run.');
    return 1;
  }
  if ([...password].length > STAFF_PASSWORD_MAX_LENGTH) {
    deps.log(`The password is longer than ${STAFF_PASSWORD_MAX_LENGTH} characters.`);
    return 1;
  }

  let result: BootstrapAdminAccountResult;
  try {
    result = await deps.bootstrap({ login, password });
  } catch (error) {
    // Domain messages never carry the password; anything else is withheld by the caller.
    if (error instanceof InputValidationError || error instanceof ConflictError) {
      const detail =
        error instanceof InputValidationError
          ? error.issues.map((issue) => issue.message).join('; ')
          : error.message;
      deps.log(`Refused: ${detail}`);
      return 1;
    }
    throw error;
  }
  deps.log(
    result.userCreated
      ? 'Administrator account created.'
      : result.passwordSet
        ? 'Administrator password updated; their sessions were ended.'
        : 'Administrator already in place with this password; nothing changed.',
  );
  return 0;
}
