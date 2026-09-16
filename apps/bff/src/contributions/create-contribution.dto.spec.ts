import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { CreateContributionDto } from './dto/create-contribution.dto.js';

/** Same pipe as apps/bff/src/app.ts — regressions here broke deploy e2e twice. */
const pipe = new ValidationPipe({ whitelist: true, transform: true });

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
  it('keeps nested payload through whitelist: true', async () => {
    const dto = (await pipe.transform(e2eSubmitBody, {
      type: 'body',
      metatype: CreateContributionDto,
    })) as CreateContributionDto;

    expect(dto.payload.name).toBe('Chocolate');
    expect(dto.payload.thingTypeId).toBe('food');
    expect(dto.payload.petTypes).toEqual([{ petTypeId: 'dog', severity: 'unknown' }]);
    expect(dto.payload.details?.notes).toContain('theobromine');
    expect(dto.payload.source).toContain('aspca.org');
  });
});
