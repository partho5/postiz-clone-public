import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

// Database roles: the API role (DATABASE_URL) is subject to row-level
// security on the money tables; the worker role (DATABASE_WORKER_URL) bypasses it.
export type DatabaseRole = 'api' | 'worker';

let processRole: DatabaseRole = 'api';

// Makes every PrismaService created afterwards in this process connect as the
// worker role. Called by the orchestrator before its app is created.
export const selectWorkerDatabase = () => {
  if (!process.env.DATABASE_WORKER_URL) {
    throw new Error(
      'DATABASE_WORKER_URL is not set; the orchestrator connects with the worker database role.'
    );
  }
  processRole = 'worker';
};

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  public readonly role: DatabaseRole = processRole;

  constructor() {
    super({
      datasourceUrl:
        processRole === 'worker' ? process.env.DATABASE_WORKER_URL : undefined,
      log: [
        {
          emit: 'event',
          level: 'query',
        },
      ],
    });
  }
  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}

@Injectable()
export class PrismaRepository<T extends keyof PrismaService> {
  public model: Pick<PrismaService, T>;
  constructor(private _prismaService: PrismaService) {
    this.model = this._prismaService;
  }
}

@Injectable()
export class PrismaTransaction {
  public model: Pick<PrismaService, '$transaction'>;
  constructor(private _prismaService: PrismaService) {
    this.model = this._prismaService;
  }
}
