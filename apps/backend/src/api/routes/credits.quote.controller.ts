// Cost preview: the price of one billable action for the current workspace's plan.
import {
  Body,
  Controller,
  HttpCode,
  HttpException,
  Post,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Organization } from '@prisma/client';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { CreditsService } from '@gitroom/nestjs-libraries/database/prisma/credits/credits.service';
import { CreditQuoteDto } from '@gitroom/nestjs-libraries/dtos/credits/credit.quote.dto';

@ApiTags('Credits')
@Controller('/credits')
export class CreditsQuoteController {
  constructor(private _creditsService: CreditsService) {}

  // The unit cost, quantity and total of an action for the workspace's plan; 404 for an unknown action.
  @Post('/quote')
  @HttpCode(200)
  async quote(@GetOrgFromRequest() org: Organization, @Body() body: CreditQuoteDto) {
    try {
      const quote = await this._creditsService.quoteForOrganization(
        org.id,
        body.actionKey,
        body.quantity ?? 1
      );
      return {
        actionKey: quote.actionKey,
        unitCost: quote.unitCost,
        quantity: quote.quantity,
        amount: quote.amount,
      };
    } catch (err) {
      // The engine answers an action with no price as a 500 (it fails closed); to a caller it is a 404.
      if (err instanceof HttpException && err.getStatus() === 500) {
        throw new HttpException(
          {
            statusCode: 404,
            code: 'UNKNOWN_ACTION',
            message: 'This action has no price',
          },
          404
        );
      }
      throw err;
    }
  }
}
