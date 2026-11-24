// Balance header: the workspace account's available and reserved credits, and the posts
// the reserved credits are held for.
import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Organization, User } from '@prisma/client';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { GetUserFromRequest } from '@gitroom/nestjs-libraries/user/user.from.request';
import { CreditBalanceService } from '@gitroom/nestjs-libraries/database/prisma/credits/balance/credit.balance.service';
import { ReservationsQueryDto } from '@gitroom/nestjs-libraries/database/prisma/credits/balance/credit.reservations.query.dto';

@ApiTags('Credits')
@Controller('/credits')
export class CreditsController {
  constructor(private _creditBalanceService: CreditBalanceService) {}

  // The balance the header shows for the user's current workspace.
  @Get('/balance')
  balance(@GetOrgFromRequest() org: Organization, @GetUserFromRequest() user: User) {
    return this._creditBalanceService.view(org.id, user.id);
  }

  // The reserved credits of the current workspace, newest first, one page at a time.
  @Get('/reservations')
  reservations(
    @GetOrgFromRequest() org: Organization,
    @Query() query: ReservationsQueryDto
  ) {
    return this._creditBalanceService.reservations(org.id, query);
  }
}
