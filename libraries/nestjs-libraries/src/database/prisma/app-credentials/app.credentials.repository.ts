// Workspace app credentials (T4): reading and writing the `AppCredential` rows (values stay encrypted here).
import { Injectable } from '@nestjs/common';
import {
  PrismaRepository,
  PrismaTransaction,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';

// Reads and writes the `AppCredential` rows of one workspace at a time.
@Injectable()
export class AppCredentialsRepository {
  // Receives the Prisma repository for `appCredential` and the transaction runner.
  constructor(
    private _appCredential: PrismaRepository<'appCredential'>,
    private _transaction: PrismaTransaction
  ) {}

  // Every stored key of the workspace with its encrypted value.
  list(organizationId: string) {
    return this._appCredential.model.appCredential.findMany({
      where: { organizationId },
      select: { key: true, value: true, updatedAt: true },
    });
  }

  // Writes the given encrypted values and removes the given keys, all or nothing.
  async save(
    organizationId: string,
    upserts: { key: string; value: string }[],
    removals: string[]
  ): Promise<void> {
    await this._transaction.model.$transaction([
      ...upserts.map(({ key, value }) =>
        this._appCredential.model.appCredential.upsert({
          where: { organizationId_key: { organizationId, key } },
          create: { organizationId, key, value },
          update: { value },
        })
      ),
      this._appCredential.model.appCredential.deleteMany({
        where: { organizationId, key: { in: removals } },
      }),
    ]);
  }
}
