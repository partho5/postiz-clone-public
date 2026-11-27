// Workspace app credentials (T4): AES-256-GCM with a random 12-byte IV per value and a key derived
// from APP_CREDENTIALS_SECRET. Each value is bound to its workspace and key name (additional
// authenticated data), so a value copied to another workspace or another key does not decrypt.
import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const VERSION = 'v1';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

// Who a value belongs to; part of the authenticated data of its ciphertext.
export interface AppCredentialOwner {
  organizationId: string;
  key: string;
}

// The 32-byte encryption key; refuses to work without a strong APP_CREDENTIALS_SECRET (fail closed).
const encryptionKey = () => {
  const secret = process.env.APP_CREDENTIALS_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      'APP_CREDENTIALS_SECRET is not set or shorter than 32 characters (generate one with: openssl rand -hex 32). Workspace app credentials cannot be saved or read without it.'
    );
  }
  return Buffer.from(
    crypto.hkdfSync('sha256', secret, 'app-credentials', 'aes-256-gcm v1', 32)
  );
};

const authenticatedData = (owner: AppCredentialOwner) =>
  Buffer.from(`${owner.organizationId}\n${owner.key}`, 'utf8');

// Encrypts a value as "v1:<iv>:<tag>:<ciphertext>" (base64 parts).
export function encryptAppCredential(
  value: string,
  owner: AppCredentialOwner
): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, encryptionKey(), iv, {
    authTagLength: TAG_LENGTH,
  });
  cipher.setAAD(authenticatedData(owner));
  const encrypted = Buffer.concat([
    cipher.update(value, 'utf8'),
    cipher.final(),
  ]);
  return [
    VERSION,
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    encrypted.toString('base64'),
  ].join(':');
}

// Decrypts a value written by `encryptAppCredential` for the same owner; throws when it was not.
export function decryptAppCredential(
  stored: string,
  owner: AppCredentialOwner
): string {
  const [version, iv, tag, encrypted] = (stored || '').split(':');
  if (version !== VERSION || !iv || !tag || encrypted === undefined) {
    throw new Error(`The stored app credential ${owner.key} is not readable.`);
  }

  try {
    const decipher = crypto.createDecipheriv(
      ALGORITHM,
      encryptionKey(),
      Buffer.from(iv, 'base64'),
      { authTagLength: TAG_LENGTH }
    );
    decipher.setAAD(authenticatedData(owner));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(encrypted, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch (err) {
    if (
      err instanceof Error &&
      err.message.includes('APP_CREDENTIALS_SECRET')
    ) {
      throw err;
    }
    throw new Error(
      `The stored app credential ${owner.key} could not be decrypted (APP_CREDENTIALS_SECRET changed or the value is damaged); enter it again on the App credentials page.`
    );
  }
}
