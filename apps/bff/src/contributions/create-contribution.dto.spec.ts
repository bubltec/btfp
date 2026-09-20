import 'reflect-metadata';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { VALIDATION_PIPE_OPTIONS } from '../validation.js';
import { CreateContributionDto } from './dto/create-contribution.dto.js';

/** The real pipe config — regressions here broke deploy e2e repeatedly. */
const pipe = new ValidationPipe(VALIDATION_PIPE_OPTIONS);
const run = (body: unknown) =>
  pipe.transform(body, { type: 'body', metatype: CreateContributionDto });

const e2eSubmitBody = {
  payload: {
    name: 'Chocolate',
    thingTypeId: 'food',
    petTypes: [{ petTypeId: 'dog', severity: 'unknown' }],
    details: {
      notes:
        'Chocolate contains theobromine and caffeine, which are toxic to dogs and can cause vomiting, seizures, and death.',
    },
    source:
      'https://www.aspca.org/pet-care/animal-poison-control/toxic-and-non-toxic-plants/chocolate',
  },
};

describe('CreateContributionDto (ValidationPipe)', () => {
  it('keeps nested payload through the real pipe config', async () => {
    const dto = (await run(e2eSubmitBody)) as CreateContributionDto;

    expect(dto.payload.name).toBe('Chocolate');
    expect(dto.payload.thingTypeId).toBe('food');
    expect(dto.payload.petTypes).toEqual([{ petTypeId: 'dog', severity: 'unknown' }]);
    expect(dto.payload.details?.notes).toContain('theobromine');
    expect(dto.payload.source).toContain('aspca.org');
  });

  it('accepts an edit: thingId is a top-level field', async () => {
    const dto = (await run({ ...e2eSubmitBody, thingId: 'thing-1' })) as CreateContributionDto;
    expect(dto.thingId).toBe('thing-1');
  });

  it('leaves payload as class instances (must be plainified before Dynamo writes)', async () => {
    const dto = (await run(e2eSubmitBody)) as CreateContributionDto;
    expect(dto.payload.constructor.name).not.toBe('Object');
  });

  it('rejects a body with no payload (400, not a 500 later in the service)', async () => {
    await expect(run({})).rejects.toThrow(BadRequestException);
  });

  it('rejects a thingId buried inside payload instead of silently dropping it', async () => {
    const body = { payload: { ...e2eSubmitBody.payload, thingId: 'thing-1' } };
    await expect(run(body)).rejects.toThrow(BadRequestException);
  });

  it('rejects unknown top-level fields', async () => {
    await expect(run({ ...e2eSubmitBody, extra: true })).rejects.toThrow(BadRequestException);
  });
});
