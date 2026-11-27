// Prompt Book (ai.video-captions): the Settings "AI prompts" tab. A workspace reads its prompts (its own
// text, else the default), saves its own text for one, or goes back to the default.
import { Body, Controller, Delete, Get, Param, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Organization, User } from '@prisma/client';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { GetUserFromRequest } from '@gitroom/nestjs-libraries/user/user.from.request';
import { PromptBookService } from '@gitroom/nestjs-libraries/database/prisma/prompt-book/prompt.book.service';
import { SavePromptDto } from '@gitroom/nestjs-libraries/dtos/prompt-book/save.prompt.dto';

@ApiTags('Prompt book')
@Controller('/prompt-book')
export class PromptBookController {
  constructor(private _promptBookService: PromptBookService) {}

  @Get('/')
  async list(@GetOrgFromRequest() org: Organization) {
    return this._promptBookService.list(org.id);
  }

  @Put('/:key')
  async save(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('key') key: string,
    @Body() body: SavePromptDto
  ) {
    return this._promptBookService.save(org.id, key, body.body, user.id);
  }

  @Delete('/:key')
  async reset(
    @GetOrgFromRequest() org: Organization,
    @Param('key') key: string
  ) {
    return this._promptBookService.reset(org.id, key);
  }
}
