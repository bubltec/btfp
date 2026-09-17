import { Type } from 'class-transformer';
import { IsDefined, IsOptional, IsString, ValidateNested } from 'class-validator';
import { CreateThingDto } from '../../things/dto/create-thing.dto.js';

export class CreateContributionDto {
  /** Set to propose an edit to an existing thing; omit for a brand-new thing. */
  @IsString()
  @IsOptional()
  thingId?: string;

  // @ValidateNested() alone only validates payload if present — a request
  // body missing it entirely passes validation with payload left undefined,
  // which then throws in ContributionsService.propose() instead of a clean 400.
  @IsDefined()
  @ValidateNested()
  @Type(() => CreateThingDto)
  payload!: CreateThingDto;
}
