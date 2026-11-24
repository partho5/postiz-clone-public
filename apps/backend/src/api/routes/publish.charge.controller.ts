// Publish charging: what saving a post would reserve, before the user confirms.
import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Organization } from '@prisma/client';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { PublishChargingService } from '@gitroom/nestjs-libraries/database/prisma/credits/publish/publish.charging.service';
import { PublishChargePreviewDto } from '@gitroom/nestjs-libraries/database/prisma/credits/publish/publish.charge.preview.dto';
import { AiCaptionsService } from '@gitroom/nestjs-libraries/database/prisma/ai-captions/ai.captions.service';

@ApiTags('Posts')
@Controller('/posts')
export class PublishChargeController {
  constructor(
    private _publishChargingService: PublishChargingService,
    private _aiCaptionsService: AiCaptionsService
  ) {}

  // Credits a save of these channels would reserve, the channels it adds and the ones it releases. With
  // `aiCaptionsSeconds` it also says what the AI captions of that much speech cost (`aiCaptions`); `amount`
  // stays the publish alone.
  @Post('/charge-preview')
  @HttpCode(200)
  async chargePreview(
    @GetOrgFromRequest() org: Organization,
    @Body() body: PublishChargePreviewDto
  ) {
    const preview = await this._publishChargingService.preview(org.id, body);
    return body.aiCaptionsSeconds === undefined
      ? preview
      : {
          ...preview,
          aiCaptions: await this._aiCaptionsService.costOfSeconds(
            org.id,
            body.aiCaptionsSeconds
          ),
        };
  }
}
