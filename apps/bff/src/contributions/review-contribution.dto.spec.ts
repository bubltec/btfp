import 'reflect-metadata';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { VALIDATION_PIPE_OPTIONS } from '../validation.js';
import { RejectContributionDto } from './dto/reject-contribution.dto.js';
import { ReviewContributionDto } from './dto/review-contribution.dto.js';

const pipe = new ValidationPipe(VALIDATION_PIPE_OPTIONS);
const sk = 'CONTRIB#2026-09-27T12:34:56.000Z#system:agentcore-scraper';

describe('review DTOs (ValidationPipe)', () => {
  it('keeps a sort key with # intact for approve', async () => {
    const dto = (await pipe.transform(
      { sk },
      { type: 'body', metatype: ReviewContributionDto },
    )) as ReviewContributionDto;
    expect(dto.sk).toBe(sk);
  });

  it('accepts sk and an optional reason for reject', async () => {
    const dto = (await pipe.transform(
      { sk, reason: 'dupe' },
      { type: 'body', metatype: RejectContributionDto },
    )) as RejectContributionDto;
    expect(dto).toMatchObject({ sk, reason: 'dupe' });
  });

  it('rejects a body without sk', async () => {
    await expect(
      pipe.transform({}, { type: 'body', metatype: ReviewContributionDto }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      pipe.transform({ reason: 'x' }, { type: 'body', metatype: RejectContributionDto }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
