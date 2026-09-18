import { describe, expect, it } from 'vitest';

import {
  SESSION_COOKIE,
  clearedSessionCookie,
  hashPassword,
  hashToken,
  newSessionToken,
  readSessionCookie,
  reviewerActor,
  sessionCookie,
  verifyPassword,
} from './auth.js';

/**
 * The session primitives, tested where they can be tested without a database.
 *
 * The properties that matter are the ones a reader has to take on trust
 * otherwise: that a stored password cannot be read back, that the database
 * never holds the cookie's secret, and that the cookie itself is not
 * script-readable or cross-site.
 */

describe('passwords are stored as scrypt hashes, not as passwords', () => {
  it('never stores the password', () => {
    const stored = hashPassword('correct horse battery staple');
    expect(stored).not.toContain('correct horse battery staple');
    expect(stored.startsWith('scrypt$')).toBe(true);
  });

  it('salts, so the same password hashes differently every time', () => {
    expect(hashPassword('same')).not.toBe(hashPassword('same'));
  });

  it('accepts the right password and refuses the wrong one', () => {
    const stored = hashPassword('right');
    expect(verifyPassword('right', stored)).toBe(true);
    expect(verifyPassword('wrong', stored)).toBe(false);
    expect(verifyPassword('', stored)).toBe(false);
  });

  it('refuses a malformed or foreign hash rather than throwing', () => {
    expect(verifyPassword('x', '')).toBe(false);
    expect(verifyPassword('x', 'plaintext')).toBe(false);
    expect(verifyPassword('x', 'bcrypt$salt$key')).toBe(false);
    expect(verifyPassword('x', 'scrypt$onlysalt')).toBe(false);
  });
});

describe('the database never holds the session secret', () => {
  it('hands out a token and stores only its hash', () => {
    const { token, tokenHash } = newSessionToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenHash).not.toBe(token);
    expect(hashToken(token)).toBe(tokenHash);
  });

  it('mints a different token every time', () => {
    expect(newSessionToken().token).not.toBe(newSessionToken().token);
  });
});

describe('the cookie cannot be read by script or sent cross-site', () => {
  it('sets HttpOnly, SameSite=Lax and a lifetime', () => {
    const cookie = sessionCookie('abc', { secure: false });
    expect(cookie).toContain(`${SESSION_COOKIE}=abc`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toMatch(/Max-Age=\d+/);
    expect(cookie).not.toContain('Secure');
  });

  it('adds Secure when the request came over TLS', () => {
    expect(sessionCookie('abc', { secure: true })).toContain('Secure');
  });

  it('clears by expiring immediately, with the same attributes', () => {
    const cookie = clearedSessionCookie({ secure: false });
    expect(cookie).toContain('Max-Age=0');
    expect(cookie).toContain('HttpOnly');
  });
});

describe('reading the cookie back', () => {
  it('finds the session among others', () => {
    expect(readSessionCookie(`theme=dark; ${SESSION_COOKIE}=tok123; other=1`)).toBe('tok123');
  });

  it('is null when absent, empty or unset', () => {
    expect(readSessionCookie(undefined)).toBeNull();
    expect(readSessionCookie('')).toBeNull();
    expect(readSessionCookie('theme=dark')).toBeNull();
    expect(readSessionCookie(`${SESSION_COOKIE}=`)).toBeNull();
  });

  it('does not match a cookie whose name merely ends with the session name', () => {
    expect(readSessionCookie(`not_${SESSION_COOKIE}=tok123`)).toBeNull();
  });
});

describe('the actor recorded in the audit trail', () => {
  it('is built from the session handle, never from a request body', () => {
    expect(reviewerActor('wasih')).toBe('human:wasih');
  });
});
