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

async function postPoll(env, token, body) {
  const res = await worker.fetch(req('/api/polls', { method: 'POST', token, body }), env, {});
  return { status: res.status, body: await res.json().catch(() => null) };
}

const BASE = {
  title: 'T',
  description: 'd',
  anonymity: 'anonymous',
  voteMode: 'multiple',
  maxVotes: 2,
  eligibilityMode: 'public',
  resultsVisibility: 'public',
  options: [
    { id: 'a', code: 'A', label: 'Option A' },
    { id: 'b', code: 'B', label: 'Option B' }
  ]
};

// ---- M3-05: CSV safety ----

test('M3-C-01: cells starting with = are prefixed to prevent formula injection', async () => {
  const env = freshEnv();
  const token = await makeJwt('super', 'jamespolik@gmail.com', 'admin');
  const r = await postPoll(env, token, {
    ...BASE,
    anonymity: 'named',
    options: [
      { id: 'a', code: 'A', label: '=1+1' },
      { id: 'b', code: 'B', label: 'Option B' }
    ]
  });
  assert.equal(r.status, 201);
  const pollId = r.body.id;

  const res = await worker.fetch(req(`/api/polls/${pollId}/export?type=results`, { method: 'GET', token }), env, {});
  assert.equal(res.status, 200);
  const csv = await res.text();
  // Excel/Google Sheets would execute '=1+1' as a formula; the safe prefix
  // (a leading apostrophe) forces the cell to be treated as text.
  assert.match(csv, /'=1\+1/);
  assert.ok(!/^\s*=1\+1\b/.test(csv), 'raw formula must not appear at line start');
});

test('M3-C-02: cells starting with + or - are prefixed', async () => {
  const env = freshEnv();
  const token = await makeJwt('super', 'jamespolik@gmail.com', 'admin');
  const r = await postPoll(env, token, {
    ...BASE,
    anonymity: 'named',
    options: [
      { id: 'a', code: 'A', label: '+100' },
      { id: 'b', code: 'B', label: '-50' }
    ]
  });
  assert.equal(r.status, 201);
  const pollId = r.body.id;

  const res = await worker.fetch(req(`/api/polls/${pollId}/export?type=results`, { method: 'GET', token }), env, {});
  assert.equal(res.status, 200);
  const csv = await res.text();
  assert.match(csv, /'\+100/);
  assert.match(csv, /'-50/);
});

test('M3-C-03: cells starting with @ are prefixed', async () => {
  const env = freshEnv();
  const token = await makeJwt('super', 'jamespolik@gmail.com', 'admin');
  const r = await postPoll(env, token, {
    ...BASE,
    anonymity: 'named',
    options: [
      { id: 'a', code: 'A', label: '@someone' },
      { id: 'b', code: 'B', label: 'Option B' }
    ]
  });
  assert.equal(r.status, 201);
  const pollId = r.body.id;

  const res = await worker.fetch(req(`/api/polls/${pollId}/export?type=results`, { method: 'GET', token }), env, {});
  assert.equal(res.status, 200);
  const csv = await res.text();
  assert.match(csv, /'@someone/);
});

// ---- M3-07: security headers ----

test('M3-C-04: responses include X-Content-Type-Options: nosniff', async () => {
  const env = freshEnv();
  const token = await makeJwt('super', 'jamespolik@gmail.com', 'admin');
  const res = await worker.fetch(req('/api/me', { method: 'GET', token }), env, {});
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
});

test('M3-C-05: 404 responses include X-Content-Type-Options: nosniff', async () => {
  const env = freshEnv();
  const token = await makeJwt('super', 'jamespolik@gmail.com', 'admin');
  const res = await worker.fetch(req('/api/nonexistent', { method: 'GET', token }), env, {});
  assert.equal(res.status, 404);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
});

test('M3-C-06: 500 responses include a request id and no SQL/stack leak', async () => {
  const env = freshEnv();
  const token = await makeJwt('super', 'jamespolik@gmail.com', 'admin');
  // Force an internal error by sending a malformed body that throws in createPoll.
  const res = await worker.fetch(req('/api/polls', {
    method: 'POST',
    token,
    body: { title: 't', description: 'd', anonymity: 'anonymous', voteMode: 'multiple',
      maxVotes: 2, eligibilityMode: 'public', resultsVisibility: 'public',
      options: 'not-an-array' }
  }), env, {});
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.equal(body.error, 'internal_error');
  assert.ok(body.requestId, '500 body must include a request id');
  const raw = JSON.stringify(body);
  assert.ok(!/SQLITE_|near "|syntax error|at Object\.|at async/i.test(raw), 'must not leak SQL/stack');
});

// ---- M3-06: anonymous polls minimize stored identity ----

async function getBallots(env, pollId) {
  return await env.DB.prepare('SELECT voter_uid, voter_email, voter_name, is_named FROM ballots WHERE poll_id=?').bind(pollId).all();
}

async function getParticipation(env, pollId) {
  return await env.DB.prepare('SELECT ballot_id FROM participation WHERE poll_id=?').bind(pollId).all();
}

test('M3-C-07: anonymous poll stores no uid->ballot link (participation.ballot_id null, ballots uid/email/name null)', async () => {
  const env = freshEnv();
  const adminToken = await makeJwt('super', 'jamespolik@gmail.com', 'admin');
  const r = await postPoll(env, adminToken, {
    ...BASE,
    anonymity: 'anonymous',
    status: 'open'
  });
  assert.equal(r.status, 201);
  const pollId = r.body.id;

  // Cast a vote as a regular user.
  const voterToken = await makeJwt('alice', 'alice@example.com', 'user');
  const voteRes = await worker.fetch(req(`/api/polls/${pollId}/vote`, {
    method: 'POST', token: voterToken,
    body: { choices: [{ optionId: 'a', votes: 1 }, { optionId: 'b', votes: 1 }] }
  }), env, {});
  assert.equal(voteRes.status, 200);

  const ballots = await getBallots(env, pollId);
  assert.ok(ballots.results.length >= 1);
  const b = ballots.results[0];
  assert.equal(b.voter_uid, null, 'anonymous ballots must not store voter_uid');
  assert.equal(b.voter_email, null, 'anonymous ballots must not store voter_email');
  assert.equal(b.voter_name, null, 'anonymous ballots must not store voter_name');
  assert.equal(b.is_named, 0, 'anonymous ballots marked is_named=false');

  const parts = await getParticipation(env, pollId);
  assert.ok(parts.results.length >= 1);
  assert.equal(parts.results[0].ballot_id, null, 'anonymous participation must not expose ballot_id (no uid->ballot link)');
});

test('M3-C-08: named poll still stores uid->ballot link', async () => {
  const env = freshEnv();
  const adminToken = await makeJwt('super', 'jamespolik@gmail.com', 'admin');
  const r = await postPoll(env, adminToken, {
    ...BASE,
    anonymity: 'named',
    status: 'open'
  });
  assert.equal(r.status, 201);
  const pollId = r.body.id;

  const voterToken = await makeJwt('bob', 'bob@example.com', 'user', 'bob');
  const voteRes = await worker.fetch(req(`/api/polls/${pollId}/vote`, {
    method: 'POST', token: voterToken,
    body: { choices: [{ optionId: 'a', votes: 1 }] }
  }), env, {});
  assert.equal(voteRes.status, 200);

  const ballots = await getBallots(env, pollId);
  const b = ballots.results[0];
  assert.equal(b.voter_uid, 'bob', 'named ballots must store voter_uid');
  assert.equal(b.voter_email, 'bob@example.com', 'named ballots must store voter_email');
  assert.equal(b.voter_name, 'bob', 'named ballots must store voter_name');
  assert.equal(b.is_named, 1, 'named ballots marked is_named=true');

  const parts = await getParticipation(env, pollId);
  assert.notEqual(parts.results[0].ballot_id, null, 'named participation must expose ballot_id');
});
