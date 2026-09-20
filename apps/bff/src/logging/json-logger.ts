import type { LoggerService } from '@nestjs/common';
import { requestContext } from './request-context.js';

type Level = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

const STACK_FRAME = /\n\s+at .+/;

function printable(message: unknown): unknown {
  if (message instanceof Error) return message.message;
  if (typeof message === 'string') return message;
  try {
    JSON.stringify(message);
    return message;
  } catch {
    return String(message);
  }
}

/**
 * One JSON object per line on stdout. A multi-line stack trace stays inside a
 * single `stack` field, so CloudWatch stores one event per log call instead of
 * splitting the trace across events. Used in production; local dev keeps Nest's
 * readable console logger.
 */
export class JsonLogger implements LoggerService {
  constructor(private readonly debugEnabled = process.env.LOG_LEVEL === 'debug') {}

  log(message: unknown, ...params: unknown[]): void {
    this.emit('info', message, params);
  }
  warn(message: unknown, ...params: unknown[]): void {
    this.emit('warn', message, params);
  }
  error(message: unknown, ...params: unknown[]): void {
    this.emit('error', message, params);
  }
  fatal(message: unknown, ...params: unknown[]): void {
    this.emit('fatal', message, params);
  }
  debug(message: unknown, ...params: unknown[]): void {
    if (this.debugEnabled) this.emit('debug', message, params);
  }
  verbose(message: unknown, ...params: unknown[]): void {
    if (this.debugEnabled) this.emit('debug', message, params);
  }

  private emit(level: Level, message: unknown, params: unknown[]): void {
    // Nest passes (message, stack?, context?) for errors and (message, context?) otherwise.
    let rest = params;
    let context: string | undefined;
    const last = rest.at(-1);
    if (typeof last === 'string' && !STACK_FRAME.test(last)) {
      context = last;
      rest = rest.slice(0, -1);
    }
    const stackParam = rest.find((p): p is string => typeof p === 'string' && STACK_FRAME.test(p));

    const entry = {
      level,
      time: new Date().toISOString(),
      requestId: requestContext.getStore()?.requestId,
      context,
      message: printable(message),
      stack: message instanceof Error ? message.stack : stackParam,
    };
    process.stdout.write(`${JSON.stringify(entry)}\n`);
  }
}
