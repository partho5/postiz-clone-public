import { Injectable } from '@nestjs/common';

// The account a provider token belongs to. `verifiedEmail` is set when the provider vouches that the
// person owns the address, and `name` / `lastName` when the provider shares them.
export interface AuthProviderUser {
  email: string;
  id: string;
  verifiedEmail?: boolean;
  name?: string;
  lastName?: string;
}

export abstract class AuthProviderAbstract {
  abstract generateLink(query?: any): Promise<string> | string;
  abstract getToken(code: string, redirectUri?: string): Promise<string>;
  abstract getUser(
    providerToken: string
  ): Promise<AuthProviderUser> | false;
  async postRegistration(
    providerToken: string,
    orgId: string
  ): Promise<void> {}
}

export interface AuthProviderParams {
  provider: string;
}

export function AuthProvider(params: AuthProviderParams) {
  return function (target: any) {
    Injectable()(target);

    const existingMetadata =
      Reflect.getMetadata('auth-provider', AuthProviderAbstract) || [];

    existingMetadata.push({ target, provider: params.provider });

    Reflect.defineMetadata(
      'auth-provider',
      existingMetadata,
      AuthProviderAbstract
    );
  };
}
