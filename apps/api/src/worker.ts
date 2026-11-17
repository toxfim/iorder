import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ClockModule } from './common/clock/clock.js';
import { DatabaseModule } from './common/database/database.module.js';
import { ConfigModule } from './config/config.module.js';
import { loadEnv } from './config/env.js';
import { describeStartupFailure, JobsModule, JobsService } from './modules/jobs/index.js';

// The WORKER process (ADR-001 §3.4: "backend + worker"): runs the pg-boss scheduler and the job
// handlers. It is a separate process from the API and does nothing unless JOBS_ENABLED=true:
//
//   pnpm --filter @iorder/api worker
//
// Before the first start the pg-boss schema must exist: `pnpm --filter @iorder/api jobs:migrate`
// (run as the migrator/owner role). SIGTERM / SIGINT stop it gracefully: running jobs finish (up
// to a time limit), the pool closes, then the process exits.

const env = loadEnv();

@Module({
  imports: [ConfigModule, ClockModule, DatabaseModule, JobsModule.register(env)],
})
class WorkerModule {}

async function main(): Promise<void> {
  if (!env.JOBS_ENABLED) {
    // Checked before anything is built: no database connection, no scheduler.
    console.log('Jobs are switched off (JOBS_ENABLED is not true): the worker does nothing.');
    return;
  }
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    logger: ['log', 'warn', 'error'],
  });
  const jobs = app.get(JobsService);
  try {
    await jobs.start(env.DATABASE_URL);
  } catch (error) {
    // Fixed texts only: the message of a connection or pg-boss error can contain the URL.
    console.error(describeStartupFailure(error));
    await jobs.stop().catch(() => undefined);
    await app.close();
    process.exitCode = 1;
    return;
  }

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) {
      console.error(`${signal} again: exiting immediately.`);
      process.exit(1);
    }
    stopping = true;
    console.log(`${signal} received: stopping the worker.`);
    void jobs
      .stop()
      .catch(() => {
        process.exitCode = 1;
      })
      .then(() => app.close())
      .then(() => {
        process.exit();
      });
  };
  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });
}

void main();
