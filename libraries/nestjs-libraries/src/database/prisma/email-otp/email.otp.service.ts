// Email one-time-code sign-in: sending a six-digit code to an address and turning the right code into a user.
import { createHmac, randomInt, timingSafeEqual } from 'crypto';
import { HttpException, Injectable, Logger } from '@nestjs/common';
import { User } from '@prisma/client';
import { EmailOtpRepository } from '@gitroom/nestjs-libraries/database/prisma/email-otp/email.otp.repository';
import { otpConfig } from '@gitroom/nestjs-libraries/database/prisma/email-otp/email.otp.config';
import { UsersService } from '@gitroom/nestjs-libraries/database/prisma/users/users.service';
import {
  EmailService,
  MailDeliveryError,
} from '@gitroom/nestjs-libraries/services/email.service';
import { AuthService } from '@gitroom/backend/services/auth/auth.service';
import {
  AuthAttemptLimiter,
  underAttemptLock,
} from '@gitroom/backend/services/auth/tokens/auth.attempt.limiter';
import {
  AuthRateLimitedException,
  InvalidGrantException,
} from '@gitroom/backend/services/auth/tokens/token.exceptions';

// How long a request row is kept, so the per-address and per-client counts have their history.
const ROW_RETENTION_MS = 24 * 60 * 60 * 1000;

const CODE_FORMAT = /^\d{6}$/;

// The address as every comparison and lookup uses it: trimmed and lower-cased.
const normalizeEmail = (email: string) => email.trim().toLowerCase();

// The name a sign-in provider shared for an address, given to the user that address signs in as.
export interface EmailOtpProfile {
  name?: string;
  lastName?: string;
}

// Answers 503 MAIL_DELIVERY_FAILED: the code could not be sent.
class MailDeliveryFailedException extends HttpException {
  // Answers 503 with the code clients branch on.
  constructor() {
    super({ statusCode: 503, code: 'MAIL_DELIVERY_FAILED' }, 503);
  }
}

// Sends sign-in codes by email and exchanges the right code for the user it signs in.
@Injectable()
export class EmailOtpService {
  private readonly _logger = new Logger(EmailOtpService.name);

  // Receives the code store, the mailer, the users and sign-up services and the failed-attempt limiter.
  constructor(
    private _emailOtpRepository: EmailOtpRepository,
    private _emailService: EmailService,
    private _usersService: UsersService,
    private _authService: AuthService,
    private _attemptLimiter: AuthAttemptLimiter
  ) {}

  // Sends a new code to the address; answers the same for every address, and sends nothing to a new
  // address that may not register. Past the request limit it throws AUTH_RATE_LIMITED.
  async request(email: string, clientIp: string): Promise<void> {
    const address = normalizeEmail(email);
    const { ttlSeconds, requestLimit, requestWindowSeconds, resendCooldownSeconds } =
      otpConfig();
    const now = new Date();
    const productName = process.env.EMAIL_FROM_NAME;

    await this._emailOtpRepository.deleteCreatedBefore(
      new Date(now.getTime() - ROW_RETENTION_MS)
    );
    const claim = await this._emailOtpRepository.claimRequest({
      email: address,
      requestIp: clientIp,
      now,
      windowStart: new Date(now.getTime() - requestWindowSeconds * 1000),
      limit: requestLimit,
      cooldownSeconds: resendCooldownSeconds,
    });
    if (claim.claimed === false) {
      throw new AuthRateLimitedException(claim.retryAfterSeconds);
    }

    if (!(await this.mayReceiveCode(address))) {
      return;
    }

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await this._emailOtpRepository.activate(
      claim.id,
      address,
      this.hashCode(address, code),
      new Date(now.getTime() + ttlSeconds * 1000),
      now
    );
    try {
      await this._emailService.sendRequired(
        address,
        `${code} is your ${productName} sign-in code`,
        `Your ${productName} sign-in code is <strong>${code}</strong>.<br />It works once and expires in ${Math.ceil(
          ttlSeconds / 60
        )} minutes. If you did not ask for it, you can ignore this email.`
      );
    } catch (err) {
      if (!(err instanceof MailDeliveryError)) {
        throw err;
      }
      await this._emailOtpRepository.retire(claim.id, new Date());
      throw new MailDeliveryFailedException();
    }
  }

  // Exchanges the right code for the user it signs in, creating the user, workspace and account for a new
  // address; every refusal is INVALID_GRANT and counts as a sign-in failure of the client address.
  verify(
    email: string,
    code: string,
    clientIp: string
  ): Promise<{ userId: string; created: boolean }> {
    // parallel attempts from one address are checked and counted one after another
    return underAttemptLock(clientIp, 'sign_in', async () => {
      await this._attemptLimiter.assertAllowed(clientIp, 'sign_in');
      const address = normalizeEmail(email);
      if (!(await this.consumeCode(address, code))) {
        await this._attemptLimiter.recordFailure(clientIp, 'sign_in');
        throw new InvalidGrantException();
      }
      return this.userForAddress(address, clientIp);
    });
  }

  // Signs in the user of an address a sign-in provider has verified, with no code: the same user a code
  // for the address signs in as (created the same way when there is none), under the same failed-attempt
  // limit. The provider's name fills only the user's empty name fields.
  signInVerified(
    email: string,
    clientIp: string,
    profile: EmailOtpProfile
  ): Promise<{ userId: string; created: boolean }> {
    return underAttemptLock(clientIp, 'sign_in', async () => {
      await this._attemptLimiter.assertAllowed(clientIp, 'sign_in');
      return this.userForAddress(normalizeEmail(email), clientIp, profile);
    });
  }

  // Whether a code may be sent to the address: it already has a user, or it may register.
  private async mayReceiveCode(address: string): Promise<boolean> {
    if (await this._emailOtpRepository.findOldestUserByEmail(address)) {
      return true;
    }
    return this._authService.canRegisterEmail(address);
  }

  // Uses the address's code when the value is right; a wrong value counts one try against the code.
  private async consumeCode(address: string, code: string): Promise<boolean> {
    const { maxTries } = otpConfig();
    const now = new Date();
    const row = await this._emailOtpRepository.findUsable(
      address,
      now,
      maxTries
    );
    if (!row) {
      return false;
    }
    if (!CODE_FORMAT.test(code) || !this.matches(row.codeHash, address, code)) {
      await this._emailOtpRepository.addTry(row.id, maxTries);
      return false;
    }
    return this._emailOtpRepository.consume(row.id, now, maxTries);
  }

  // The user the proven address signs in as: the oldest it has under any provider, or a new one; a
  // provider's name fills the user's empty name fields.
  private async userForAddress(
    address: string,
    clientIp: string,
    profile?: EmailOtpProfile
  ): Promise<{ userId: string; created: boolean }> {
    const existing = await this._emailOtpRepository.findOldestUserByEmail(
      address
    );
    if (existing) {
      await this.activateIfPending(existing);
      await this.fillName(existing, profile);
      return { userId: existing.id, created: false };
    }
    if (!(await this._authService.canRegisterEmail(address))) {
      throw new HttpException('Sign-in failed', 400);
    }
    try {
      const user = await this._authService.createEmailUser(
        address,
        clientIp,
        ''
      );
      await this.fillName(user, profile);
      return { userId: user.id, created: true };
    } catch (err: any) {
      // the error text can carry the address, so only its kind is logged
      this._logger.error(`sign-up failed: ${err?.name} ${err?.code ?? ''}`);
      throw new HttpException('Sign-in failed', 400);
    }
  }

  // Gives the user the name a sign-in provider shared, where the user has none; a failure here never
  // fails the sign-in.
  private async fillName(user: User, profile?: EmailOtpProfile): Promise<void> {
    if (!profile?.name && !profile?.lastName) {
      return;
    }
    try {
      await this._usersService.fillEmptyName(user, profile);
    } catch (err: any) {
      this._logger.error(`provider name not saved: ${err?.name}`);
    }
  }

  // Marks a user created before activation was removed as activated: the code proved their mailbox.
  private async activateIfPending(user: User): Promise<void> {
    if (!user.activated) {
      await this._usersService.activateUser(user.id);
    }
  }

  // The keyed hash of a code for an address; the key is the server's JWT secret, so the table alone does
  // not reveal a code.
  private hashCode(address: string, code: string): string {
    const key = process.env.JWT_SECRET;
    if (!key) {
      throw new Error('JWT_SECRET is required to store sign-in codes');
    }
    return createHmac('sha256', key)
      .update(`email-otp:${address}:${code}`)
      .digest('hex');
  }

  // Whether the code hashes to the stored value, compared in constant time.
  private matches(stored: string, address: string, code: string): boolean {
    const given = Buffer.from(this.hashCode(address, code));
    const expected = Buffer.from(stored);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }
}
