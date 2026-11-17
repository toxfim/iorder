/**
 * The operator-facing text for a worker that could not start. Known pg-boss messages are mapped
 * to fixed sentences; everything else is reduced to the error name, because the message of a
 * connection or pg-boss error can contain the connection URL, host or SQL.
 */
export function describeStartupFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (message === 'pg-boss is not installed') {
    return 'The pgboss schema does not exist: run jobs:migrate (as the migrator role) first.';
  }
  if (message === 'pg-boss database requires migrations') {
    return 'The pgboss schema is out of date: run jobs:migrate (as the migrator role).';
  }
  if (error instanceof Error && error.name === 'JobQueueMissingError') return message;
  return `The worker could not start (${error instanceof Error ? error.name : 'error'}).`;
}
