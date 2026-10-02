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
