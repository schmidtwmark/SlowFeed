import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type VerifiedRegistrationResponse,
  type VerifiedAuthenticationResponse,
} from '@simplewebauthn/server';
import type {
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  AuthenticatorTransportFuture,
} from '@simplewebauthn/server';
import { query } from './db.js';
import { logger } from './logger.js';
import crypto from 'crypto';

// WebAuthn configuration from environment
const rpID = process.env.WEBAUTHN_RP_ID || 'localhost';
const rpName = process.env.WEBAUTHN_RP_NAME || 'Slowfeed';
const origin = process.env.WEBAUTHN_ORIGIN || 'http://localhost:3000';

// Fixed user ID for single-user mode
const USER_ID = 'slowfeed-user';
const USER_NAME = 'slowfeed';
const USER_DISPLAY_NAME = 'Slowfeed User';

export interface PasskeyCredential {
  id: string;
  publicKey: Buffer;
  counter: number;
  deviceType: string;
  backedUp: boolean;
  transports: AuthenticatorTransportFuture[] | null;
  name: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
}

interface ChallengeRecord {
  id: string;
  challenge: string;
  type: 'registration' | 'authentication';
  expiresAt: Date;
}

// Generate a unique challenge ID
function generateChallengeId(): string {
  return crypto.randomBytes(32).toString('base64url');
}

// Store a challenge in the database
async function storeChallenge(
  challenge: string,
  type: 'registration' | 'authentication'
): Promise<string> {
  const id = generateChallengeId();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

  await query(
    `INSERT INTO webauthn_challenges (id, challenge, type, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [id, challenge, type, expiresAt]
  );

  return id;
}

// Get and consume a challenge
async function getAndDeleteChallenge(
  id: string,
  expectedType: 'registration' | 'authentication'
): Promise<string | null> {
  const { rows } = await query<ChallengeRecord>(
    `DELETE FROM webauthn_challenges
     WHERE id = $1 AND type = $2 AND expires_at > NOW()
     RETURNING challenge`,
    [id, expectedType]
  );

  return rows[0]?.challenge || null;
}

// Clean up expired challenges
export async function cleanupExpiredChallenges(): Promise<void> {
  await query('DELETE FROM webauthn_challenges WHERE expires_at < NOW()');
}

// Check if any passkeys exist (for setup detection)
export async function hasPasskeys(): Promise<boolean> {
  const { rows } = await query<{ count: string }>(
    'SELECT COUNT(*) as count FROM passkey_credentials'
  );
  return parseInt(rows[0].count, 10) > 0;
}

// Get all passkey credentials
export async function getCredentials(): Promise<PasskeyCredential[]> {
  const { rows } = await query<{
    id: string;
    public_key: Buffer;
    counter: string;
    device_type: string;
    backed_up: boolean;
    transports: string[] | null;
    name: string | null;
    created_at: Date;
    last_used_at: Date | null;
  }>(
    `SELECT id, public_key, counter, device_type, backed_up, transports, name, created_at, last_used_at
     FROM passkey_credentials
     ORDER BY created_at DESC`
  );

  return rows.map((row) => ({
    id: row.id,
    publicKey: row.public_key,
    counter: parseInt(row.counter, 10),
    deviceType: row.device_type,
    backedUp: row.backed_up,
    transports: row.transports as AuthenticatorTransportFuture[] | null,
    name: row.name,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  }));
}

// Get a single credential by ID
async function getCredential(id: string): Promise<PasskeyCredential | null> {
  const { rows } = await query<{
    id: string;
    public_key: Buffer;
    counter: string;
    device_type: string;
    backed_up: boolean;
    transports: string[] | null;
    name: string | null;
    created_at: Date;
    last_used_at: Date | null;
  }>(
    `SELECT id, public_key, counter, device_type, backed_up, transports, name, created_at, last_used_at
     FROM passkey_credentials
     WHERE id = $1`,
    [id]
  );

  if (rows.length === 0) return null;

  const row = rows[0];
  return {
    id: row.id,
    publicKey: row.public_key,
    counter: parseInt(row.counter, 10),
    deviceType: row.device_type,
    backedUp: row.backed_up,
    transports: row.transports as AuthenticatorTransportFuture[] | null,
    name: row.name,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

// Delete a credential
export async function deleteCredential(id: string): Promise<boolean> {
  // Don't allow deleting the last passkey
  const credentials = await getCredentials();
  if (credentials.length <= 1) {
    throw new Error('Cannot delete the last passkey');
  }

  const result = await query('DELETE FROM passkey_credentials WHERE id = $1', [id]);
  return (result.rowCount ?? 0) > 0;
}

// Rename a credential
export async function renameCredential(id: string, name: string): Promise<boolean> {
  const result = await query(
    'UPDATE passkey_credentials SET name = $1 WHERE id = $2',
    [name, id]
  );
  return (result.rowCount ?? 0) > 0;
}

// Start passkey registration
export async function startRegistration(): Promise<{
  options: PublicKeyCredentialCreationOptionsJSON;
  challengeId: string;
}> {
  const existingCredentials = await getCredentials();

  const options = await generateRegistrationOptions({
    rpName,
    rpID,
    userName: USER_NAME,
    userDisplayName: USER_DISPLAY_NAME,
    // Use Uint8Array for user ID
    userID: new TextEncoder().encode(USER_ID),
    // Prefer resident keys (passkeys)
    attestationType: 'none',
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'preferred',
      authenticatorAttachment: 'platform',
    },
    // Exclude existing credentials to prevent re-registration
    excludeCredentials: existingCredentials.map((cred) => ({
      id: cred.id,
      transports: cred.transports || undefined,
    })),
  });

  const challengeId = await storeChallenge(options.challenge, 'registration');

  logger.info('WebAuthn registration started');

  return { options, challengeId };
}

// Finish passkey registration
export async function finishRegistration(
  challengeId: string,
  response: RegistrationResponseJSON,
  passkeyName?: string
): Promise<VerifiedRegistrationResponse> {
  const expectedChallenge = await getAndDeleteChallenge(challengeId, 'registration');

  if (!expectedChallenge) {
    throw new Error('Invalid or expired challenge');
  }

  const verification = await verifyRegistrationResponse({
    response,
    expectedChallenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
  });

  if (!verification.verified || !verification.registrationInfo) {
    throw new Error('Registration verification failed');
  }

  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;

  // Store the credential
  const name = passkeyName || `Passkey ${new Date().toLocaleDateString()}`;

  await query(
    `INSERT INTO passkey_credentials (id, public_key, counter, device_type, backed_up, transports, name)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      credential.id,
      Buffer.from(credential.publicKey),
      credential.counter,
      credentialDeviceType,
      credentialBackedUp,
      response.response.transports || null,
      name,
    ]
  );

  logger.info(`WebAuthn credential registered: ${credential.id.substring(0, 8)}...`);

  return verification;
}

// Start passkey authentication
export async function startAuthentication(): Promise<{
  options: PublicKeyCredentialRequestOptionsJSON;
  challengeId: string;
}> {
  const credentials = await getCredentials();

  if (credentials.length === 0) {
    throw new Error('No passkeys registered');
  }

  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: 'preferred',
    // Allow any registered credential
    allowCredentials: credentials.map((cred) => ({
      id: cred.id,
      transports: cred.transports || undefined,
    })),
  });

  const challengeId = await storeChallenge(options.challenge, 'authentication');

  logger.info('WebAuthn authentication started');

  return { options, challengeId };
}

// Finish passkey authentication
export async function finishAuthentication(
  challengeId: string,
  response: AuthenticationResponseJSON
): Promise<VerifiedAuthenticationResponse> {
  const expectedChallenge = await getAndDeleteChallenge(challengeId, 'authentication');

  if (!expectedChallenge) {
    throw new Error('Invalid or expired challenge');
  }

  // Get the credential being used
  const credential = await getCredential(response.id);

  if (!credential) {
    throw new Error('Unknown credential');
  }

  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    credential: {
      id: credential.id,
      publicKey: new Uint8Array(credential.publicKey),
      counter: credential.counter,
      transports: credential.transports || undefined,
    },
  });

  if (!verification.verified) {
    throw new Error('Authentication verification failed');
  }

  // Update counter and last used timestamp
  await query(
    `UPDATE passkey_credentials
     SET counter = $1, last_used_at = NOW()
     WHERE id = $2`,
    [verification.authenticationInfo.newCounter, response.id]
  );

  logger.info(`WebAuthn authentication successful: ${response.id.substring(0, 8)}...`);

  return verification;
}

// Get WebAuthn config for debugging
export function getWebAuthnConfig() {
  return {
    rpID,
    rpName,
    origin,
  };
}
