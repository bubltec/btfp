import { IsOptional, IsString, MaxLength } from 'class-validator';

export class RejectContributionDto {
  /** Why it was rejected; kept on the row for audit. */
  @IsString()
  @IsOptional()
  @MaxLength(500)
  reason?: string;
}
