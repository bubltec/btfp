import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BffDynamoModule } from './dynamo/bff-dynamo.module.js';
import { MycotaAuthModule } from '@bubltec/mycota-auth';
import { ProfessionalVerificationModule } from '@bubltec/mycota-professional-verification';
import { PetTypesModule } from './pet-types/pet-types.module.js';
import { BreedsModule } from './breeds/breeds.module.js';
import { ThingTypesModule } from './thing-types/thing-types.module.js';
import { ThingsModule } from './things/things.module.js';
import { SearchModule } from './search/search.module.js';
import { VerificationModule } from './verification/verification.module.js';
import { ContributionsModule } from './contributions/contributions.module.js';
import { SitemapModule } from './sitemap/sitemap.module.js';
import { McpModule } from './mcp/mcp.module.js';
import { buildMycotaAuthConfig } from './mycota-config.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    BffDynamoModule,
    MycotaAuthModule.forRootAsync({ useFactory: buildMycotaAuthConfig }),
    SearchModule,
    PetTypesModule,
    BreedsModule,
    ThingTypesModule,
    ThingsModule,
    VerificationModule,
    ContributionsModule,
    SitemapModule,
    McpModule,
    ProfessionalVerificationModule,
  ],
})
export class AppModule {}
