// M4-03: GET /api/polls/:id/my-ballot — returns only the current logged-in
// user's ballot (choices + timestamps), so the UI can pre-fill an editable
// ballot and show original/updated times.
// Run with: node --test test/my-ballot.test.js
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

async function openPoll(env, adminToken, overrides = {}) {
  const res = await worker.fetch(req('/api/polls', {
    method: 'POST',
    token: adminToken,
    body: {
      title: 'My Ballot Test',
      description: 'd',
      anonymity: 'named',
      voteMode: 'multiple',
      maxVotes: 2,
      allowChange: true,
      options: [
        { id: 'a', code: 'A', label: 'A' },
        { id: 'b', code: 'B', label: 'B' },
        { id: 'c', code: 'C', label: 'C' }
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

async function castVote(env, token, pollId, choices) {
  return worker.fetch(req(`/api/polls/${pollId}/vote`, {
    method: 'POST',
    token,
    body: { choices }
  }), env, {});
}

test('M4-03-01: no ballot yet returns 200 with voted=false', async () => {
  const env = envWith({ RATE_LIMIT_RPM: 100 });
  const adminToken = await makeJwt('admin', 'jamespolik@gmail.com', 'admin');
  const token = await makeJwt('u1', 'u1@example.com', 'user');
  const pollId = await openPoll(env, adminToken);

  const res = await worker.fetch(req(`/api/polls/${pollId}/my-ballot`, { token }), env, {});
  const data = await res.json();

  assert.equal(res.status, 200);
  assert.equal(data.voted, false);
  assert.equal(data.choices, null);
  assert.equal(data.submittedAt, null);
  assert.equal(data.updatedAt, null);
});

test('M4-03-02: after voting returns choices + timestamps', async () => {
  const env = envWith({ RATE_LIMIT_RPM: 100 });
  const adminToken = await makeJwt('admin', 'jamespolik@gmail.com', 'admin');
  const token = await makeJwt('u1', 'u1@example.com', 'user');
  const pollId = await openPoll(env, adminToken);

  const vr = await castVote(env, token, pollId, [{ optionId: 'a', votes: 1 }, { optionId: 'c', votes: 1 }]);
  assert.equal(vr.status, 200, 'vote should succeed');

  const res = await worker.fetch(req(`/api/polls/${pollId}/my-ballot`, { token }), env, {});
  const data = await res.json();

  assert.equal(res.status, 200);
  assert.equal(data.voted, true);
  assert.equal(data.choices.length, 2);
  // choices normalized to {optionId, votes}
  const ids = data.choices.map(c => c.optionId).sort();
  assert.deepEqual(ids, ['a', 'c']);
  assert.ok(typeof data.submittedAt === 'string' && data.submittedAt.length > 0);
  assert.ok(typeof data.updatedAt === 'string' && data.updatedAt.length > 0);
});

test('M4-03-03: only returns the current user’s ballot, not others’', async () => {
  const env = envWith({ RATE_LIMIT_RPM: 100 });
  const adminToken = await makeJwt('admin', 'jamespolik@gmail.com', 'admin');
  const user1 = await makeJwt('u1', 'u1@example.com', 'user');
  const user2 = await makeJwt('u2', 'u2@example.com', 'user');
  const pollId = await openPoll(env, adminToken);

  await castVote(env, user1, pollId, [{ optionId: 'a', votes: 1 }]);
  await castVote(env, user2, pollId, [{ optionId: 'b', votes: 1 }]);

  const r1 = await worker.fetch(req(`/api/polls/${pollId}/my-ballot`, { token: user1 }), env, {});
  const d1 = await r1.json();
  const r2 = await worker.fetch(req(`/api/polls/${pollId}/my-ballot`, { token: user2 }), env, {});
  const d2 = await r2.json();

  assert.deepEqual(d1.choices.map(c => c.optionId), ['a']);
  assert.deepEqual(d2.choices.map(c => c.optionId), ['b']);
});

test('M4-03-04: requires authentication (401 without token)', async () => {
  const env = envWith({ RATE_LIMIT_RPM: 100 });
  const adminToken = await makeJwt('admin', 'jamespolik@gmail.com', 'admin');
  const token = await makeJwt('u1', 'u1@example.com', 'user');
  const pollId = await openPoll(env, adminToken);

  const res = await worker.fetch(req(`/api/polls/${pollId}/my-ballot`), env, {});
  assert.equal(res.status, 401);
});

test('M4-03-05: returns 404 for unknown poll', async () => {
  const env = envWith({ RATE_LIMIT_RPM: 100 });
  const token = await makeJwt('u1', 'u1@example.com', 'user');

  const res = await worker.fetch(req('/api/polls/does-not-exist/my-ballot', { token }), env, {});
  assert.equal(res.status, 404);
});
