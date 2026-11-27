// PayPal top-ups: the owner's routes to buy a credit pack, capture it and read the order.
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  UseFilters,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Organization, User } from '@prisma/client';
import { PaypalErrorFilter } from '@gitroom/nestjs-libraries/services/paypal/paypal.exception.filter';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { GetUserFromRequest } from '@gitroom/nestjs-libraries/user/user.from.request';
import { TopupsService } from '@gitroom/nestjs-libraries/database/prisma/billing/topups/topups.service';
import { TopupPackDto } from '@gitroom/nestjs-libraries/dtos/billing/topup.dto';

@ApiTags('Billing')
@UseFilters(PaypalErrorFilter)
@Controller('/billing/topups')
export class TopupsController {
  constructor(private _topupsService: TopupsService) {}

  // Creates a PayPal order for a credit pack and answers PayPal's approval link.
  @Post('/')
  @HttpCode(200)
  createOrder(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Body() body: TopupPackDto
  ) {
    return this._topupsService.createOrder(org.id, user.id, body.packKey);
  }

  // Captures the approved order and grants its credits once PayPal reports the payment completed.
  @Post('/:orderId/capture')
  @HttpCode(200)
  capture(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('orderId') orderId: string
  ) {
    return this._topupsService.capture(org.id, user.id, orderId);
  }

  // The state of one of the workspace account's orders.
  @Get('/:orderId')
  get(
    @GetOrgFromRequest() org: Organization,
    @Param('orderId') orderId: string
  ) {
    return this._topupsService.get(org.id, orderId);
  }
}
