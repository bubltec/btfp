import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ContributionsService } from './contributions.service.js';
import { VerifiedGuard, CurrentUser, type AuthenticatedUser } from '@bubltec/mycota-auth';
// Value import — `import type` erases the class before emitDecoratorMetadata runs,
// so ValidationPipe sees paramtypes [Function, Object] and never transforms `payload`.
import { CreateContributionDto } from './dto/create-contribution.dto.js';

@Controller('contributions')
export class ContributionsController {
  constructor(private readonly contributions: ContributionsService) {}

  @Post()
  @UseGuards(VerifiedGuard)
  async propose(@Body() dto: CreateContributionDto, @CurrentUser() user: AuthenticatedUser) {
    return this.contributions.propose(dto, user.id);
  }

  @Get('pending')
  @UseGuards(VerifiedGuard)
  async listPending() {
    // MVP: any verified contributor can see the moderation queue. Restrict to
    // an admin allowlist before opening this up publicly.
    return this.contributions.listPending();
  }

  @Post(':thingId/:sk/approve')
  @UseGuards(VerifiedGuard)
  async approve(
    @Param('thingId') thingId: string,
    @Param('sk') sk: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.contributions.approve(thingId, decodeURIComponent(sk), user.id);
  }
}
