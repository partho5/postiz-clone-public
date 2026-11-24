import {
  AuthProvider,
  AuthProviderAbstract,
} from '@gitroom/backend/services/auth/providers.interface';
import { NeynarAPIClient } from '@neynar/nodejs-sdk';
import {
  createNeynarSigner,
  neynarSignerStatus,
} from '@gitroom/nestjs-libraries/integrations/social/farcaster.provider';

const client = new NeynarAPIClient({
  apiKey: process.env.NEYNAR_SECRET_KEY || '00000000-000-0000-000-000000000000',
});

@AuthProvider({ provider: 'FARCASTER' })
export class FarcasterProvider extends AuthProviderAbstract {
  // no OAuth redirect here, the frontend only needs the state nonce that
  // pairs with the oauth_state cookie set by /auth/oauth/FARCASTER
  generateLink(query?: { state?: string }) {
    return query?.state || '';
  }

  // Sign-in signers come from the product's own Neynar app (.env), never a workspace's: there is
  // no workspace before sign-in. Channel connect uses /integrations/farcaster/signer instead.
  async createSigner() {
    if (!process.env.NEYNAR_APP_FID || !process.env.NEYNAR_APP_MNEMONIC) {
      throw new Error(
        'Farcaster is not configured: set NEYNAR_APP_FID and NEYNAR_APP_MNEMONIC'
      );
    }

    return createNeynarSigner({
      apiKey:
        process.env.NEYNAR_SECRET_KEY || '00000000-000-0000-000-000000000000',
      appFid: Number(process.env.NEYNAR_APP_FID),
      mnemonic: process.env.NEYNAR_APP_MNEMONIC,
      sponsor: process.env.NEYNAR_SPONSOR_SIGNERS === 'true',
    });
  }

  signerStatus(signerUuid: string) {
    return neynarSignerStatus(
      process.env.NEYNAR_SECRET_KEY || '00000000-000-0000-000-000000000000',
      signerUuid
    );
  }

  async getToken(code: string, _redirectUri?: string) {
    const data = JSON.parse(Buffer.from(code, 'base64').toString());
    const status = await client.lookupSigner({ signerUuid: data.signer_uuid });
    if (status.status === 'approved') {
      return data.signer_uuid;
    }

    return '';
  }

  async getUser(providerToken: string) {
    const status = await client.lookupSigner({ signerUuid: providerToken });
    if (status.status !== 'approved') {
      return {
        id: '',
        email: '',
      };
    }

    return {
      id: String('farcaster_' + status.fid),
      email: String('farcaster_' + status.fid),
    };
  }
}
