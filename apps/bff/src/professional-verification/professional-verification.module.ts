import { Module } from '@nestjs/common';
import { ProfessionalVerificationController } from './professional-verification.controller.js';
import { UsersModule } from '../users/users.module.js';

@Module({
  imports: [UsersModule],
  controllers: [ProfessionalVerificationController],
})
export class ProfessionalVerificationModule {}
