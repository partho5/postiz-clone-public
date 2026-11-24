// AI captions (ai.video-captions): the web page "AI captions". A workspace reads the captions written from its
// recordings (a list, then one with its transcript and the post made from each text) and deletes one.
import { Controller, Delete, Get, Param, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Organization } from '@prisma/client';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { AiCaptionsService } from '@gitroom/nestjs-libraries/database/prisma/ai-captions/ai.captions.service';

@ApiTags('AI captions')
@Controller('/ai-captions')
export class AiCaptionsController {
  constructor(private _aiCaptionsService: AiCaptionsService) {}

  @Get('/')
  list(@GetOrgFromRequest() org: Organization, @Query('page') page: number) {
    return this._aiCaptionsService.list(org.id, page);
  }

  @Get('/:id')
  detail(@GetOrgFromRequest() org: Organization, @Param('id') id: string) {
    return this._aiCaptionsService.detail(org.id, id);
  }

  @Delete('/:id')
  remove(@GetOrgFromRequest() org: Organization, @Param('id') id: string) {
    return this._aiCaptionsService.softDelete(org.id, id);
  }
}
