import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import fastifyCookie from '@fastify/cookie';
import { AppModule } from './app.module.js';
import { corsOrigin, isProduction } from './env.js';
import { JsonLogger } from './logging/json-logger.js';
import { StageErrorFilter } from './filters/stage-error.filter.js';
import { VALIDATION_PIPE_OPTIONS } from './validation.js';

export async function createApp(adapter: FastifyAdapter): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    logger: isProduction() ? new JsonLogger() : ['error', 'warn', 'log'],
  });

  await app.register(fastifyCookie);

  // Passport (built for Express) calls res.setHeader()/res.end() directly
  // when a strategy issues a redirect (OAuth2Strategy.redirect, used by
  // GithubStrategy/GoogleStrategy) — Fastify's reply wrapper doesn't have
  // either. Delegate both to the underlying raw Node response, which does.
  // reply.statusCode itself is already a real, settable property on
  // Fastify's reply (proxies to the raw response), so nothing needed there.
  // See https://github.com/nestjs/nest/issues/5702.
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onRequest', (_request, reply, done) => {
      const patchable = reply as unknown as {
        setHeader: typeof reply.raw.setHeader;
        end: typeof reply.raw.end;
      };
      patchable.setHeader = reply.raw.setHeader.bind(reply.raw);
      patchable.end = reply.raw.end.bind(reply.raw);
      done();
    });

  app.enableCors({ origin: corsOrigin(), credentials: true });
  // sitemap.xml/robots.txt are excluded so they can live at the site root instead of under /api.
  app.setGlobalPrefix('api', { exclude: ['sitemap.xml', 'robots.txt'] });
  app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS));
  if (process.env.STAGE !== 'prod') {
    app.useGlobalFilters(new StageErrorFilter());
  }

  const openApiConfig = new DocumentBuilder()
    .setTitle('badthingsforpets.com API')
    .setDescription(
      'Public read API for pet-danger data. GET endpoints are unauthenticated and CORS-open.',
    )
    .setVersion('1.0')
    .build();
  const openApiDocument = SwaggerModule.createDocument(app, openApiConfig);
  app
    .getHttpAdapter()
    .getInstance()
    .get('/api/openapi.json', async (_req, reply) => {
      reply.send(openApiDocument);
    });

  return app;
}
