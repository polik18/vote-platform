// M2-01: State machine + voting flow tests.
// Run with: node --test test/state-machine.test.js
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { getWorker, newDb, setupJwks, makeJwt, req, createEnv } from './harness.js';

let worker;

before(async () => {
  await setupJwks();
  worker = await getWorker();
});

// Each test gets its own in-memory DB so option IDs (a/b) don't collide
// across tests via the shared UNIQUE(options.id) constraint.
function freshEnv(role = 'admin') {
  return createEnv(newDb());
}

async function createOpenPoll(env, superToken, overrides = {}) {
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

test('M2-01: open poll aggregates votes from multiple voters', async () => {
  const env = freshEnv();
  const superToken = await makeJwt('super', 'jamespolik@gmail.com', 'admin');
  const pollId = await createOpenPoll(env, superToken);

  const voter1 = await makeJwt('voter1', 'voter1@example.com', 'user');
  await worker.fetch(req(`/api/polls/${pollId}/vote`, {
    method: 'POST',
    token: voter1,
    body: { choices: [{ optionId: 'a', votes: 1 }, { optionId: 'b', votes: 1 }] }
  }), env, {});

  const voter2 = await makeJwt('voter2', 'voter2@example.com', 'user');
  await worker.fetch(req(`/api/polls/${pollId}/vote`, {
    method: 'POST',
    token: voter2,
    body: { choices: [{ optionId: 'a', votes: 1 }] }
  }), env, {});

  const pub = await makeJwt('pub', 'pub@example.com', 'user');
  const results = await worker.fetch(req(`/api/polls/${pollId}/results`, {
    token: pub
  }), env, {});
  const data = await results.json();

  assert.equal(data.totalParticipants, 2);
  const optionA = data.results.find(r => r.code === 'A');
  const optionB = data.results.find(r => r.code === 'B');
  assert.equal(optionA.votes, 2); // 1 + 1
  assert.equal(optionB.votes, 1); // 1
});

test('M2-02: open -> draft is rejected (invalid transition)', async () => {
  const env = freshEnv();
  const superToken = await makeJwt('super', 'jamespolik@gmail.com', 'admin');
  const pollId = await createOpenPoll(env, superToken);

  const res = await worker.fetch(req(`/api/polls/${pollId}`, {
    method: 'PATCH',
    token: superToken,
    body: { status: 'draft' }
  }), env, {});

  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, 'invalid_transition');
});

test('M2-03: open -> closed is allowed and records a transition', async () => {
  const env = freshEnv();
  const superToken = await makeJwt('super', 'jamespolik@gmail.com', 'admin');
  const pollId = await createOpenPoll(env, superToken);

  const res = await worker.fetch(req(`/api/polls/${pollId}`, {
    method: 'PATCH',
    token: superToken,
    body: { status: 'closed' }
  }), env, {});

  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);

  const rows = await env.DB.prepare('SELECT COUNT(*) c FROM poll_state_transitions WHERE poll_id=?').bind(pollId).first();
  assert.ok(rows.c > 0);
});

test('M2-04: closed -> open is rejected (invalid transition)', async () => {
  const env = freshEnv();
  const superToken = await makeJwt('super', 'jamespolik@gmail.com', 'admin');
  const pollId = await createOpenPoll(env, superToken);
  await worker.fetch(req(`/api/polls/${pollId}`, {
    method: 'PATCH',
    token: superToken,
    body: { status: 'closed' }
  }), env, {});

  const res = await worker.fetch(req(`/api/polls/${pollId}`, {
    method: 'PATCH',
    token: superToken,
    body: { status: 'open' }
  }), env, {});

  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, 'closed_poll_cannot_reopen');
});

test('M2-05: first vote freezes poll options (options_frozen_at set)', async () => {
  const env = freshEnv();
  const superToken = await makeJwt('super', 'jamespolik@gmail.com', 'admin');
  const pollId = await createOpenPoll(env, superToken);

  const voter1 = await makeJwt('voter1', 'voter1@example.com', 'user');
  await worker.fetch(req(`/api/polls/${pollId}/vote`, {
    method: 'POST',
    token: voter1,
    body: { choices: [{ optionId: 'a', votes: 1 }] }
  }), env, {});

  const row = await env.DB.prepare('SELECT options_frozen_at FROM polls WHERE id=?').bind(pollId).first();
  assert.ok(row.options_frozen_at, 'options_frozen_at should be set after first vote');
});
