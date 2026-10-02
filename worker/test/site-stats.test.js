import assert from 'node:assert/strict';
import { test, before } from 'node:test';
import { getWorker, newDb, setupJwks, req, createEnv } from './harness.js';

let worker;

before(async () => {
  await setupJwks();
  worker = await getWorker();
});

const BASE = { page: '/poll/1', visitorId: 'v-1', duration: 12, device: 'desktop', referrer: 'https://g.co', ip: '1.2.3.4' };

async function post(env, body) {
  const res = await worker.fetch(req('/api/site-stats', { method: 'POST', body }), env, {});
  const data = await res.json().catch(() => null);
  return { status: res.status, headers: res.headers, data };
}

test('M4-02-01: valid heartbeat returns 201', async () => {
  const env = createEnv(newDb());
  const r = await post(env, BASE);
  assert.equal(r.status, 201);
  assert.equal(r.data.ok, true);
});

test('M4-02-02: missing visitorId returns 400', async () => {
  const env = createEnv(newDb());
  const r = await post(env, { ...BASE, visitorId: '' });
  assert.equal(r.status, 400);
  assert.equal(r.data.error, 'visitor_id_required');
});

test('M4-02-03: rejects non-numeric/ negative duration', async () => {
  const env = createEnv(newDb());
  const a = await post(env, { ...BASE, duration: -5 });
  assert.equal(a.status, 201, 'negative duration is dropped (null)');
  const b = await post(env, { ...BASE, duration: 'abc' });
  assert.equal(b.status, 201, 'non-numeric duration is dropped (null)');
});

test('M4-02-04: unauthenticated callers are accepted (public endpoint)', async () => {
  const env = createEnv(newDb());
  const r = await post(env, BASE);
  assert.equal(r.status, 201);
});

test('M4-02-05: per-IP rate limiting kicks in', async () => {
  const env = createEnv(newDb());
  env.RATE_LIMIT_SITE_RPM = 2;
  const r1 = await post(env, BASE);
  const r2 = await post(env, BASE);
  const r3 = await post(env, BASE);
  assert.equal(r1.status, 201);
  assert.equal(r2.status, 201);
  assert.equal(r3.status, 429);
  assert.equal(r3.data.error, 'rate_limited');
  assert.equal(r3.headers.get('retry-after'), '60');
});
