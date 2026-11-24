import { Global, Injectable, Module, OnModuleInit } from '@nestjs/common';
import { TemporalService } from 'nestjs-temporal-core';
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/client';

@Injectable()
export class InfiniteWorkflowRegister implements OnModuleInit {
  constructor(private _temporalService: TemporalService) {}

  async onModuleInit(): Promise<void> {
    if (!!process.env.RUN_CRON) {
      try {
        await this._temporalService.client
          ?.getRawClient()
          ?.workflow?.start('missingPostWorkflow', {
            workflowId: 'missing-post-workflow',
            taskQueue: 'main',
          });
      } catch (err) {}

      await this.startFreeGrantWorkflow();
      await this.startCreditsReconcileWorkflow();
      await this.startPaypalPollWorkflow();
      await this.startIdempotencyCleanupWorkflow();
      await this.startMobileUploadSweepWorkflow();
      await this.startMediaRetentionPurgeWorkflow();
      await this.startMediaSweepWorkflow();
      await this.startActivityLogCleanupWorkflow();
      await this.startAiEditAssetPurgeWorkflow();
      await this.startAiEditTracePurgeWorkflow();
      await this.startContentPlanTickWorkflow();
    }
  }

  // Starts the daily free-grant run; one already running is left alone.
  private async startFreeGrantWorkflow() {
    try {
      await this._temporalService.client
        ?.getRawClient()
        ?.workflow?.start('freeGrantWorkflow', {
          workflowId: 'free-grant-workflow',
          taskQueue: 'main',
        });
    } catch (err) {
      if (!(err instanceof WorkflowExecutionAlreadyStartedError)) {
        console.error('credits: free grant workflow did not start', err);
      }
    }
  }

  // Starts the nightly credit reconciliation; one already running is left alone.
  private async startCreditsReconcileWorkflow() {
    try {
      await this._temporalService.client
        ?.getRawClient()
        ?.workflow?.start('creditsReconcileWorkflow', {
          workflowId: 'credits-reconcile-workflow',
          taskQueue: 'main',
        });
    } catch (err) {
      if (!(err instanceof WorkflowExecutionAlreadyStartedError)) {
        console.error('credits: reconcile workflow did not start', err);
      }
    }
  }

  // Starts the daily PayPal poll; one already running is left alone.
  private async startPaypalPollWorkflow() {
    try {
      await this._temporalService.client
        ?.getRawClient()
        ?.workflow?.start('paypalPollWorkflow', {
          workflowId: 'paypal-poll-workflow',
          taskQueue: 'main',
        });
    } catch (err) {
      if (!(err instanceof WorkflowExecutionAlreadyStartedError)) {
        console.error('billing: paypal poll workflow did not start', err);
      }
    }
  }

  // Starts the daily deletion of expired idempotency records; one already running is left alone.
  private async startIdempotencyCleanupWorkflow() {
    try {
      await this._temporalService.client
        ?.getRawClient()
        ?.workflow?.start('idempotencyCleanupWorkflow', {
          workflowId: 'idempotency-cleanup-workflow',
          taskQueue: 'main',
        });
    } catch (err) {
      if (!(err instanceof WorkflowExecutionAlreadyStartedError)) {
        console.error('api: idempotency cleanup workflow did not start', err);
      }
    }
  }

  // Starts the hourly sweep of abandoned mobile uploads; one already running is left alone.
  private async startMobileUploadSweepWorkflow() {
    try {
      await this._temporalService.client
        ?.getRawClient()
        ?.workflow?.start('mobileUploadSweepWorkflow', {
          workflowId: 'mobile-upload-sweep-workflow',
          taskQueue: 'main',
        });
    } catch (err) {
      if (!(err instanceof WorkflowExecutionAlreadyStartedError)) {
        console.error('api: mobile upload sweep workflow did not start', err);
      }
    }
  }

  // Starts the hourly purge of the phone's media files past their retention; one already running is left alone.
  private async startMediaRetentionPurgeWorkflow() {
    try {
      await this._temporalService.client
        ?.getRawClient()
        ?.workflow?.start('mediaRetentionPurgeWorkflow', {
          workflowId: 'media-retention-purge-workflow',
          taskQueue: 'main',
        });
    } catch (err) {
      if (!(err instanceof WorkflowExecutionAlreadyStartedError)) {
        console.error('api: media retention purge workflow did not start', err);
      }
    }
  }

  // Starts the daily sweep of soft-deleted media and orphan objects; one already running is left alone.
  private async startMediaSweepWorkflow() {
    try {
      await this._temporalService.client
        ?.getRawClient()
        ?.workflow?.start('mediaSweepWorkflow', {
          workflowId: 'media-sweep-workflow',
          taskQueue: 'main',
        });
    } catch (err) {
      if (!(err instanceof WorkflowExecutionAlreadyStartedError)) {
        console.error('api: media sweep workflow did not start', err);
      }
    }
  }

  // Starts the daily deletion of mobile activity batches older than 90 days; one already running is left alone.
  private async startActivityLogCleanupWorkflow() {
    try {
      await this._temporalService.client
        ?.getRawClient()
        ?.workflow?.start('activityLogCleanupWorkflow', {
          workflowId: 'activity-log-cleanup-workflow',
          taskQueue: 'main',
        });
    } catch (err) {
      if (!(err instanceof WorkflowExecutionAlreadyStartedError)) {
        console.error('api: activity log cleanup workflow did not start', err);
      }
    }
  }

  // Starts the daily deletion of cached AI edit icon and mp4 files unused for AI_EDIT_ASSET_RETENTION_DAYS days; one already running is left alone.
  private async startAiEditAssetPurgeWorkflow() {
    try {
      await this._temporalService.client
        ?.getRawClient()
        ?.workflow?.start('aiEditAssetPurgeWorkflow', {
          workflowId: 'ai-edit-asset-purge-workflow',
          taskQueue: 'main',
        });
    } catch (err) {
      if (!(err instanceof WorkflowExecutionAlreadyStartedError)) {
        console.error('ai-edit: asset purge workflow did not start', err);
      }
    }
  }

  // Starts the daily deletion of AI edit trace rows older than AI_EDIT_TRACE_DAYS days; one already running is left alone.
  private async startAiEditTracePurgeWorkflow() {
    try {
      await this._temporalService.client
        ?.getRawClient()
        ?.workflow?.start('aiEditTracePurgeWorkflow', {
          workflowId: 'ai-edit-trace-purge-workflow',
          taskQueue: 'main',
        });
    } catch (err) {
      if (!(err instanceof WorkflowExecutionAlreadyStartedError)) {
        console.error('ai-edit: trace purge workflow did not start', err);
      }
    }
  }

  // Starts the hourly tick of the content plans; one already running is left alone.
  private async startContentPlanTickWorkflow() {
    try {
      await this._temporalService.client
        ?.getRawClient()
        ?.workflow?.start('contentPlanTickWorkflow', {
          workflowId: 'content-plan-tick-workflow',
          taskQueue: 'main',
        });
    } catch (err) {
      if (!(err instanceof WorkflowExecutionAlreadyStartedError)) {
        console.error('content plan: tick workflow did not start', err);
      }
    }
  }
}

@Global()
@Module({
  imports: [],
  controllers: [],
  providers: [InfiniteWorkflowRegister],
  get exports() {
    return this.providers;
  },
})
export class InfiniteWorkflowRegisterModule {}
