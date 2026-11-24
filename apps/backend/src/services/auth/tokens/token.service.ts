// Token auth: short-lived access tokens, rotating refresh tokens and revocable device sessions.
import { Injectable } from '@nestjs/common';
import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'crypto';
import { AuthService } from '@gitroom/helpers/auth/auth.service';
import { DeviceSessionsRepository } from '@gitroom/nestjs-libraries/database/prisma/device-sessions/device.sessions.repository';
import { tokenConfig } from '@gitroom/backend/services/auth/tokens/token.config';
import {
  InvalidAccessTokenException,
  InvalidGrantException,
  SessionRevokedException,
  TokenExpiredException,
} from '@gitroom/backend/services/auth/tokens/token.exceptions';

export interface TokenPair {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  session_id: string;
}

export interface DeviceSessionView {
  id: string;
  name: string | null;
  userAgent: string | null;
  ip: string | null;
  createdAt: string;
  lastSeenAt: string;
}

// The most a stored device label or address may hold.
const MAX_NAME = 100;
const MAX_USER_AGENT = 512;
// How long a session's last-seen time may lag behind real activity, so a request writes at most this often.
const LAST_SEEN_STEP_MS = 60 * 1000;

// The SHA-256 of a refresh token as lowercase hex; the only form in which one is stored.
const hashOf = (refreshToken: string) =>
  createHash('sha256').update(refreshToken).digest('hex');

// Whether two hex hashes are equal, in constant time.
const sameHash = (a: string | null, b: string) =>
  !!a &&
  a.length === b.length &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));

// The session id a refresh token names; null when it is not shaped like one.
const sessionIdOf = (refreshToken: unknown) => {
  if (typeof refreshToken !== 'string') {
    return null;
  }
  const dot = refreshToken.indexOf('.');
  if (dot < 1 || dot === refreshToken.length - 1) {
    return null;
  }
  return refreshToken.slice(0, dot);
};

// The refresh token that follows `refreshToken` in its session's chain. Derived with the server
// secret, so presenting the same old token again inside the grace window yields the same new one
// while the database holds only hashes.
const nextRefreshToken = (sessionId: string, refreshToken: string) =>
  `${sessionId}.${createHmac('sha256', process.env.JWT_SECRET!)
    .update(`refresh:${refreshToken}`)
    .digest('base64url')}`;

// Issues, rotates, revokes and verifies the tokens of device sessions.
@Injectable()
export class TokenService {
  // Receives the repository that stores device sessions.
  constructor(private _sessions: DeviceSessionsRepository) {}

  // Starts a session for the user on this device and returns its first token pair.
  async issue(
    userId: string,
    device: { name?: string; userAgent?: string; ip?: string }
  ): Promise<TokenPair> {
    const now = new Date();
    const sessionId = randomUUID();
    const refreshToken = `${sessionId}.${randomBytes(32).toString('base64url')}`;
    await this._sessions.create({
      id: sessionId,
      userId,
      name: device.name?.slice(0, MAX_NAME) || null,
      userAgent: device.userAgent?.slice(0, MAX_USER_AGENT) || null,
      ip: device.ip || null,
      refreshHash: hashOf(refreshToken),
      refreshExpiresAt: this.refreshExpiry(now),
      now,
    });
    return this.pairOf(userId, sessionId, refreshToken, now);
  }

  // Exchanges a refresh token for the next pair. The previous token presented again within the
  // grace window gets the same pair; any other old token revokes the session.
  async refresh(
    refreshToken: string,
    device: { userAgent?: string; ip?: string }
  ): Promise<TokenPair> {
    const sessionId = sessionIdOf(refreshToken);
    if (!sessionId) {
      throw new InvalidGrantException();
    }
    const presentedHash = hashOf(refreshToken);
    const now = new Date();
    let session = await this._sessions.findById(sessionId);
    if (!session || session.revokedAt) {
      throw new InvalidGrantException();
    }

    if (sameHash(session.refreshHash, presentedHash)) {
      const next = nextRefreshToken(session.id, refreshToken);
      const rotated = await this._sessions.rotate(session.id, presentedHash, {
        refreshHash: hashOf(next),
        refreshExpiresAt: this.refreshExpiry(now),
        rotatedAt: now,
        userAgent: device.userAgent?.slice(0, MAX_USER_AGENT),
        ip: device.ip,
      });
      if (rotated) {
        return this.pairOf(session.userId, session.id, next, now);
      }
      // another request rotated first, or the session just ended: decide again from what is stored
      session = await this._sessions.findById(session.id);
      if (!session || session.revokedAt) {
        throw new InvalidGrantException();
      }
    }

    const graceMs = tokenConfig().graceSeconds * 1000;
    if (
      sameHash(session.previousRefreshHash, presentedHash) &&
      session.rotatedAt &&
      now.getTime() - session.rotatedAt.getTime() <= graceMs
    ) {
      return this.pairOf(
        session.userId,
        session.id,
        nextRefreshToken(session.id, refreshToken),
        session.rotatedAt
      );
    }

    // an old token or one whose reply grace has passed: the session may be in two hands
    await this._sessions.revoke(session.id, now);
    throw new InvalidGrantException();
  }

  // Ends the user's own session; does nothing when it is not theirs or already ended.
  async revoke(sessionId: string, userId: string): Promise<void> {
    await this._sessions.revokeForUser(sessionId, userId, new Date());
  }

  // Ends the session a presented refresh token belongs to, when the token is that session's current
  // or previous one; the answer never tells whether it was.
  async revokeRefreshToken(refreshToken: string): Promise<void> {
    const sessionId = sessionIdOf(refreshToken);
    if (!sessionId) {
      return;
    }
    const session = await this._sessions.findById(sessionId);
    const hash = hashOf(refreshToken);
    if (
      session &&
      (sameHash(session.refreshHash, hash) ||
        sameHash(session.previousRefreshHash, hash))
    ) {
      await this._sessions.revoke(session.id, new Date());
    }
  }

  // Checks an access token's signature, expiry and session, and returns whose it is.
  async verifyAccess(
    accessToken: string
  ): Promise<{ userId: string; sessionId: string }> {
    let payload: { sub?: unknown; sid?: unknown };
    try {
      payload = AuthService.verifyJWT(accessToken) as typeof payload;
    } catch (err: any) {
      if (err?.name === 'TokenExpiredError') {
        throw new TokenExpiredException();
      }
      throw new InvalidAccessTokenException();
    }
    // a token without a session id (upstream's one-year token) is refused
    if (typeof payload?.sub !== 'string' || typeof payload?.sid !== 'string') {
      throw new InvalidAccessTokenException();
    }
    const session = await this._sessions.findById(payload.sid);
    if (!session || session.userId !== payload.sub) {
      throw new InvalidAccessTokenException();
    }
    if (session.revokedAt) {
      throw new SessionRevokedException();
    }
    const now = new Date();
    await this._sessions.touch(
      session.id,
      now,
      new Date(now.getTime() - LAST_SEEN_STEP_MS)
    );
    return { userId: session.userId, sessionId: session.id };
  }

  // The user's sessions that are not revoked, newest activity first.
  async listSessions(userId: string): Promise<DeviceSessionView[]> {
    const sessions = await this._sessions.listLive(userId);
    return sessions.map((session) => ({
      id: session.id,
      name: session.name,
      userAgent: session.userAgent,
      ip: session.ip,
      createdAt: session.createdAt.toISOString(),
      lastSeenAt: session.lastSeenAt.toISOString(),
    }));
  }

  // The moment a refresh token issued at `from` stops being accepted.
  private refreshExpiry(from: Date) {
    return new Date(
      from.getTime() + tokenConfig().refreshTtlDays * 24 * 60 * 60 * 1000
    );
  }

  // The token pair for a session whose current refresh token is `refreshToken`, the access token
  // stamped with the moment the refresh token was issued so the same call always gives the same pair.
  private pairOf(
    userId: string,
    sessionId: string,
    refreshToken: string,
    issuedAt: Date
  ): TokenPair {
    const { accessTtlSeconds } = tokenConfig();
    const iat = Math.floor(issuedAt.getTime() / 1000);
    return {
      access_token: AuthService.signJWT({
        sub: userId,
        sid: sessionId,
        iat,
        exp: iat + accessTtlSeconds,
      }),
      token_type: 'Bearer',
      expires_in: accessTtlSeconds,
      refresh_token: refreshToken,
      session_id: sessionId,
    };
  }
}
