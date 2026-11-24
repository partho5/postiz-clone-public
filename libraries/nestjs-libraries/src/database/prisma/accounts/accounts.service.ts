import { HttpException, Injectable } from '@nestjs/common';
import { AccountsRepository } from '@gitroom/nestjs-libraries/database/prisma/accounts/accounts.repository';

@Injectable()
export class AccountsService {
  constructor(private _accountsRepository: AccountsRepository) {}

  getAccountById(id: string) {
    return this._accountsRepository.getAccountById(id);
  }

  getAccountByOwner(ownerId: string) {
    return this._accountsRepository.getAccountByOwner(ownerId);
  }

  getAccountOrganizations(accountId: string) {
    return this._accountsRepository.getAccountOrganizations(accountId);
  }

  // The oldest workspace the user is an active member of whose account they own; null when there is none.
  getOwnedOrganization(userId: string) {
    return this._accountsRepository.getOwnedOrganization(userId);
  }

  // Every workspace belongs to exactly one account. Workspaces created before
  // accounts existed are attached lazily to their owner's account on first use.
  async getAccountIdForOrganization(organizationId: string): Promise<string> {
    const org = await this._accountsRepository.getOrganizationAccountId(
      organizationId
    );
    if (!org) {
      throw new HttpException('Workspace not found', 404);
    }
    if (org.accountId) {
      return org.accountId;
    }

    const ownerId = await this._accountsRepository.getOrganizationOwner(
      organizationId
    );
    if (!ownerId) {
      throw new HttpException('Workspace has no owner', 409);
    }

    return this.attachOrganizationToOwner(organizationId, ownerId);
  }

  // Called when a user creates a workspace: it is billed to their own account.
  async attachOrganizationToOwner(organizationId: string, ownerId: string) {
    const account = await this._accountsRepository.upsertAccountForOwner(
      ownerId
    );
    await this._accountsRepository.attachOrganization(
      organizationId,
      account.id
    );

    // Re-read: a concurrent caller may have attached it first
    const org = await this._accountsRepository.getOrganizationAccountId(
      organizationId
    );
    return org!.accountId!;
  }
}
