// AI video editing (ai.video-editing), tracing: /admin/ai-edits, where a super admin reads the whole story of an AI edit job
// across workspaces. Session auth like every /admin route, and never on the public API, so no API key reaches it.
import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { User } from '@prisma/client';
import { GetUserFromRequest } from '@gitroom/nestjs-libraries/user/user.from.request';
import {
  AiVideoEditsException,
  AiVideoEditsService,
} from '@gitroom/nestjs-libraries/database/prisma/ai-video-edits/ai.video.edits.service';

@ApiTags('Admin')
@Controller('/admin/ai-edits')
export class AdminAiEditsController {
  constructor(private _aiVideoEditsService: AiVideoEditsService) {}

  // The debug bundle of an edit (the edit, its request, every step by `seq`, the body served and the phone's receipts),
  // narrowed by `?step=` and `?kind=`. 404 for anyone who is not a super admin (the route is not shown to them) and for an
  // edit that does not exist. This is the one read of an edit across workspaces.
  @Get('/:id/trace')
  async trace(
    @GetUserFromRequest() user: User,
    @Param('id') id: string,
    @Query('step') step?: string,
    @Query('kind') kind?: string
  ) {
    if (!user?.isSuperAdmin) {
      throw new AiVideoEditsException(404, 'EDIT_NOT_FOUND', 'Edit not found');
    }
    return this._aiVideoEditsService.traceBundle(id, {
      step: typeof step === 'string' ? step : undefined,
      kind: typeof kind === 'string' ? kind : undefined,
    });
  }
}
