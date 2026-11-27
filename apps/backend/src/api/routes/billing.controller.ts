// Billing routes left now that PayPal is the only web provider: the mobile subscription sync and the current subscription. Plans and top-ups have their own controllers.
import { Body, Controller, Get, HttpException, Post } from '@nestjs/common';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { Organization, User } from '@prisma/client';
import { ApiTags } from '@nestjs/swagger';
import { GetUserFromRequest } from '@gitroom/nestjs-libraries/user/user.from.request';
import { UsersService } from '@gitroom/nestjs-libraries/database/prisma/users/users.service';
import { PaymentService } from '@gitroom/nestjs-libraries/services/payment/payment.service';
import { BillingSyncDto } from '@gitroom/nestjs-libraries/dtos/billing/billing.sync.dto';

@ApiTags('Billing')
@Controller('/billing')
export class BillingController {
  constructor(
    private _usersService: UsersService,
    private _paymentService: PaymentService
  ) {}

  // Whether another account with the same email already holds an active subscription.
  private async assertNoOtherSubscribedAccount(user: User) {
    const other = await this._usersService.getUserWithActiveSubscriptionByEmail(
      user.email,
      user.id
    );
    return !!other;
  }

  // Re-checks the organization's subscription with the named provider (the mobile app after a purchase or restore).
  @Post('/sync')
  async sync(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Body() body: BillingSyncDto
  ) {
    if (await this.assertNoOtherSubscribedAccount(user)) {
      return { blocked: true };
    }
    await this._paymentService.assertCanUseProvider(org.id, body.provider);

    try {
      return await this._paymentService.syncSubscription(body.provider, org.id);
    } catch (e) {
      if (e instanceof HttpException) {
        throw e;
      }
      throw new HttpException((e as Error)?.message || 'Sync failed', 400);
    }
  }

  // The organization's subscription row and the platform of the provider that owns it.
  @Get('/')
  getCurrentBilling(@GetOrgFromRequest() org: Organization) {
    return this._paymentService.getSubscription(org.id);
  }
}
