import { HttpException, Injectable } from '@nestjs/common';
import { Activity, ActivityMethod } from 'nestjs-temporal-core';
import { ApplicationFailure, Context } from '@temporalio/activity';
import { MediaService } from '@gitroom/nestjs-libraries/database/prisma/media/media.service';
import { OrganizationService } from '@gitroom/nestjs-libraries/database/prisma/organizations/organization.service';
import { VideoDto } from '@gitroom/nestjs-libraries/dtos/videos/video.dto';

@Injectable()
@Activity()
export class VideoActivity {
  constructor(
    private _mediaService: MediaService,
    private _organizationService: OrganizationService
  ) {}

  @ActivityMethod()
  async generateVideo(organizationId: string, body: VideoDto) {
    // the video's type decides whether the workspace may use it, so the workspace is loaded whole
    const org = await this._organizationService.getOrgByIdWithSubscription(
      organizationId
    );
    if (!org) {
      throw new Error('Organization not found');
    }

    try {
      // the job id is this workflow's id: its credits were held under it when the job started
      return await this._mediaService.generateVideo(
        org,
        body,
        MediaService.videoJobKey(
          Context.current().info.workflowExecution.workflowId
        )
      );
    } catch (err) {
      // only the message survives the workflow failure
      if (err instanceof HttpException && err.getStatus() === 402) {
        throw ApplicationFailure.nonRetryable(
          err.message,
          'insufficient_credits',
          err.getResponse()
        );
      }
      throw err;
    }
  }
}
