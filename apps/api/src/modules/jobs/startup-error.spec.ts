import { describe, expect, it } from 'vitest';
import { JobQueueMissingError } from './job-runtime.js';
import { describeStartupFailure } from './startup-error.js';

describe('describeStartupFailure', () => {
  it('maps the pg-boss "not installed" error to a fixed hint', () => {
    expect(describeStartupFailure(new Error('pg-boss is not installed'))).toContain(
      'run jobs:migrate',
    );
  });

  it('maps the pg-boss "requires migrations" error to a fixed hint', () => {
    expect(describeStartupFailure(new Error('pg-boss database requires migrations'))).toContain(
      'out of date',
    );
  });

  it('keeps the missing-queue text', () => {
    expect(describeStartupFailure(new JobQueueMissingError())).toContain('run jobs:migrate');
  });

  it('reduces any other error to its name, without the message', () => {
    const error = Object.assign(new Error('connect ECONNREFUSED postgres://u:secret@db:5432/x'), {
      name: 'ConnectionError',
    });
    const text = describeStartupFailure(error);
    expect(text).toBe('The worker could not start (ConnectionError).');
    expect(text).not.toContain('secret');
    expect(describeStartupFailure('boom')).toBe('The worker could not start (error).');
  });
});
