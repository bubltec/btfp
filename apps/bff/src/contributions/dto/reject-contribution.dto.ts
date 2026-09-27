import { IsOptional, IsString, MaxLength } from 'class-validator';
import { ReviewContributionDto } from './review-contribution.dto.js';

export class RejectContributionDto extends ReviewContributionDto {
  /** Why it was rejected; kept on the row for audit. */
  @IsString()
  @IsOptional()
  @MaxLength(500)
  reason?: string;
}
