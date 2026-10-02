// M4-01: normalized ballot_choices SQL aggregation.
// Run with: node --test test/ballot-choices.test.js
//
// Verifies that getResults aggregates from the normalized ballot_choices table
// (SQL-side) rather than shipping every ballot to the Worker, that re-voting
// leaves no stale tallies, and that ballot_choices stays in lockstep with
// choice_json.
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

async function getResults(env, pollId, token) {
  const res = await worker.fetch(req(`/api/polls/${pollId}/results`, { token }), env, {});
  return { status: res.status, body: await res.json() };
}

// Inspect the normalized ballot_choices table directly.
function rawBallotChoices(env, pollId) {
  return env.DB.prepare('SELECT option_id, SUM(votes) AS votes FROM ballot_choices WHERE poll_id=? GROUP BY option_id').bind(pollId).all().results || [];
}

test('M4-01-01: results aggregate from ballot_choices (SQL-side), not every ballot', async () => {
  const env = freshEnv();
  const superToken = await makeJwt('super', 'jamespolik@gmail.com', 'admin');
  const pollId = await createPoll(env, superToken);

  await worker.fetch(req(`/api/polls/${pollId}/vote`, {
    method: 'POST',
    token: await makeJwt('v1', 'v1@example.com', 'user'),
    body: { choices: [{ optionId: 'a', votes: 1 }, { optionId: 'b', votes: 1 }] }
  }), env, {});
  await worker.fetch(req(`/api/polls/${pollId}/vote`, {
    method: 'POST',
    token: await makeJwt('v2', 'v2@example.com', 'user'),
    body: { choices: [{ optionId: 'a', votes: 1 }] }
  }), env, {});

  const { status, body } = await getResults(env, pollId, await makeJwt('pub', 'pub@example.com', 'user'));
  assert.equal(status, 200);
  assert.equal(body.totalParticipants, 2);
  assert.equal(body.totalVotes, 3);
  const a = body.results.find(r => r.code === 'A');
  const b = body.results.find(r => r.code === 'B');
  assert.equal(a.votes, 2); // 1 + 1
  assert.equal(b.votes, 1); // 1

  // ballot_choices holds one row per (ballot, option), aggregated by SQL.
  const rows = rawBallotChoices(env, pollId);
  const aRow = rows.find(r => r.option_id === 'a');
  const bRow = rows.find(r => r.option_id === 'b');
  assert.equal(aRow.votes, 2);
  assert.equal(bRow.votes, 1);
});

test('M4-01-02: re-voting replaces old tallies atomically (no stale rows)', async () => {
  const env = freshEnv();
  const superToken = await makeJwt('super', 'jamespolik@gmail.com', 'admin');
  const pollId = await createPoll(env, superToken);

  // First ballot: a=1, b=1.
  await worker.fetch(req(`/api/polls/${pollId}/vote`, {
    method: 'POST',
    token: await makeJwt('v1', 'v1@example.com', 'user'),
    body: { choices: [{ optionId: 'a', votes: 1 }, { optionId: 'b', votes: 1 }] }
  }), env, {});

  // allow_change lets the same voter submit again; the new choice_json must
  // fully replace the old tallies, not accumulate. (Distinct option ids so the
  // second poll's options don't collide with the first poll's UNIQUE options.id.)
  const samePoll = await createPoll(env, superToken, {
    allowChange: true,
    options: [
      { id: 'c', code: 'C', label: 'Option C' },
      { id: 'd', code: 'D', label: 'Option D' }
    ]
  });
  await worker.fetch(req(`/api/polls/${samePoll}/vote`, {
    method: 'POST',
    token: await makeJwt('v1', 'v1@example.com', 'user'),
    body: { choices: [{ optionId: 'c', votes: 1 }] }
  }), env, {});
  await worker.fetch(req(`/api/polls/${samePoll}/vote`, {
    method: 'POST',
    token: await makeJwt('v2', 'v2@example.com', 'user'),
    body: { choices: [{ optionId: 'c', votes: 1 }, { optionId: 'd', votes: 1 }] }
  }), env, {});

  const { body } = await getResults(env, samePoll, await makeJwt('pub', 'pub@example.com', 'user'));
  const a = body.results.find(r => r.code === 'C');
  const b = body.results.find(r => r.code === 'D');
  // v1 re-voted to only c=1; v2 voted c=1, d=1. So c=2, d=1 (not c=2, d=2).
  assert.equal(a.votes, 2);
  assert.equal(b.votes, 1);
});

test('M4-01-03: ballot_choices stays consistent with choice_json', async () => {
  const env = freshEnv();
  const superToken = await makeJwt('super', 'jamespolik@gmail.com', 'admin');
  const pollId = await createPoll(env, superToken);

  await worker.fetch(req(`/api/polls/${pollId}/vote`, {
    method: 'POST',
    token: await makeJwt('v1', 'v1@example.com', 'user'),
    body: { choices: [{ optionId: 'a', votes: 1 }, { optionId: 'b', votes: 1 }] }
  }), env, {});

  // choice_json is the authoritative record; ballot_choices must match it.
  const ballot = env.DB.prepare('SELECT choice_json FROM ballots WHERE poll_id=?').bind(pollId).all().results[0];
  const parsed = JSON.parse(ballot.choice_json);
  const expected = {};
  for (const c of parsed) expected[c.optionId] = (expected[c.optionId] || 0) + c.votes;

  for (const row of rawBallotChoices(env, pollId)) {
    assert.equal(row.votes, expected[row.option_id], `ballot_choices[${row.option_id}] must equal choice_json tally`);
  }
  assert.equal(Object.keys(expected).length, rawBallotChoices(env, pollId).length);
});

test('M4-01-04: empty poll returns zeros, no crash', async () => {
  const env = freshEnv();
  const superToken = await makeJwt('super', 'jamespolik@gmail.com', 'admin');
  const pollId = await createPoll(env, superToken);

  const { status, body } = await getResults(env, pollId, await makeJwt('pub', 'pub@example.com', 'user'));
  assert.equal(status, 200);
  assert.equal(body.totalParticipants, 0);
  assert.equal(body.totalVotes, 0);
  assert.equal(body.results.length, 2);
  assert.equal(body.results[0].votes, 0);
  assert.equal(body.results[1].votes, 0);
});

test('M4-01-05: allocate mode aggregates by total votes across ballots', async () => {
  const env = freshEnv();
  const superToken = await makeJwt('super', 'jamespolik@gmail.com', 'admin');
  const pollId = await createPoll(env, superToken, { voteMode: 'allocate', maxVotes: 3 });

  await worker.fetch(req(`/api/polls/${pollId}/vote`, {
    method: 'POST',
    token: await makeJwt('v1', 'v1@example.com', 'user'),
    body: { choices: [{ optionId: 'a', votes: 2 }, { optionId: 'b', votes: 1 }] }
  }), env, {});
  await worker.fetch(req(`/api/polls/${pollId}/vote`, {
    method: 'POST',
    token: await makeJwt('v2', 'v2@example.com', 'user'),
    body: { choices: [{ optionId: 'a', votes: 1 }, { optionId: 'b', votes: 2 }] }
  }), env, {});

  const { body } = await getResults(env, pollId, await makeJwt('pub', 'pub@example.com', 'user'));
  const a = body.results.find(r => r.code === 'A');
  const b = body.results.find(r => r.code === 'B');
  assert.equal(a.votes, 3); // 2 + 1
  assert.equal(b.votes, 3); // 1 + 2
  assert.equal(body.totalVotes, 6);
});
