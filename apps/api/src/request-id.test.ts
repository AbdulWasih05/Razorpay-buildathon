import { afterAll, describe, expect, it } from 'vitest';

import { buildServer } from './server.js';

/**
 * Request ids: one per request, on the response and on every log line for it.
 *
 * `/health` touches no database, so these run without one.
 */

const app = buildServer();

afterAll(async () => {
  await app.close();
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('every response carries a request id', () => {
  it('mints a UUID when the caller sends none', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['x-request-id']).toMatch(UUID);
  });

  it('mints a different id for each request', async () => {
    const first = await app.inject({ method: 'GET', url: '/health' });
    const second = await app.inject({ method: 'GET', url: '/health' });
    expect(first.headers['x-request-id']).not.toBe(second.headers['x-request-id']);
  });

  it("keeps the caller's id, so one id can follow a request across systems", async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': 'upstream-trace-42' },
    });
    expect(response.headers['x-request-id']).toBe('upstream-trace-42');
  });
});
