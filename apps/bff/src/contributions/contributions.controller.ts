import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ContributionsService } from './contributions.service.js';
import {
  JwtAuthGuard,
  VerifiedGuard,
  CurrentUser,
  type AuthenticatedUser,
} from '@bubltec/mycota-auth';
// Value import — `import type` erases the class before emitDecoratorMetadata runs,
// so ValidationPipe sees paramtypes [Function, Object] and never transforms `payload`.
import { CreateContributionDto } from './dto/create-contribution.dto.js';
import { RejectContributionDto } from './dto/reject-contribution.dto.js';
import { ReviewContributionDto } from './dto/review-contribution.dto.js';

// Prod still requires verifiedContributor. Dev/local only needs a session —
// otherwise a first login (email, no quiz) hits 403 and the queue looks empty.
const ModerationGuard = process.env.STAGE === 'prod' ? VerifiedGuard : JwtAuthGuard;

@Controller('contributions')
export class ContributionsController {
  constructor(private readonly contributions: ContributionsService) {}

  @Post()
  @UseGuards(VerifiedGuard)
  async propose(@Body() dto: CreateContributionDto, @CurrentUser() user: AuthenticatedUser) {
    return this.contributions.propose(dto, user.id);
  }

  @Get('pending')
  @UseGuards(ModerationGuard)
  async listPending() {
    // Prod: verified contributors. Non-prod: any signed-in user. Restrict to
    // an admin allowlist before opening this up publicly.
    return this.contributions.listPending();
  }

  @Post(':thingId/approve')
  @UseGuards(ModerationGuard)
  async approve(
    @Param('thingId') thingId: string,
    @Body() dto: ReviewContributionDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.contributions.approve(thingId, dto.sk, user.id);
  }

  @Post(':thingId/reject')
  @UseGuards(ModerationGuard)
  async reject(
    @Param('thingId') thingId: string,
    @Body() dto: RejectContributionDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.contributions.reject(thingId, dto.sk, user.id, dto.reason);
  }
}
