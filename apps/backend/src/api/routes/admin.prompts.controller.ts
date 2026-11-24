// Prompt Book (ai.video-captions): /admin/prompts, where the owner keeps the default of every prompt,
// the locked frames and the model each prompt runs on, without a deploy. Super admins only.
import {
  Body,
  Controller,
  Get,
  HttpException,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { User } from '@prisma/client';
import { GetUserFromRequest } from '@gitroom/nestjs-libraries/user/user.from.request';
import { PromptBookService } from '@gitroom/nestjs-libraries/database/prisma/prompt-book/prompt.book.service';
import {
  RestorePromptDto,
  SaveDefaultPromptDto,
} from '@gitroom/nestjs-libraries/dtos/prompt-book/save.prompt.dto';

@ApiTags('Admin')
@Controller('/admin/prompts')
export class AdminPromptsController {
  constructor(private _promptBookService: PromptBookService) {}

  private assertSuperAdmin(user: User) {
    if (!user?.isSuperAdmin) {
      throw new HttpException('Unauthorized', 400);
    }
  }

  @Get('/')
  async list(@GetUserFromRequest() user: User) {
    this.assertSuperAdmin(user);
    return this._promptBookService.listDefaults();
  }

  @Put('/')
  async save(
    @GetUserFromRequest() user: User,
    @Body() body: SaveDefaultPromptDto
  ) {
    this.assertSuperAdmin(user);
    return this._promptBookService.saveDefault(user.id, body);
  }

  @Get('/:key/history')
  async history(@GetUserFromRequest() user: User, @Param('key') key: string) {
    this.assertSuperAdmin(user);
    return this._promptBookService.history(key);
  }

  @Post('/:key/restore')
  async restore(
    @GetUserFromRequest() user: User,
    @Param('key') key: string,
    @Body() body: RestorePromptDto
  ) {
    this.assertSuperAdmin(user);
    return this._promptBookService.restore(user.id, key, body.version);
  }
}
