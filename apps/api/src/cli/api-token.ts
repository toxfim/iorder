import { z } from 'zod';
import { InputValidationError, NotFoundError } from '../common/errors/domain-errors.js';
import type { IssueApiTokenInput, IssuedApiToken } from '../modules/identity/index.js';
import {
  API_TOKEN_DEFAULT_DAYS,
  API_TOKEN_MAX_DAYS,
  API_TOKEN_SCOPES,
  isApiTokenScope,
  type ApiTokenScope,
} from '../modules/identity/api-token.js';
import { describeDatabase } from './seed-admin.js';

export type Parsed<T> = { ok: true; args: T } | { ok: false; problem: string };

/** Reads `--flag value` pairs; every flag must be known and every value present. */
function readFlags(
  argv: readonly string[],
  known: readonly string[],
): Parsed<Map<string, string[]>> {
  const flags = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i] ?? '';
    const value = argv[i + 1];
    if (!known.includes(flag)) return { ok: false, problem: `Unknown argument: ${flag}` };
    if (value === undefined || value.startsWith('--')) {
      return { ok: false, problem: `${flag} needs a value` };
    }
    flags.set(flag, [...(flags.get(flag) ?? []), value]);
    i += 1;
  }
  return { ok: true, args: flags };
}

const ISSUE_FLAGS = ['--user', '--name', '--days', '--scope'] as const;

export function parseIssueArgs(argv: readonly string[]): Parsed<IssueApiTokenInput> {
  const read = readFlags(argv, ISSUE_FLAGS);
  if (!read.ok) return read;
  const single = (flag: string): string | undefined => {
    const values = read.args.get(flag);
    return values?.length === 1 ? values[0] : undefined;
  };
  for (const flag of ['--user', '--name', '--days']) {
    if ((read.args.get(flag)?.length ?? 0) > 1) {
      return { ok: false, problem: `${flag} may be given once` };
    }
  }
  const login = single('--user');
  const name = single('--name');
  if (!login) return { ok: false, problem: '--user <staff login> is required' };
  if (!name) return { ok: false, problem: '--name <label> is required' };
  const daysText = single('--days') ?? String(API_TOKEN_DEFAULT_DAYS);
  const days = z.coerce.number().int().min(1).max(API_TOKEN_MAX_DAYS).safeParse(daysText);
  if (!days.success) {
    return { ok: false, problem: `--days must be a whole number from 1 to ${API_TOKEN_MAX_DAYS}` };
  }
  const scopeValues = read.args.get('--scope') ?? [];
  if (scopeValues.length === 0) {
    return { ok: false, problem: `--scope is required (one of: ${API_TOKEN_SCOPES.join(', ')})` };
  }
  const unknown = scopeValues.filter((value) => !isApiTokenScope(value));
  if (unknown.length > 0) {
    return {
      ok: false,
      problem: `Unknown scope(s): ${unknown.join(', ')}. Allowed: ${API_TOKEN_SCOPES.join(', ')}`,
    };
  }
  const scopes = [...new Set(scopeValues)] as ApiTokenScope[];
  return { ok: true, args: { login, name, days: days.data, scopes } };
}

export function parseRevokeArgs(argv: readonly string[]): Parsed<{ id: string }> {
  const read = readFlags(argv, ['--id']);
  if (!read.ok) return read;
  const values = read.args.get('--id') ?? [];
  const id = z.uuid().safeParse(values[0]);
  if (values.length !== 1 || !id.success) {
    return { ok: false, problem: '--id <token id (uuid)> is required, once' };
  }
  return { ok: true, args: { id: id.data } };
}

interface CommonDeps {
  argv: readonly string[];
  /** The raw DATABASE_URL; only its host and database name are ever printed. */
  databaseUrl: string | undefined;
  log: (line: string) => void;
}

function printTarget(deps: CommonDeps): boolean {
  const target = describeDatabase(deps.databaseUrl);
  if (!target) {
    deps.log('DATABASE_URL is missing or not a valid URL; refusing to run.');
    return false;
  }
  deps.log(`Database: host=${target.host} name=${target.database}`);
  return true;
}

/** Domain refusals are printed; anything else is rethrown (the entry point withholds details). */
function refusal(error: unknown): string | null {
  if (error instanceof InputValidationError) {
    return error.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ');
  }
  if (error instanceof NotFoundError) return error.message;
  return null;
}

/**
 * `api:token-issue`: prints the new token ONCE. Its hash is all the database keeps, so a lost token
 * cannot be shown again: revoke it and issue a new one. Returns the process exit code.
 */
export async function issueApiTokenCommand(
  deps: CommonDeps & { issue: (input: IssueApiTokenInput) => Promise<IssuedApiToken> },
): Promise<number> {
  const parsed = parseIssueArgs(deps.argv);
  if (!parsed.ok) {
    deps.log(parsed.problem);
    return 1;
  }
  if (!printTarget(deps)) return 1;
  try {
    const { token, record } = await deps.issue(parsed.args);
    deps.log(`Token id: ${record.id}`);
    deps.log(`Acts as: ${parsed.args.login} · scopes: ${record.scopes.join(', ')}`);
    deps.log(`Expires: ${record.expiresAt.toISOString()}`);
    deps.log('Token (shown once, store it in a secret store, never in a repository):');
    deps.log(token);
    return 0;
  } catch (error) {
    const reason = refusal(error);
    if (reason === null) throw error;
    deps.log(`Refused: ${reason}`);
    return 1;
  }
}

/** `api:token-revoke`: the token stops working at once. Returns the process exit code. */
export async function revokeApiTokenCommand(
  deps: CommonDeps & { revoke: (id: string) => Promise<boolean> },
): Promise<number> {
  const parsed = parseRevokeArgs(deps.argv);
  if (!parsed.ok) {
    deps.log(parsed.problem);
    return 1;
  }
  if (!printTarget(deps)) return 1;
  try {
    const revoked = await deps.revoke(parsed.args.id);
    deps.log(revoked ? 'Token revoked.' : 'Token was already revoked; nothing changed.');
    return 0;
  } catch (error) {
    const reason = refusal(error);
    if (reason === null) throw error;
    deps.log(`Refused: ${reason}`);
    return 1;
  }
}
