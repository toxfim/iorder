import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { applyBodyLimit } from './common/http/body-limit.js';
import { APP_ENV } from './config/config.module.js';
import type { Env } from './config/env.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // No framework fingerprint in responses.
  app.disable('x-powered-by');
  applyBodyLimit(app);
  app.enableShutdownHooks();
  const env = app.get<Env>(APP_ENV);
  // Must be set before the first request so request.ip is the client, not the proxy.
  if (env.TRUST_PROXY > 0) app.set('trust proxy', env.TRUST_PROXY);
  await app.listen(env.PORT);
}

void bootstrap();
