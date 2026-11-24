import {
  BadRequestException,
  Logger,
  Controller,
  Get,
  Post,
  Req,
  Res,
  Param,
} from '@nestjs/common';
import {
  CopilotRuntime,
  OpenAIAdapter,
  copilotRuntimeNodeHttpEndpoint,
} from '@copilotkit/runtime';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { Organization } from '@prisma/client';
import { AiChargingService } from '@gitroom/nestjs-libraries/database/prisma/credits/ai/ai.charging.service';
import { CreditsService } from '@gitroom/nestjs-libraries/database/prisma/credits/credits.service';
import { v4 as uuidv4 } from 'uuid';
import { MastraAgent } from '@ag-ui/mastra';
import { MastraService } from '@gitroom/nestjs-libraries/chat/mastra.service';
import { Request, Response } from 'express';
import { RequestContext } from '@mastra/core/di';
import { CheckPolicies } from '@gitroom/backend/services/auth/permissions/permissions.ability';
import { AuthorizationActions, Sections } from '@gitroom/backend/services/auth/permissions/permission.exception.class';

export type ChannelsContext = {
  integrations: string;
  organization: string;
  ui: string;
};

// the runtime's single-route methods that call the model on the platform's key
const GENERATING_METHODS = ['agent/run', 'agent/suggest'];
// the runtime's single-route methods that reach no model; a method in neither list is refused
const FREE_METHODS = [
  'agent/connect',
  'agent/stop',
  'info',
  'inspector/metadata',
  'inspector/learning',
  'transcribe',
  'resource/request',
];

// the copilot runtime writes its own CORS headers on the response, keep them aligned with main.ts
const copilotCors = () => ({
  origin: [
    process.env.FRONTEND_URL,
    'http://localhost:6274',
    ...(process.env.MAIN_URL ? [process.env.MAIN_URL] : []),
  ],
  credentials: !process.env.NOT_SECURED,
});

@Controller('/copilot')
export class CopilotController {
  constructor(
    private _aiChargingService: AiChargingService,
    private _creditsService: CreditsService,
    private _mastraService: MastraService
  ) {}

  @Post('/chat')
  chatAgent(
    @Req() req: Request,
    @Res() res: Response,
    @GetOrgFromRequest() organization: Organization
  ) {
    if (
      process.env.OPENAI_API_KEY === undefined ||
      process.env.OPENAI_API_KEY === ''
    ) {
      Logger.warn('OpenAI API key not set, chat functionality will not work');
      return;
    }

    const copilotRuntimeHandler = copilotRuntimeNodeHttpEndpoint({
      endpoint: '/copilot/chat',
      cors: copilotCors(),
      runtime: new CopilotRuntime(),
      serviceAdapter: new OpenAIAdapter({
        model: 'gpt-4.1',
      }),
    });

    return this.chargeRun(organization, req, 'copilot.chat', () =>
      copilotRuntimeHandler(req, res)
    );
  }

  @Post('/agent')
  @CheckPolicies([AuthorizationActions.Create, Sections.AI])
  async agent(
    @Req() req: Request,
    @Res() res: Response,
    @GetOrgFromRequest() organization: Organization
  ) {
    if (
      process.env.OPENAI_API_KEY === undefined ||
      process.env.OPENAI_API_KEY === ''
    ) {
      Logger.warn('OpenAI API key not set, chat functionality will not work');
      return;
    }
    const mastra = await this._mastraService.mastra();
    const requestContext = new RequestContext<ChannelsContext>();
    requestContext.set(
      'integrations',
      req?.body?.body?.forwardedProps?.integrations || []
    );

    requestContext.set('organization', JSON.stringify(organization));
    requestContext.set('ui', 'true');

    const agents = MastraAgent.getLocalAgents({
      resourceId: organization.id,
      mastra,
      requestContext: requestContext as any,
    });

    const runtime = new CopilotRuntime({
      agents,
    });

    const copilotRuntimeHandler = copilotRuntimeNodeHttpEndpoint({
      endpoint: '/copilot/agent',
      cors: copilotCors(),
      runtime,
      serviceAdapter: new OpenAIAdapter({
        model: 'gpt-4.1',
      }),
    });

    return this.chargeRun(organization, req, 'copilot.agent', () =>
      copilotRuntimeHandler(req, res)
    );
  }

  // The account's available credits.
  @Get('/credits')
  async calculateCredits(@GetOrgFromRequest() organization: Organization) {
    const { available } = await this._creditsService.balance(organization.id);
    return { credits: available };
  }

  @Get('/:thread/list')
  @CheckPolicies([AuthorizationActions.Create, Sections.AI])
  async getMessagesList(
    @GetOrgFromRequest() organization: Organization,
    @Param('thread') threadId: string
  ): Promise<any> {
    const mastra = await this._mastraService.mastra();
    const memory = await mastra.getAgent('postiz').getMemory();
    try {
      return await memory.recall({
        resourceId: organization.id,
        threadId,
      });
    } catch (err) {
      Logger.warn(`Could not recall messages for thread ${threadId}: ${err}`);
      return { messages: [] };
    }
  }

  @Get('/list')
  @CheckPolicies([AuthorizationActions.Create, Sections.AI])
  async getList(@GetOrgFromRequest() organization: Organization) {
    const mastra = await this._mastraService.mastra();
    const memory = await mastra.getAgent('postiz').getMemory();
    const list = await memory.listThreads({
      filter: { resourceId: organization.id },
      perPage: 100000,
      page: 0,
      orderBy: { field: 'createdAt', direction: 'DESC' },
    });

    return {
      threads: list.threads.map((p) => ({
        id: p.id,
        title: p.title,
      })),
    };
  }

  // A generation request (`agent/run` or `agent/suggest`) is one ai.text, charged before the stream opens and
  // released if the handler throws; the runtime's other known calls generate nothing and are free. The runtime
  // reads the raw stream when express did not parse the body, so a request whose envelope express did not parse
  // as JSON, or whose method is unknown, never reaches it.
  private chargeRun(
    org: Organization,
    req: Request,
    route: string,
    run: () => unknown
  ) {
    const method = req.is('json') ? req.body?.method : undefined;
    if (FREE_METHODS.includes(method)) {
      return run();
    }
    if (!GENERATING_METHODS.includes(method)) {
      throw new BadRequestException('Unsupported copilot request');
    }
    return this._aiChargingService.charge(
      {
        organizationId: org.id,
        kind: 'text',
        idempotencyKey: `ai:${uuidv4()}`,
        metadata: { route },
      },
      async () => run()
    );
  }
}
