import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import {
  ConfirmProfessionalVerificationDto,
  RequestProfessionalVerificationDto,
  ReviewProfessionalVerificationDto,
} from '@bubltec/mycota-professional-verification';
import {
  CurrentUser,
  EmailCodeService,
  JwtAuthGuard,
  VerifiedGuard,
  type AuthenticatedUser,
} from '@bubltec/mycota-auth';
import { HydratingUsersService } from '../users/hydrating-users.service.js';

/**
 * HTTP adapter over mycota EmailCodeService + HydratingUsersService.
 * mycota's own controller is not registered — its pending list strips PK
 * and cannot review legacy rows that never stored `id`.
 */
@Controller('verification/professional')
export class ProfessionalVerificationController {
  constructor(
    private readonly emailCode: EmailCodeService,
    private readonly users: HydratingUsersService,
  ) {}

  @Post('request')
  @UseGuards(JwtAuthGuard)
  request(@Body() dto: RequestProfessionalVerificationDto, @CurrentUser() user: AuthenticatedUser) {
    return this.emailCode.request(user, dto.email);
  }

  @Post('confirm')
  @UseGuards(JwtAuthGuard)
  async confirm(
    @Body() dto: ConfirmProfessionalVerificationDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return { confirmed: await this.emailCode.confirm(user, dto.code) };
  }

  @Get('pending')
  @UseGuards(VerifiedGuard)
  pending() {
    return this.users.listAwaitingReview();
  }

  @Post(':userId/review')
  @UseGuards(VerifiedGuard)
  review(
    @Param('userId') userId: string,
    @Body() dto: ReviewProfessionalVerificationDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.users.reviewProfessional(userId, dto.approve, user.id, dto.reason);
  }
}
