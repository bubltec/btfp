import { Module } from '@nestjs/common';
import { HydratingUsersService } from './hydrating-users.service.js';

@Module({
  providers: [HydratingUsersService],
  exports: [HydratingUsersService],
})
export class UsersModule {}
