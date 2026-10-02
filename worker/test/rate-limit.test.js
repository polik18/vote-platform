// M3-04: fixed-window rate limiting.
// Run with: node --test test/rate-limit.test.js
//
// NOTE: the participation UNIQUE constraint (M3-04, plan item 1) is enforced
// by a separate DB constraint and is covered elsewhere. These tests cover the
// fixed-window limiter only: it must not block a single voter from voting
// twice when maxVotes allows it, and it must return 429 + Retry-After once a
// key exceeds its configured budget.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { getWorker, newDb, setupJwks, makeJwt, req, createEnv } from './harness.js';

let worker;

before(async () => {
  await setupJwks();
  worker = await getWorker();
});

function envWith(overrides) {
  return { ...createEnv(newDb()), ...overrides };
}

async function openPoll(env, token, overrides = {}) {
  const res = await worker.fetch(req('/api/polls', {
    method: 'POST',
    token,
    body: {
      title: 'Rate Test',
      description: 'r',
      anonymity: 'named',
      voteMode: 'multiple',
      maxVotes: 2,
      allowChange: true,
      options: [
        { id: 'a', code: 'A', label: 'A' },
        { id: 'b', code: 'B', label: 'B' }
      ],
      status: 'open',
      eligibilityMode: 'public',
      resultsVisibility: 'public',
      ...overrides
    }
  }), env, {});
  const data = await res.json();
  return data.id;
}

test('M3-04-01: first N requests pass, the N+1th is 429 with Retry-After', async () => {
  const env = envWith({ RATE_LIMIT_RPM: 2 });
  const token = await makeJwt('r1', 'r1@example.com', 'user');

  const r1 = await worker.fetch(req('/api/me', { token }), env, {});
  const r2 = await worker.fetch(req('/api/me', { token }), env, {});
  const r3 = await worker.fetch(req('/api/me', { token }), env, {});

  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  assert.equal(r3.status, 429);
  assert.equal(r3.headers.get('retry-after'), '60');
  const body = await r3.json();
  assert.equal(body.error, 'rate_limited');
});

test('M3-04-02: vote budget is per-poll per-voter and independent of general budget', async () => {
  const env = envWith({ RATE_LIMIT_RPM: 100, RATE_LIMIT_VOTE_RPM: 1 });
  const admin = await makeJwt('super', 'jamespolik@gmail.com', 'admin');
  const pollId = await openPoll(env, admin);

  const voter = await makeJwt('voter', 'voter@example.com', 'user');
  const v1 = await worker.fetch(req(`/api/polls/${pollId}/vote`, {
    method: 'POST',
    token: voter,
    body: { choices: [{ optionId: 'a', votes: 1 }] }
  }), env, {});
  const v2 = await worker.fetch(req(`/api/polls/${pollId}/vote`, {
    method: 'POST',
    token: voter,
    body: { choices: [{ optionId: 'a', votes: 1 }] }
  }), env, {});

  assert.equal(v1.status, 200);
  assert.equal(v2.status, 429);
});

test('M3-04-03: a single voter may vote twice when maxVotes allows it', async () => {
  // maxVotes=2, vote budget high enough to never trip the limiter.
  const env = envWith({ RATE_LIMIT_RPM: 100, RATE_LIMIT_VOTE_RPM: 100 });
  const admin = await makeJwt('super', 'jamespolik@gmail.com', 'admin');
  const pollId = await openPoll(env, admin);

  const voter = await makeJwt('voter', 'voter@example.com', 'user');
  const v1 = await worker.fetch(req(`/api/polls/${pollId}/vote`, {
    method: 'POST',
    token: voter,
    body: { choices: [{ optionId: 'a', votes: 1 }] }
  }), env, {});
  const v2 = await worker.fetch(req(`/api/polls/${pollId}/vote`, {
    method: 'POST',
    token: voter,
    body: { choices: [{ optionId: 'b', votes: 1 }] }
  }), env, {});

  assert.equal(v1.status, 200);
  assert.equal(v2.status, 200);
});

test('M3-04-04: invalid-token volume is throttled per IP before auth', async () => {
  const env = envWith({ RATE_LIMIT_AUTH_RPM: 1 });
  // null sign_in_provider drops the claim, so authenticate() returns null → 401.
  const bad = await makeJwt('bad', 'bad@example.com', 'user', 'Bad', null);

  const r1 = await worker.fetch(req('/api/me', { token: bad }), env, {});
  const r2 = await worker.fetch(req('/api/me', { token: bad }), env, {});

  assert.equal(r1.status, 401);
  assert.equal(r2.status, 429);
  assert.equal(r2.headers.get('retry-after'), '60');
});
