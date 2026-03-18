import crypto from 'crypto';
import { query } from './db.js';
import { logger } from './logger.js';

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'default-key-change-in-production';
const ALGORITHM = 'aes-256-gcm';

function getKey(): Buffer {
  return crypto.scryptSync(ENCRYPTION_KEY, 'salt', 32);
}

export function encrypt(text: string): string {
  const iv = crypto.randomBytes(16);
  const key = getKey();
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const authTag = cipher.getAuthTag();

  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

export function decrypt(encryptedText: string): string {
  const [ivHex, authTagHex, encrypted] = encryptedText.split(':');

  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const key = getKey();

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  scope: string | null;
}

export async function saveTokens(
  service: string,
  tokens: OAuthTokens
): Promise<void> {
  const encryptedAccess = encrypt(tokens.accessToken);
  const encryptedRefresh = tokens.refreshToken ? encrypt(tokens.refreshToken) : null;

  await query(
    `INSERT INTO oauth_tokens (service, access_token, refresh_token, expires_at, scope, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (service) DO UPDATE SET
       access_token = $2,
       refresh_token = $3,
       expires_at = $4,
       scope = $5,
       updated_at = NOW()`,
    [service, encryptedAccess, encryptedRefresh, tokens.expiresAt, tokens.scope]
  );

  logger.info(`Saved OAuth tokens for ${service}`);
}

export async function getTokens(service: string): Promise<OAuthTokens | null> {
  const { rows } = await query<{
    access_token: string;
    refresh_token: string | null;
    expires_at: Date | null;
    scope: string | null;
  }>(
    'SELECT access_token, refresh_token, expires_at, scope FROM oauth_tokens WHERE service = $1',
    [service]
  );

  if (rows.length === 0) {
    return null;
  }

  const row = rows[0];

  try {
    return {
      accessToken: decrypt(row.access_token),
      refreshToken: row.refresh_token ? decrypt(row.refresh_token) : null,
      expiresAt: row.expires_at,
      scope: row.scope,
    };
  } catch (err) {
    logger.error(`Failed to decrypt tokens for ${service}:`, err);
    return null;
  }
}

export async function deleteTokens(service: string): Promise<void> {
  await query('DELETE FROM oauth_tokens WHERE service = $1', [service]);
  logger.info(`Deleted OAuth tokens for ${service}`);
}

export function isTokenExpired(expiresAt: Date | null): boolean {
  if (!expiresAt) return false;
  // Consider token expired 5 minutes before actual expiry
  return new Date(expiresAt.getTime() - 5 * 60 * 1000) <= new Date();
}
