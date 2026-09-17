import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';

/** On dev/staging, return the underlying error message in 500 JSON (not prod). */
@Catch()
export class StageErrorFilter implements ExceptionFilter {
  private readonly log = new Logger(StageErrorFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const reply = ctx.getResponse<FastifyReply>();

    const status =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;

    let body: string | object =
      exception instanceof HttpException
        ? exception.getResponse()
        : { statusCode: status, message: 'Internal server error' };

    if (status === HttpStatus.INTERNAL_SERVER_ERROR && process.env.STAGE !== 'prod') {
      const detail =
        exception instanceof Error ? `${exception.name}: ${exception.message}` : String(exception);
      this.log.error(detail, exception instanceof Error ? exception.stack : undefined);
      body =
        typeof body === 'object' && body !== null
          ? { ...body, message: detail }
          : { statusCode: status, message: detail };
    }

    reply.status(status).send(body);
  }
}
