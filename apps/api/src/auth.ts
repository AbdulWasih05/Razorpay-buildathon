import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * Reviewer sessions: who is allowed to open the one door.
 *
 * Before this, `approvedBy` came from the request body. The API believed
 * whatever a caller claimed, and the audit trail recorded that claim as the
 * human who approved a contest. F-013 was one version of that bug; the deeper
 * version is that a money action's identity cannot come from the same place as
 * the money action's request.
 *
 * The shape here is deliberately small, and has no new dependency:
 *
 *   - A session is a random 256-bit token. The **cookie carries the token; the
 *     database stores only its SHA-256**. A dump of the session table
 *     therefore grants nobody a session, and a token is never logged because
 *     nothing but the cookie holds it.
 *   - Passwords are scrypt with a per-password salt, compared with
 *     `timingSafeEqual`. No pepper, no configurable cost: one algorithm, one
 *     set of parameters, written down.
 *   - Cookies are `HttpOnly` (script cannot read them), `SameSite=Lax` (a
 *     cross-site form post cannot approve a dispute) and `Secure` whenever the
 *     request arrived over TLS.
 *
 * What this is not: user management. Reviewers are seeded. This is an internal
 * risk console whose one privileged action is approving a contest, and
 * self-service signup would be a way in rather than a feature.
 */

export const SESSION_COOKIE = 'praman_session';

/**
 * The reviewer a demo instance signs visitors in as.
 *
 * Seeded only when `DEMO_MODE=true`, and reachable only through
 * `POST /auth/demo-login`, which exists on demo instances alone. It has no
 * usable password: the row is created with a random one that is thrown away,
 * so the handle is worthless anywhere the demo route does not exist.
 */
export const DEMO_REVIEWER_HANDLE = 'demo';

/** A working day, so a reviewer is not logged out mid-queue. */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

const SCRYPT_KEY_LENGTH = 64;

/** `scrypt$<salt hex>$<key hex>`. The format names its own algorithm. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, SCRYPT_KEY_LENGTH);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltHex, keyHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !keyHex) return false;

  const expected = Buffer.from(keyHex, 'hex');
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  // Length is checked first because timingSafeEqual throws on a mismatch.
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export interface SessionToken {
  /** Goes to the browser, in the cookie. Never stored. */
  token: string;
  /** Goes to the database, as the row id. */
  tokenHash: string;
}

export function newSessionToken(): SessionToken {
  const token = randomBytes(32).toString('hex');
  return { token, tokenHash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** The session token from a `Cookie` header, or null. */
export function readSessionCookie(header: string | undefined): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === SESSION_COOKIE) {
      const value = rest.join('=');
      return value.length > 0 ? decodeURIComponent(value) : null;
    }
  }
  return null;
}

export function sessionCookie(token: string, options: { secure: boolean }): string {
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    ...(options.secure ? ['Secure'] : []),
  ].join('; ');
}

export function clearedSessionCookie(options: { secure: boolean }): string {
  return [
    `${SESSION_COOKIE}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
    ...(options.secure ? ['Secure'] : []),
  ].join('; ');
}

/** The reviewer identity the audit trail records. Never built from a request body. */
export function reviewerActor(handle: string): `human:${string}` {
  return `human:${handle}`;
}
