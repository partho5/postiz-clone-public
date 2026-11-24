// Token auth: resolving the credentials of a sign-in grant (Google ID token) to a user.
import { Injectable, Logger } from '@nestjs/common';
import { Provider, User } from '@prisma/client';
import { google } from 'googleapis';
import { UsersService } from '@gitroom/nestjs-libraries/database/prisma/users/users.service';
import { InvalidGrantException } from '@gitroom/backend/services/auth/tokens/token.exceptions';

// Turns the credentials of a sign-in grant into the user they belong to.
@Injectable()
export class TokenGrantsService {
  private readonly _logger = new Logger(TokenGrantsService.name);
  private readonly _google = new google.auth.OAuth2();

  // Receives the users service the grants look accounts up in.
  constructor(private _usersService: UsersService) {}

  // The activated user whose Google account signed this ID token for this app; INVALID_GRANT for a bad
  // token or an account that has not signed up.
  async googleIdToken(idToken: string): Promise<User> {
    const audience = process.env.YOUTUBE_CLIENT_ID;
    if (!audience) {
      throw new Error('Google sign-in is not configured: YOUTUBE_CLIENT_ID');
    }
    let googleId: string | undefined;
    try {
      const ticket = await this._google.verifyIdToken({ idToken, audience });
      const payload = ticket.getPayload();
      googleId = payload?.email_verified ? payload.sub : undefined;
    } catch (err: any) {
      this._logger.warn(`google id token refused: ${err?.message}`);
    }
    const user = googleId
      ? await this._usersService.getUserByProvider(googleId, Provider.GOOGLE)
      : null;
    if (!user || !user.activated) {
      throw new InvalidGrantException();
    }
    return user;
  }
}
