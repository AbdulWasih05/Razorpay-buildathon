import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SESSION_COOKIE, hashPassword, hashToken, newSessionToken } from './auth.js';
import { buildServer } from './server.js';

/**
 * Sessions, end to end through the real routes and a real database.
 *
 * The property under test is the one the product's central claim rests on:
 * the identity on an approval comes from a session the server issued, and a
 * caller cannot supply one. Everything else here -- expiry, logout, the
 * uniform failure message -- exists so that claim has no side doors.
 *
 * Database-gated, like `roundtrip.test.ts`, and skipped loudly rather than
 * silently (D-029).
 */

const DATABASE_URL = process.env['DATABASE_URL'];

async function databaseReachable(): Promise<boolean> {
  if (!DATABASE_URL) return false;
  const probe = new PrismaClient();
  try {
    await probe.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  } finally {
    await probe.$disconnect();
  }
}

const reachable = await databaseReachable();

if (!reachable) {
  console.warn(
    '\n  [auth-flow.test.ts] SKIPPED: no reachable database.\n' +
      '  This covers who is allowed to open the one door.\n' +
      '  Run `pnpm db:up` locally, or see the CI `integration` job.\n',
  );
}

describe.skipIf(!reachable)('reviewer sessions', () => {
  const prisma = new PrismaClient();
  const app = buildServer({ prisma });
  const handle = `test-reviewer-${Date.now()}`;
  const password = 'a-password-only-this-test-knows';
  let reviewerId = '';

  beforeAll(async () => {
    await app.ready();
    const reviewer = await prisma.reviewer.create({
      data: { handle, passwordHash: hashPassword(password) },
    });
    reviewerId = reviewer.id;
  });

  afterAll(async () => {
    await prisma.session.deleteMany({ where: { reviewerId } });
    await prisma.reviewer.deleteMany({ where: { id: reviewerId } });
    await app.close();
    await prisma.$disconnect();
  });

  async function signIn(): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { handle, password },
    });
    expect(response.statusCode, response.body).toBe(200);
    const cookie = response.headers['set-cookie'];
    return Array.isArray(cookie) ? (cookie[0] as string) : (cookie as string);
  }

  it('says nobody is signed in when there is no cookie', async () => {
    const response = await app.inject({ method: 'GET', url: '/auth/me' });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'not_signed_in' });
  });

  it('refuses a wrong password, and says nothing about whether the handle exists', async () => {
    const wrongPassword = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { handle, password: 'not-it' },
    });
    const unknownHandle = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { handle: 'nobody-by-that-name', password: 'not-it' },
    });

    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownHandle.statusCode).toBe(401);
    // Identical answers: "no such reviewer" is a question outsiders should not
    // be able to ask.
    expect(wrongPassword.json()).toEqual(unknownHandle.json());
    expect(wrongPassword.headers['set-cookie']).toBeUndefined();
  });

  it('issues an HttpOnly session cookie and then knows who you are', async () => {
    const cookie = await signIn();
    expect(cookie).toContain(`${SESSION_COOKIE}=`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');

    const me = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toEqual({ handle });
  });

  it('stores only the hash of the token, never the token itself', async () => {
    const cookie = await signIn();
    const token = /praman_session=([^;]+)/.exec(cookie)?.[1] as string;

    expect(await prisma.session.findUnique({ where: { id: token } })).toBeNull();
    const stored = await prisma.session.findUnique({ where: { id: hashToken(token) } });
    expect(stored?.reviewerId).toBe(reviewerId);
  });

  it('refuses an expired session and deletes it on sight', async () => {
    const { token, tokenHash } = newSessionToken();
    await prisma.session.create({
      data: { id: tokenHash, reviewerId, expiresAt: new Date(Date.now() - 1000) },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
    });

    expect(response.statusCode).toBe(401);
    expect(await prisma.session.findUnique({ where: { id: tokenHash } })).toBeNull();
  });

  it('signs out by deleting the session, not just clearing the cookie', async () => {
    const cookie = await signIn();
    const token = /praman_session=([^;]+)/.exec(cookie)?.[1] as string;

    const out = await app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie } });
    expect(out.statusCode).toBe(200);
    expect(String(out.headers['set-cookie'])).toContain('Max-Age=0');
    expect(await prisma.session.findUnique({ where: { id: hashToken(token) } })).toBeNull();

    // The cookie the browser still holds is now worth nothing.
    const after = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } });
    expect(after.statusCode).toBe(401);
  });
});

describe.skipIf(!reachable)('the one door needs a signed-in reviewer', () => {
  const prisma = new PrismaClient();
  const app = buildServer({ prisma });

  beforeAll(async () => {
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it('refuses an approval with no session, before looking at the dispute at all', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/review/disputes/does-not-exist/approve',
      payload: {},
    });

    // 401 rather than 404: the request is refused on identity, and whether
    // that dispute exists is not something an anonymous caller learns.
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: 'not_signed_in' });
  });

  it('will not take a reviewer name from the request body any more', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/review/disputes/does-not-exist/approve',
      payload: { approvedBy: 'human:someone-else' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('has no demo sign-in route unless the instance is a demo', async () => {
    // DEMO_MODE is unset in tests, so the route must not exist at all.
    const response = await app.inject({ method: 'POST', url: '/auth/demo-login' });
    expect(response.statusCode).toBe(404);
  });
});
