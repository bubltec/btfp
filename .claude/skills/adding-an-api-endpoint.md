---
name: adding-an-api-endpoint
description: Add a new endpoint to the badthingsforpets NestJS BFF
---

1. Put it in the relevant existing module (`things`, `thing-types`, `pet-types`, `search`,
   `auth`, `verification`, `contributions`) or create a new one under `apps/bff/src/` if it
   doesn't fit any of those — module, controller, service, and a `dto/` folder if it takes a
   body.
2. Reads go through `SearchService`'s in-memory cache where possible instead of a fresh
   Scan/Query — see [docs/data-model.md](../../docs/data-model.md) for why.
3. Writes go through `DynamoDBDocumentClient` (`DYNAMO_DOC_CLIENT` token from
   `dynamo/dynamo.module.ts`), and call `SearchService.invalidate()` after writing a Thing
   so the cache doesn't serve stale data for up to 60s.
4. Gate with `JwtAuthGuard` (signed in) or `VerifiedGuard` (signed in + passed the
   contributor quiz) from `apps/bff/src/auth/` — don't hand-roll auth checks in a
   controller.
5. Register the new route's shape in `packages/shared-types` if the response is a DTO the
   frontend needs typed.
   If the route takes a body, declare **every** accepted field on the DTO with a validator
   decorator. Unknown fields are a 400 (`forbidNonWhitelisted`), so the client and the DTO must
   change together. A required nested object needs `@IsDefined()` + `@ValidateNested()` +
   `@Type(() => Dto)`, or a body missing it passes validation and 500s later. Add a spec that
   runs the DTO through `VALIDATION_PIPE_OPTIONS` (`apps/bff/src/validation.ts`), as
   `create-contribution.dto.spec.ts` does, so the test uses the real pipe config.
6. New module needs registering in `apps/bff/src/app.module.ts`.

No separate step for Lambda — `apps/bff/src/lambda.ts` and `main.ts` both boot the same
`createApp()` from `app.ts`, so anything wired into `AppModule` works in both local dev and
the deployed Lambda automatically.
