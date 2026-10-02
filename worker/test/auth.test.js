import assert from 'node:assert/strict';
import { test, before } from 'node:test';
import { getWorker, newDb, setupJwks, makeJwt, req, createEnv } from './harness.js';

let worker;

before(async () => {
  await setupJwks();
  worker = await getWorker();
});

function freshEnv(role = 'admin') {
  return createEnv(newDb());
}

// M3-03: auth integrity — reject tokens that are not Google sign-in.
// Real Firebase tokens always carry sign_in_provider === 'google.com'; a
// `password`-provider token (or any other provider) must be rejected so that
// a leaked/stale non-Google credential cannot be used against the API.

test('M3-03-01: token with sign_in_provider === google.com is accepted', async () => {
  const env = freshEnv();
  const token = await makeJwt('alice', 'alice@example.com', 'user', 'Alice', 'google.com');
  const res = await worker.fetch(req('/api/me', { method: 'GET', token }), env, {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.user.email, 'alice@example.com');
});

test('M3-03-02: token with sign_in_provider === password is rejected', async () => {
  const env = freshEnv();
  const token = await makeJwt('alice', 'alice@example.com', 'user', 'Alice', 'password');
  const res = await worker.fetch(req('/api/me', { method: 'GET', token }), env, {});
  assert.equal(res.status, 401);
});

test('M3-03-03: token without sign_in_provider is rejected', async () => {
  const env = freshEnv();
  // Pass null to force the claim to be absent, simulating a legacy token
  // that predates the field.
  const token = await makeJwt('alice', 'alice@example.com', 'user', 'Alice', null);
  const res = await worker.fetch(req('/api/me', { method: 'GET', token }), env, {});
  assert.equal(res.status, 401);
});
