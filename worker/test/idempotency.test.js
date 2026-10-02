// M4-04: vote idempotency via Idempotency-Key.
// Run with: node --test test/idempotency.test.js
//
// Verifies that a retried POST /vote carrying the same client-generated
// Idempotency-Key replays the original result instead of double-counting or
// erroring, that distinct keys still each count, and that the idempotency table
// is populated for replay.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { getWorker, newDb, setupJwks, makeJwt, req, createEnv } from './harness.js';

let worker;

before(async () => {
  await setupJwks();
  worker = await getWorker();
});

// Each test gets its own in-memory DB so option IDs don't collide.
function freshEnv() {
  return createEnv(newDb());
}

async function createPoll(env, superToken, overrides = {}) {
  const body = {
    title: 'Test Poll',
    description: 'A test poll',
    anonymity: 'anonymous',
    voteMode: 'multiple',
    maxVotes: 2,
    options: [
      { id: 'a', code: 'A', label: 'Option A' },
      { id: 'b', code: 'B', label: 'Option B' }
    ],
    status: 'open',
    eligibilityMode: 'public',
    resultsVisibility: 'public',
    ...overrides
  };
  const res = await worker.fetch(req('/api/polls', {
    method: 'POST',
    token: superToken,
    body
  }), env, {});
  const data = await res.json();
  return data.id;
}

function rawIdempotency(env, pollId) {
  return env.DB.prepare('SELECT poll_id, uid, key, result_json FROM idempotency_keys WHERE poll_id=?').bind(pollId).all().results || [];
}

// M4-04-01: a retried POST with the same Idempotency-Key replays the original
// result (same ok/voteCount) without the second POST being a new counted vote.
test('M4-04-01: retried vote with same Idempotency-Key replays original result', async () => {
  const env = freshEnv();
  const superToken = await makeJwt('super', 'jamespolik@gmail.com', 'admin');
  const pollId = await createPoll(env, superToken);
  const idemKey = crypto.randomUUID();

  const first = await worker.fetch(req(`/api/polls/${pollId}/vote`, {
    method: 'POST',
    token: await makeJwt('v1', 'v1@example.com', 'user'),
    body: { choices: [{ optionId: 'a', votes: 1 }, { optionId: 'b', votes: 1 }] },
    headers: { 'Idempotency-Key': idemKey }
  }), env, {});
  const firstData = await first.json();
  assert.equal(first.status, 200);
  assert.equal(firstData.changed, false);
  assert.equal(firstData.voteCount, 2);

  // Retry with the SAME key: replays the cached result verbatim.
  const retry = await worker.fetch(req(`/api/polls/${pollId}/vote`, {
    method: 'POST',
    token: await makeJwt('v1', 'v1@example.com', 'user'),
    body: { choices: [{ optionId: 'a', votes: 1 }, { optionId: 'b', votes: 1 }] },
    headers: { 'Idempotency-Key': idemKey }
  }), env, {});
  const retryData = await retry.json();
  assert.equal(retry.status, 200);
  assert.equal(retryData.changed, false);
  assert.equal(retryData.voteCount, 2);
  assert.equal(retryData.ok, true);

  // The participation row must still reflect exactly one counted ballot.
  const part = env.DB.prepare('SELECT vote_count FROM participation WHERE poll_id=? AND uid=?').bind(pollId, 'v1').first();
  assert.equal(part.vote_count, 2);
  // Exactly one idempotency row recorded.
  assert.equal(rawIdempotency(env, pollId).length, 1);
});

// M4-04-02: a lost-response retry (network blip) with the same key returns the
// original result even though the second POST never reached the vote logic.
test('M4-04-02: lost-response retry replays cached result', async () => {
  const env = freshEnv();
  const superToken = await makeJwt('super', 'jamespolik@gmail.com', 'admin');
  const pollId = await createPoll(env, superToken);
  const idemKey = crypto.randomUUID();

  // First attempt: valid vote, record the result, but pretend the response was
  // lost (we ignore it), then retry with the same key.
  await worker.fetch(req(`/api/polls/${pollId}/vote`, {
    method: 'POST',
    token: await makeJwt('v1', 'v1@example.com', 'user'),
    body: { choices: [{ optionId: 'a', votes: 1 }] },
    headers: { 'Idempotency-Key': idemKey }
  }), env, {});

  const retry = await worker.fetch(req(`/api/polls/${pollId}/vote`, {
    method: 'POST',
    token: await makeJwt('v1', 'v1@example.com', 'user'),
    body: { choices: [{ optionId: 'a', votes: 1 }] },
    headers: { 'Idempotency-Key': idemKey }
  }), env, {});
  const retryData = await retry.json();
  assert.equal(retry.status, 200);
  assert.equal(retryData.changed, false);
  assert.equal(retryData.voteCount, 1);

  // Only one participant in the tally (no double-count).
  const rows = env.DB.prepare('SELECT COUNT(*) AS n FROM participation WHERE poll_id=?').bind(pollId).first();
  assert.equal(rows.n, 1);
});

// M4-04-03: distinct idempotency keys each count as independent votes (no
// false deduplication).
test('M4-04-03: distinct Idempotency-Keys count independently', async () => {
  const env = freshEnv();
  const superToken = await makeJwt('super', 'jamespolik@gmail.com', 'admin');
  const pollId = await createPoll(env, superToken);

  await worker.fetch(req(`/api/polls/${pollId}/vote`, {
    method: 'POST',
    token: await makeJwt('v1', 'v1@example.com', 'user'),
    body: { choices: [{ optionId: 'a', votes: 1 }] },
    headers: { 'Idempotency-Key': crypto.randomUUID() }
  }), env, {});
  await worker.fetch(req(`/api/polls/${pollId}/vote`, {
    method: 'POST',
    token: await makeJwt('v2', 'v2@example.com', 'user'),
    body: { choices: [{ optionId: 'a', votes: 1 }] },
    headers: { 'Idempotency-Key': crypto.randomUUID() }
  }), env, {});

  const rows = env.DB.prepare('SELECT COUNT(*) AS n FROM participation WHERE poll_id=?').bind(pollId).first();
  assert.equal(rows.n, 2);
  assert.equal(rawIdempotency(env, pollId).length, 2);
});

// M4-04-04: a vote WITHOUT an idempotency key behaves exactly as before (no
// idempotency row written), preserving the non-keyed path.
test('M4-04-04: vote without Idempotency-Key writes no idempotency row', async () => {
  const env = freshEnv();
  const superToken = await makeJwt('super', 'jamespolik@gmail.com', 'admin');
  const pollId = await createPoll(env, superToken);

  const res = await worker.fetch(req(`/api/polls/${pollId}/vote`, {
    method: 'POST',
    token: await makeJwt('v1', 'v1@example.com', 'user'),
    body: { choices: [{ optionId: 'a', votes: 1 }] }
  }), env, {});
  assert.equal(res.status, 200);
  assert.equal(rawIdempotency(env, pollId).length, 0);
});
