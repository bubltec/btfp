import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * The queue row's sort key (`CONTRIB#{time}#{contributor}`) goes in the body, not the path:
 * API Gateway decodes `%23` back to `#` before the Lambda sees the URL, and everything after
 * a `#` is dropped as a fragment, so a path parameter never reached the route.
 */
export class ReviewContributionDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  sk!: string;
}
