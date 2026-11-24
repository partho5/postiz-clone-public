// Recurring charging: which repeating posts can't pay their next occurrence, for the calendar.
import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Organization } from '@prisma/client';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { RecurringChargingService } from '@gitroom/nestjs-libraries/database/prisma/credits/recurring/recurring.charging.service';

@ApiTags('Posts')
@Controller('/posts')
export class RecurringFlagsController {
  constructor(private _recurringChargingService: RecurringChargingService) {}

  // The "can't be paid" flags of these posts of the workspace (comma-separated ids), by post id.
  @Get('/recurring-flags')
  recurringFlags(
    @GetOrgFromRequest() org: Organization,
    @Query('ids') ids?: string
  ) {
    return this._recurringChargingService.flagsForPosts(
      org.id,
      typeof ids === 'string' ? ids.split(',') : []
    );
  }
}
