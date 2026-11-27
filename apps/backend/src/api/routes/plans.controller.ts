// PayPal subscriptions: the plans an account can buy and the owner's subscribe, confirm, change and cancel.
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  UseFilters,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Organization, User } from '@prisma/client';
import { PaypalErrorFilter } from '@gitroom/nestjs-libraries/services/paypal/paypal.exception.filter';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { GetUserFromRequest } from '@gitroom/nestjs-libraries/user/user.from.request';
import { PaypalSubscriptionsService } from '@gitroom/nestjs-libraries/database/prisma/billing/subscriptions/paypal.subscriptions.service';
import {
  PlanConfirmDto,
  PlanTierDto,
} from '@gitroom/nestjs-libraries/dtos/billing/paypal.plan.dto';

@ApiTags('Billing')
@UseFilters(PaypalErrorFilter)
@Controller('/billing/plans')
export class PlansController {
  constructor(
    private _paypalSubscriptionsService: PaypalSubscriptionsService
  ) {}

  // The plan tiers and the workspace account's subscription.
  @Get('/')
  plans(@GetOrgFromRequest() org: Organization) {
    return this._paypalSubscriptionsService.plans(org.id);
  }

  // Starts a subscription and answers PayPal's approval link.
  @Post('/subscribe')
  @HttpCode(200)
  subscribe(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Body() body: PlanTierDto
  ) {
    return this._paypalSubscriptionsService.subscribe(
      org.id,
      user.id,
      body.tierKey
    );
  }

  // Stores the subscription state PayPal reports after the owner approved it.
  @Post('/confirm')
  @HttpCode(200)
  confirm(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Body() body: PlanConfirmDto
  ) {
    return this._paypalSubscriptionsService.confirm(
      org.id,
      user.id,
      body.subscriptionId
    );
  }

  // Moves the subscription to another tier from the next billing period.
  @Post('/change')
  @HttpCode(200)
  change(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Body() body: PlanTierDto
  ) {
    return this._paypalSubscriptionsService.changeTier(
      org.id,
      user.id,
      body.tierKey
    );
  }

  // Cancels the subscription; its tier stays until the paid period ends.
  @Post('/cancel')
  @HttpCode(200)
  cancel(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User
  ) {
    return this._paypalSubscriptionsService.cancel(org.id, user.id);
  }
}
