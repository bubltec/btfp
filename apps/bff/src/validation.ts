import type { ValidationPipeOptions } from '@nestjs/common';

/**
 * The one ValidationPipe configuration. app.ts and the DTO specs both import
 * it, so tests exercise the real pipe rather than a hand-copied one.
 *
 * `forbidNonWhitelisted` makes an undeclared field a 400. With `whitelist`
 * alone it is silently stripped, which hid a dropped `payload` and a `thingId`
 * sent in the wrong place.
 */
export const VALIDATION_PIPE_OPTIONS: ValidationPipeOptions = {
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
};
