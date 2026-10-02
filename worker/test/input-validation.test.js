import assert from 'node:assert/strict';
import { test, before } from 'node:test';
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

async function postPoll(env, token, body) {
  const res = await worker.fetch(req('/api/polls', { method: 'POST', token, body }), env, {});
  return { status: res.status, body: await res.json().catch(() => null) };
}

function baseBody(overrides = {}) {
  return { ...BASE, ...overrides };
}

// ---- M3-01: input limits ----

test('M3-A-01: empty title returns 400 title_required', async () => {
  const env = freshEnv();
  const token = await makeJwt('super', 'jamespolik@gmail.com', 'admin');
  const r = await postPoll(env, token, baseBody({ title: '   ' }));
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'title_required');
});

test('M3-A-02: title longer than 200 chars returns 400', async () => {
  const env = freshEnv();
  const token = await makeJwt('super', 'jamespolik@gmail.com', 'admin');
  const long = 'x'.repeat(201);
  const r = await postPoll(env, token, baseBody({ title: long }));
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'title_too_long');
});

test('M3-A-03: title exactly 200 chars is accepted', async () => {
  const env = freshEnv();
  const token = await makeJwt('super', 'jamespolik@gmail.com', 'admin');
  const ok = 'x'.repeat(200);
  const r = await postPoll(env, token, baseBody({ title: ok }));
  assert.equal(r.status, 201);
});

test('M3-A-04: description longer than 5000 chars returns 400', async () => {
  const env = freshEnv();
  const token = await makeJwt('super', 'jamespolik@gmail.com', 'admin');
  const long = 'x'.repeat(5001);
  const r = await postPoll(env, token, baseBody({ description: long }));
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'description_too_long');
});

test('M3-A-05: option code longer than 30 chars returns 400', async () => {
  const env = freshEnv();
  const token = await makeJwt('super', 'jamespolik@gmail.com', 'admin');
  const long = 'x'.repeat(31);
  const r = await postPoll(env, token, baseBody({ options: [
    { id: 'a', code: 'A', label: 'Option A' },
    { id: 'b', code: long, label: 'Option B' }
  ] }));
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'option_code_too_long');
});

test('M3-A-06: option code empty returns 400', async () => {
  const env = freshEnv();
  const token = await makeJwt('super', 'jamespolik@gmail.com', 'admin');
  const r = await postPoll(env, token, baseBody({ options: [
    { id: 'a', code: '', label: 'Option A' },
    { id: 'b', code: 'B', label: 'Option B' }
  ] }));
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'option_code_required');
});

test('M3-A-07: option label longer than 300 chars returns 400', async () => {
  const env = freshEnv();
  const token = await makeJwt('super', 'jamespolik@gmail.com', 'admin');
  const long = 'x'.repeat(301);
  const r = await postPoll(env, token, baseBody({ options: [
    { id: 'a', code: 'A', label: 'Option A' },
    { id: 'b', code: 'B', label: long }
  ] }));
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'option_label_too_long');
});

test('M3-A-08: option description longer than 2000 chars returns 400', async () => {
  const env = freshEnv();
  const token = await makeJwt('super', 'jamespolik@gmail.com', 'admin');
  const long = 'x'.repeat(2001);
  const r = await postPoll(env, token, baseBody({ options: [
    { id: 'a', code: 'A', label: 'Option A', description: 'ok' },
    { id: 'b', code: 'B', label: 'Option B', description: long }
  ] }));
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'option_description_too_long');
});

test('M3-A-09: more than 100 options returns 400', async () => {
  const env = freshEnv();
  const token = await makeJwt('super', 'jamespolik@gmail.com', 'admin');
  const options = [];
  for (let i = 0; i < 101; i++) {
    options.push({ id: 'o' + i, code: 'c' + i, label: 'Opt ' + i });
  }
  const r = await postPoll(env, token, baseBody({ options }));
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'too_many_options');
});

test('M3-A-10: exactly 100 options is accepted', async () => {
  const env = freshEnv();
  const token = await makeJwt('super', 'jamespolik@gmail.com', 'admin');
  const options = [];
  for (let i = 0; i < 100; i++) {
    options.push({ id: 'o' + i, code: 'c' + i, label: 'Opt ' + i });
  }
  const r = await postPoll(env, token, baseBody({ options }));
  assert.equal(r.status, 201);
});

test('M3-A-11: invalid domain (URL) returns 400', async () => {
  const env = freshEnv();
  const token = await makeJwt('super', 'jamespolik@gmail.com', 'admin');
  const r = await postPoll(env, token, baseBody({
    eligibilityMode: 'domain', allowedDomain: 'http://example.com/path'
  }));
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'invalid_domain');
});

test('M3-A-12: invalid domain (with @) returns 400', async () => {
  const env = freshEnv();
  const token = await makeJwt('super', 'jamespolik@gmail.com', 'admin');
  const r = await postPoll(env, token, baseBody({
    eligibilityMode: 'domain', allowedDomain: 'foo@example.com'
  }));
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'invalid_domain');
});

test('M3-A-13: valid domain is accepted', async () => {
  const env = freshEnv();
  const token = await makeJwt('super', 'jamespolik@gmail.com', 'admin');
  const r = await postPoll(env, token, baseBody({
    eligibilityMode: 'domain', allowedDomain: 'example.com'
  }));
  assert.equal(r.status, 201);
});

test('M3-A-14: negative maxVotes returns 400', async () => {
  const env = freshEnv();
  const token = await makeJwt('super', 'jamespolik@gmail.com', 'admin');
  const r = await postPoll(env, token, baseBody({ maxVotes: 0 }));
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'invalid_max_votes');
});

// ---- M3-02: error model ----

test('M3-A-15: 500 response contains a request id and no raw stack/SQL', async () => {
  const env = freshEnv();
  const token = await makeJwt('super', 'jamespolik@gmail.com', 'admin');
  // Force an internal error: pass a malformed body that throws in createPoll.
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
  // request id present
  assert.ok(body.requestId || body.request_id || body.id, '500 should include a request id');
  const raw = JSON.stringify(body);
  // must not leak SQL syntax or JS stack traces
  assert.ok(!/SQLITE_|near "|syntax error|at Object\.|at async/i.test(raw), 'must not leak SQL/stack');
});
