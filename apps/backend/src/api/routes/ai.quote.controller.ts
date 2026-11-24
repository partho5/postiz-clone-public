// AI charging: what an AI request would cost the current workspace.
import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Organization } from '@prisma/client';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { AiChargingService } from '@gitroom/nestjs-libraries/database/prisma/credits/ai/ai.charging.service';
import { AiQuoteDto } from '@gitroom/nestjs-libraries/database/prisma/credits/ai/ai.quote.dto';

@ApiTags('Credits')
@Controller('/ai')
export class AiQuoteController {
  constructor(private _aiChargingService: AiChargingService) {}

  // The price of one AI request for the workspace's plan, and where its free-plan cap stands.
  @Post('/quote')
  @HttpCode(200)
  quote(@GetOrgFromRequest() org: Organization, @Body() body: AiQuoteDto) {
    return this._aiChargingService.estimate(org.id, body);
  }
}
