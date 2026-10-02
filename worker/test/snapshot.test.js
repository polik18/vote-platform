// M4-02: enriched closed-result snapshots with content_hash verification.
// Run with: node --test test/snapshot.test.js
//
// Verifies that closing a poll writes an enriched poll_result_snapshot
// (participant_count, total_votes, result_json, rules_json, content_hash),
// that the stored hash matches recomputation from the snapshot fields, and
// that getResults after close reads the snapshot and detects tampering.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { getWorker, newDb, setupJwks, makeJwt, req, createEnv } from './harness.js';

let worker;

before(async () => {
  await setupJwks();
  worker = await getWorker();
});

function freshEnv() {
  return createEnv(newDb());
}

async function createOpenPoll(env, superToken) {
  const body = {
    title: 'Snapshot Poll',
    description: 'A test poll for snapshot verification',
    anonymity: 'anonymous',
    voteMode: 'multiple',
    maxVotes: 2,
    options: [
      { id: 'a', code: 'A', label: 'Option A' },
      { id: 'b', code: 'B', label: 'Option B' }
    ],
    status: 'open',
    eligibilityMode: 'public',
    resultsVisibility: 'public'
  };
  const res = await worker.fetch(req('/api/polls', { method: 'POST', token: superToken, body }), env, {});
  return (await res.json()).id;
}

async function castVote(env, pollId, token, choices) {
  await worker.fetch(req(`/api/polls/${pollId}/vote`, { method: 'POST', token, body: { choices } }), env, {});
}

async function closePoll(env, pollId, token) {
  const res = await worker.fetch(req(`/api/polls/${pollId}`, { method: 'PATCH', token, body: { status: 'closed' } }), env, {});
  assert.equal(res.status, 200);
}

async function getSnapshotRow(env, pollId) {
  return env.DB.prepare('SELECT * FROM poll_result_snapshots WHERE poll_id=?').bind(pollId).first();
}

// Recompute the hash from the snapshot's own fields, matching the Worker's
// implementation exactly.
async function recomputeHash(snapshot) {
  const canonical = JSON.stringify({
    poll_id: snapshot.poll_id,
    participant_count: snapshot.participant_count,
    total_votes: snapshot.total_votes,
    result_json: snapshot.result_json,
    rules_json: snapshot.rules_json
  });
  const data = new TextEncoder().encode(canonical);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

test('M4-02-01: closing a poll writes an enriched snapshot with counts and blobs', async () => {
  const env = freshEnv();
  const superToken = await makeJwt('super', 'jamespolik@gmail.com', 'admin');
  const pollId = await createOpenPoll(env, superToken);
  await castVote(env, pollId, await makeJwt('v1', 'v1@example.com', 'user'), [{ optionId: 'a', votes: 1 }]);
  await castVote(env, pollId, await makeJwt('v2', 'v2@example.com', 'user'), [{ optionId: 'a', votes: 1 }, { optionId: 'b', votes: 1 }]);
  await closePoll(env, pollId, superToken);

  const row = await getSnapshotRow(env, pollId);
  assert.ok(row, 'snapshot row must exist after close');
  assert.equal(row.participant_count, 2);
  assert.equal(row.total_votes, 3);
  assert.ok(row.result_json, 'result_json must be populated');
  assert.ok(row.rules_json, 'rules_json must be populated');
  assert.ok(row.content_hash, 'content_hash must be set');
});

test('M4-02-02: stored content_hash matches recomputation from snapshot fields', async () => {
  const env = freshEnv();
  const superToken = await makeJwt('super', 'jamespolik@gmail.com', 'admin');
  const pollId = await createOpenPoll(env, superToken);
  await castVote(env, pollId, await makeJwt('v1', 'v1@example.com', 'user'), [{ optionId: 'a', votes: 1 }]);
  await castVote(env, pollId, await makeJwt('v2', 'v2@example.com', 'user'), [{ optionId: 'b', votes: 1 }]);
  await closePoll(env, pollId, superToken);

  const row = await getSnapshotRow(env, pollId);
  const expected = await recomputeHash(row);
  assert.equal(row.content_hash, expected, 'stored hash must equal recomputed hash');
});

test('M4-02-03: results after close read the snapshot and verify the hash', async () => {
  const env = freshEnv();
  const superToken = await makeJwt('super', 'jamespolik@gmail.com', 'admin');
  const pollId = await createOpenPoll(env, superToken);
  await castVote(env, pollId, await makeJwt('v1', 'v1@example.com', 'user'), [{ optionId: 'a', votes: 1 }]);
  await castVote(env, pollId, await makeJwt('v2', 'v2@example.com', 'user'), [{ optionId: 'a', votes: 1 }, { optionId: 'b', votes: 1 }]);
  await closePoll(env, pollId, superToken);

  const pub = await makeJwt('pub', 'pub@example.com', 'user');
  const res = await worker.fetch(req(`/api/polls/${pollId}/results`, { token: pub }), env, {});
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.totalParticipants, 2);
  const a = data.results.find(r => r.code === 'A');
  const b = data.results.find(r => r.code === 'B');
  assert.equal(a.votes, 2);
  assert.equal(b.votes, 1);
});

test('M4-02-04: tampering with the snapshot is detected (hash mismatch)', async () => {
  const env = freshEnv();
  const superToken = await makeJwt('super', 'jamespolik@gmail.com', 'admin');
  const pollId = await createOpenPoll(env, superToken);
  await castVote(env, pollId, await makeJwt('v1', 'v1@example.com', 'user'), [{ optionId: 'a', votes: 1 }]);
  await castVote(env, pollId, await makeJwt('v2', 'v2@example.com', 'user'), [{ optionId: 'a', votes: 1 }]);
  await closePoll(env, pollId, superToken);

  // Tamper: bump participant_count without updating the hash.
  env.DB.prepare('UPDATE poll_result_snapshots SET participant_count = 99 WHERE poll_id=?').bind(pollId).run();

  const pub = await makeJwt('pub', 'pub@example.com', 'user');
  const res = await worker.fetch(req(`/api/polls/${pollId}/results`, { token: pub }), env, {});
  const data = await res.json();
  assert.equal(res.status, 409, 'tampered snapshot must be rejected');
  assert.equal(data.error, 'snapshot_hash_mismatch');
});

test('M4-02-05: closed poll export uses the snapshot result_json', async () => {
  const env = freshEnv();
  const superToken = await makeJwt('super', 'jamespolik@gmail.com', 'admin');
  const pollId = await createOpenPoll(env, superToken);
  await castVote(env, pollId, await makeJwt('v1', 'v1@example.com', 'user'), [{ optionId: 'a', votes: 1 }]);
  await castVote(env, pollId, await makeJwt('v2', 'v2@example.com', 'user'), [{ optionId: 'b', votes: 1 }]);
  await closePoll(env, pollId, superToken);

  const pub = await makeJwt('pub', 'pub@example.com', 'user');
  const res = await worker.fetch(req(`/api/polls/${pollId}/export?type=results`, { token: superToken }), env, {});
  const csv = await res.text();
  assert.equal(res.status, 200);
  assert.match(csv, /rank,code,option,votes,percentage,approved/);
  assert.match(csv, /A,Option A,1/);
  assert.match(csv, /B,Option B,1/);
});
