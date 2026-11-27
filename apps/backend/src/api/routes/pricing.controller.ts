// Pricing config: what the current workspace's account pays and gets.
import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Organization } from '@prisma/client';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { PricingService } from '@gitroom/nestjs-libraries/database/prisma/credits/pricing/pricing.service';

@ApiTags('Credits')
@Controller('/credits')
export class PricingController {
  constructor(private _pricingService: PricingService) {}

  // Action prices for the account's plan, plan tiers, top-up packs and free-plan values.
  @Get('/pricing')
  getPricing(@GetOrgFromRequest() org: Organization) {
    return this._pricingService.view(org.id);
  }
}
