import { ArgumentsHost, Catch, ExceptionFilter, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { isPayloadTooLarge, toErrorResponse } from './to-error-response.js';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const { status, body, headers } = toErrorResponse(exception);
    if (status >= 500) {
      // The client gets a generic message; the real cause is only logged server-side.
      this.logger.error(
        exception instanceof Error ? (exception.stack ?? exception.message) : String(exception),
      );
    }
    if (isPayloadTooLarge(exception)) {
      // The client's mistake, not ours: a warning without the body or any detail.
      this.logger.warn('Request body over the size limit was refused (413)');
    }
    const response = host.switchToHttp().getResponse<Response>();
    for (const [name, value] of Object.entries(headers ?? {})) response.setHeader(name, value);
    response.status(status).json(body);
  }
}
