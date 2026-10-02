import { createRemoteJWKSet, jwtVerify } from 'jose';

const jsonHeaders = { 'content-type': 'application/json; charset=utf-8' };

const jwksResolver = createRemoteJWKSet(new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'));

export default {
  async fetch(request, env) {
    try {
      return await handle(request, env);
    } catch (error) {
      console.error(error);
      return response({ error: 'internal_error', requestId: crypto.randomUUID() }, 500, request, env);
    }
  }
};

async function handle(request, env) {
  const url = new URL(request.url);
  if (request.method === 'OPTIONS') return corsPreflight(request, env);
  if (!url.pathname.startsWith('/api/')) return response({ ok: true, service: 'vote-platform-api' }, 200, request, env);

  // M3-04: throttle abnormal 401 / invalid-token volume per client IP so a
  // single source cannot brute-force tokens. Applied before auth.
  const authLimits = rateLimitLimits(env);
  const ip = (request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown').split(',')[0].trim();
  const authBudget = await checkRateLimit(env, `auth:${ip}`, authLimits.authFail);
  if (!authBudget.allowed) return rateLimitedResponse(authBudget.retryAfter, request, env);

  // M4-02: public heartbeat endpoint — unauthenticated, handled before auth.
  const sitePath = url.pathname.replace(/^\/api\/?/, '');
  if (sitePath === 'site-stats' && request.method === 'POST') return postSiteStats(env, request);

  const user = await authenticate(request, env);
  if (!user) return response({ error: 'unauthorized' }, 401, request, env);

  // M3-04: general per-UID request budget.
  const limits = rateLimitLimits(env);
  const general = await checkRateLimit(env, `user:${user.uid}`, limits.general);
  if (!general.allowed) return rateLimitedResponse(general.retryAfter, request, env);

  const path = url.pathname.replace(/^\/api\/?/, '');
  const parts = path.split('/').filter(Boolean);

  if (parts[0] === 'me' && request.method === 'GET') return getMe(user, env, request);
  if (parts[0] === 'admins') return handleAdmins(parts, request, env, user);
  if (parts[0] === 'polls') return handlePolls(parts, request, env, user, url);

  return response({ error: 'not_found' }, 404, request, env);
}

function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
}

function corsHeaders(request, env) {
  const origin = request.headers.get('origin');
  const allowed = allowedOrigins(env);
  const headers = {
    'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'access-control-allow-headers': 'authorization,content-type',
    'access-control-max-age': '86400',
    'vary': 'Origin'
  };
  if (!origin || allowed.includes(origin)) headers['access-control-allow-origin'] = origin || '*';
  return headers;
}

function corsPreflight(request, env) {
  const origin = request.headers.get('origin');
  if (origin && !allowedOrigins(env).includes(origin)) return new Response(null, { status: 403 });
  return new Response(null, { status: 204, headers: corsHeaders(request, env) });
}

function response(data, status, request, env, extra = {}) {
  const data2 = { requestId: crypto.randomUUID(), ...data };
  return new Response(JSON.stringify(data2), {
    status,
    headers: {
      ...jsonHeaders,
      ...corsHeaders(request, env),
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'x-xss-protection': '1; mode=block',
      'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
      'x-request-id': data2.requestId,
      ...extra
    }
  });
}

// --- M3-04: fixed-window rate limiting ----------------------------------------
// Stored in `rate_limits`; does NOT replace the participation unique constraint.
const RATE_WINDOW_MS = 60000;
function rateLimitLimits(env) {
  return {
    general: Number(env.RATE_LIMIT_RPM ?? 120),
    vote: Number(env.RATE_LIMIT_VOTE_RPM ?? 60),
    whitelist: Number(env.RATE_LIMIT_WHITELIST_RPM ?? 10),
    authFail: Number(env.RATE_LIMIT_AUTH_RPM ?? 60)
  };
}
async function checkRateLimit(env, key, limit) {
  const now = Date.now();
  const row = await env.DB.prepare('SELECT count, window_start_ms FROM rate_limits WHERE key = ?').bind(key).first();
  if (!row || now - row.window_start_ms >= RATE_WINDOW_MS) {
    await env.DB.prepare('INSERT INTO rate_limits(key, count, window_start_ms) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET count=1, window_start_ms=?').bind(key, 1, now, now).run();
    return { allowed: true, remaining: Math.max(limit - 1, 0), retryAfter: 0 };
  }
  const next = row.count + 1;
  if (next > limit) {
    return { allowed: false, remaining: 0, retryAfter: Math.ceil((row.window_start_ms + RATE_WINDOW_MS - now) / 1000) };
  }
  await env.DB.prepare('UPDATE rate_limits SET count = ? WHERE key = ?').bind(next, key).run();
  return { allowed: true, remaining: Math.max(limit - next, 0), retryAfter: 0 };
}
function rateLimitedResponse(retryAfter, request, env) {
  return response({ error: 'rate_limited', requestId: crypto.randomUUID() }, 429, request, env, { 'retry-after': String(retryAfter) });
}

// M4-02: public heartbeat endpoint for anonymous site traffic.
// Records one row per heartbeat; per-IP rate limited so a single visitor
// cannot flood the table. All fields are sanitized strings.
async function postSiteStats(env, request) {
  const ip = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || '';
  const budget = await checkRateLimit(env, `site:${ip}`, Number(env.RATE_LIMIT_SITE_RPM ?? 60));
  if (!budget.allowed) return rateLimitedResponse(budget.retryAfter, request, env);

  const body = await parseJson(request);
  const page = typeof body.page === 'string' ? String(body.page).slice(0, 2000) : '/';
  const visitorId = typeof body.visitorId === 'string' ? String(body.visitorId).slice(0, 64) : '';
  const duration = typeof body.duration === 'number' && body.duration >= 0 && Number.isFinite(body.duration)
    ? Math.floor(body.duration) : null;
  const device = typeof body.device === 'string' ? String(body.device).slice(0, 64) : '';
  const referrer = typeof body.referrer === 'string' ? String(body.referrer).slice(0, 2048) : '';
  if (!visitorId) return response({ error: 'visitor_id_required' }, 400, request, env);

  const now = new Date().toISOString();
  await env.DB.prepare(
    'INSERT INTO site_stats(page, visitorId, duration, device, referrer, ip, createdAt) VALUES(?,?,?,?,?,?,?)'
  ).bind(page, visitorId, duration, device, referrer, ip, now).run();
  return response({ ok: true }, 201, request, env);
}

async function authenticate(request, env) {
  const auth = request.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token || !env.FIREBASE_PROJECT_ID) return null;
  try {
    const { payload } = await jwtVerify(token, jwksResolver, {
      issuer: `https://securetoken.google.com/${env.FIREBASE_PROJECT_ID}`,
      audience: env.FIREBASE_PROJECT_ID
    });
    if (!payload.sub || !payload.email || payload.email_verified === false) return null;
    // M3-03: only Google sign-in tokens are trusted (real Firebase tokens set
    // this; password/other providers must not be accepted here).
    if (payload.sign_in_provider !== 'google.com') return null;
    return {
      uid: String(payload.sub),
      email: String(payload.email).toLowerCase(),
      name: String(payload.name || payload.email),
      picture: payload.picture || null
    };
  } catch (e) {
    console.warn('Auth failed', e?.message);
    return null;
  }
}

function isSuper(user, env) {
  return user.email === String(env.SUPER_ADMIN_EMAIL || '').trim().toLowerCase();
}

async function isAdmin(user, env) {
  if (isSuper(user, env)) return true;
  const row = await env.DB.prepare('SELECT email FROM admins WHERE email = ?').bind(user.email).first();
  return !!row;
}

async function requireAdmin(user, env) {
  if (!(await isAdmin(user, env))) throw httpError(403, 'admin_required');
}

async function requirePollManager(user, env, poll) {
  if (isSuper(user, env)) return;
  if (!(await isAdmin(user, env)) || poll.owner_uid !== user.uid) throw httpError(403, 'forbidden');
}

function httpError(status, code, message = code) {
  const e = new Error(message); e.status = status; e.code = code; return e;
}

async function parseJson(request) {
  try { return await request.json(); } catch { throw httpError(400, 'invalid_json'); }
}

async function getMe(user, env, request) {
  const admin = await isAdmin(user, env);
  return response({ user, role: isSuper(user, env) ? 'super_admin' : admin ? 'admin' : 'voter' }, 200, request, env);
}

async function handleAdmins(parts, request, env, user) {
  if (!isSuper(user, env)) return response({ error: 'super_admin_required' }, 403, request, env);
  if (request.method === 'GET' && parts.length === 1) {
    const rows = await env.DB.prepare('SELECT email, role, created_at FROM admins ORDER BY created_at DESC').all();
    return response({ admins: rows.results || [] }, 200, request, env);
  }
  if (request.method === 'POST' && parts.length === 1) {
    const body = await parseJson(request);
    const email = normalizeEmail(body.email);
    if (!email) return response({ error: 'invalid_email' }, 400, request, env);
    await env.DB.prepare('INSERT OR IGNORE INTO admins(email, role) VALUES (?,?)').bind(email, 'admin').run();
    return response({ ok: true, email }, 201, request, env);
  }
  if (request.method === 'DELETE' && parts.length === 2) {
    const email = normalizeEmail(decodeURIComponent(parts[1]));
    await env.DB.prepare('DELETE FROM admins WHERE email = ?').bind(email).run();
    return response({ ok: true }, 200, request, env);
  }
  return response({ error: 'not_found' }, 404, request, env);
}

async function handlePolls(parts, request, env, user, url) {
  if (parts.length === 1) {
    if (request.method === 'GET') return listPolls(user, env, request);
    if (request.method === 'POST') return createPoll(user, env, request);
  }

  const pollId = parts[1];
  const poll = await getPoll(env, pollId);
  if (!poll) return response({ error: 'poll_not_found' }, 404, request, env);

  if (parts.length === 2) {
    if (request.method === 'GET') return getPollView(user, env, request, poll);
    if (request.method === 'PATCH') return updatePoll(user, env, request, poll);
    if (request.method === 'DELETE') return deletePoll(user, env, request, poll);
  }

  const action = parts[2];
  if (action === 'vote' && request.method === 'POST') {
    // M3-04: vote frequency budget (does NOT replace participation unique constraint).
    const limits = rateLimitLimits(env);
    const vote = await checkRateLimit(env, `vote:${poll.id}:${user.uid}`, limits.vote);
    if (!vote.allowed) return rateLimitedResponse(vote.retryAfter, request, env);
    return castVote(user, env, request, poll);
  }
  if (action === 'results' && request.method === 'GET') return getResults(user, env, request, poll);
  if (action === 'my-ballot' && request.method === 'GET') return getMyBallot(user, env, request, poll);
  if (action === 'participants' && request.method === 'GET') return getParticipants(user, env, request, poll);
  if (action === 'whitelist') {
    if (request.method === 'POST') {
      // M3-04: whitelist import frequency budget.
      const limits = rateLimitLimits(env);
      const wl = await checkRateLimit(env, `whitelist:${poll.id}:${user.uid}`, limits.whitelist);
      if (!wl.allowed) return rateLimitedResponse(wl.retryAfter, request, env);
      return importWhitelist(user, env, request, poll);
    }
    if (request.method === 'GET') return getWhitelist(user, env, request, poll);
  }
  if (action === 'audit' && request.method === 'GET') return getAudit(user, env, request, poll);
  if (action === 'export' && request.method === 'GET') return exportPoll(user, env, request, poll, url.searchParams.get('type') || 'results');
  if (action === 'duplicate' && request.method === 'POST') return duplicatePoll(user, env, request, poll);

  return response({ error: 'not_found' }, 404, request, env);
}

async function listPolls(user, env, request) {
  const admin = await isAdmin(user, env);
  let rows;
  if (isSuper(user, env)) {
    rows = await env.DB.prepare('SELECT * FROM polls ORDER BY created_at DESC').all();
  } else if (admin) {
    rows = await env.DB.prepare('SELECT * FROM polls WHERE owner_uid = ? OR status IN (\'scheduled\',\'open\',\'paused\',\'closed\') ORDER BY created_at DESC').bind(user.uid).all();
  } else {
    rows = await env.DB.prepare("SELECT * FROM polls WHERE status IN ('scheduled','open','paused','closed') ORDER BY created_at DESC").all();
  }
  const output = [];
  for (const p of rows.results || []) {
    const manager = isSuper(user, env) || (admin && p.owner_uid === user.uid);
    const eligible = manager ? true : await checkEligibility(env, p, user);
    if (manager || eligible) output.push({ ...publicPoll(p), canManage: manager, eligible, effectiveStatus: effectiveStatus(p) });
  }
  return response({ polls: output }, 200, request, env);
}

async function createPoll(user, env, request) {
  try { await requireAdmin(user, env); } catch (e) { return response({ error: e.code }, e.status, request, env); }
  const body = await parseJson(request);
  const validated = validatePollInput(body, false);
  if (validated.error) return response({ error: validated.error }, 400, request, env);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const p = validated.value;
  const statements = [
    env.DB.prepare(`INSERT INTO polls (
      id, owner_uid, owner_email, title, description, anonymity, vote_mode, max_votes, require_all_votes,
      allow_change, eligibility_mode, allowed_domain, results_visibility, show_percentages, show_ranking,
      quorum_type, quorum_value, approval_type, approval_value, start_at, end_at, status, created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      id, user.uid, user.email, p.title, p.description, p.anonymity, p.voteMode, p.maxVotes, b(p.requireAllVotes),
      b(p.allowChange), p.eligibilityMode, p.allowedDomain, p.resultsVisibility, b(p.showPercentages), b(p.showRanking),
      p.quorumType, p.quorumValue, p.approvalType, p.approvalValue, p.startAt, p.endAt, p.status, now, now
    )
  ];
  p.options.forEach((o, i) => statements.push(env.DB.prepare('INSERT INTO options(id,poll_id,code,label,description,sort_order) VALUES(?,?,?,?,?,?)').bind(o.id || crypto.randomUUID(), id, o.code, o.label, o.description || '', i)));
  await env.DB.batch(statements);
  await audit(env, id, user, 'poll_created', { title: p.title });
  return response({ ok: true, id }, 201, request, env);
}

async function getPollView(user, env, request, poll) {
  const admin = await isAdmin(user, env);
  const canManage = isSuper(user, env) || (admin && poll.owner_uid === user.uid);
  const eligible = canManage ? true : await checkEligibility(env, poll, user);
  const opts = await getOptions(env, poll.id);
  const participation = await env.DB.prepare('SELECT vote_count, submitted_at, updated_at FROM participation WHERE poll_id=? AND uid=?').bind(poll.id, user.uid).first();
  if (!canManage && !eligible) return response({ error: 'not_eligible' }, 403, request, env);
  return response({ poll: { ...publicPoll(poll), options: opts, effectiveStatus: effectiveStatus(poll) }, canManage, eligible, participation: participation || null }, 200, request, env);
}

async function updatePoll(user, env, request, poll) {
  try { await requirePollManager(user, env, poll); } catch (e) { return response({ error: e.code }, e.status, request, env); }
  const body = await parseJson(request);
  const merged = { ...pollToInput(poll), ...body };
  if (!body.options) merged.options = await getOptions(env, poll.id);
  const validated = validatePollInput(merged, true);
  if (validated.error) return response({ error: validated.error }, 400, request, env);
  const p = validated.value;

  if (poll.has_votes) {
    const locked = ['anonymity','voteMode','maxVotes','requireAllVotes','eligibilityMode','allowedDomain'];
    for (const key of locked) {
      if (String(p[key] ?? '') !== String(pollToInput(poll)[key] ?? '')) return response({ error: 'locked_after_first_vote', field: key }, 409, request, env);
    }
    if (body.options) return response({ error: 'options_locked_after_first_vote' }, 409, request, env);
  }

  const allowedStatuses = ['draft','scheduled','open','paused','closed','archived'];
  if (!allowedStatuses.includes(p.status)) return response({ error: 'invalid_status' }, 400, request, env);
  if (poll.status === 'archived' && p.status !== 'archived') return response({ error: 'archived_poll_is_final' }, 409, request, env);
  if (poll.has_votes && ['draft','scheduled'].includes(p.status)) return response({ error: 'cannot_revert_poll_with_votes' }, 409, request, env);
  if (poll.status === 'closed' && !['closed','archived'].includes(p.status)) return response({ error: 'closed_poll_cannot_reopen' }, 409, request, env);
  try { await assertTransition(env, poll, poll.status, p.status, user); } catch (e) { return response({ error: e.code, detail: e.detail }, e.status, request, env); }
  if (p.status === 'closed' && poll.status !== 'closed') {
    try { await snapshotCloseResults(env, poll); } catch (e) {}
  }
  const now = new Date().toISOString();
  const statements = [env.DB.prepare(`UPDATE polls SET title=?,description=?,anonymity=?,vote_mode=?,max_votes=?,require_all_votes=?,allow_change=?,eligibility_mode=?,allowed_domain=?,results_visibility=?,show_percentages=?,show_ranking=?,quorum_type=?,quorum_value=?,approval_type=?,approval_value=?,start_at=?,end_at=?,status=?,version=version+1,closed_at=COALESCE(closed_at,?),archived_at=COALESCE(archived_at,?),updated_at=? WHERE id=?`).bind(
    p.title,p.description,p.anonymity,p.voteMode,p.maxVotes,b(p.requireAllVotes),b(p.allowChange),p.eligibilityMode,p.allowedDomain,p.resultsVisibility,b(p.showPercentages),b(p.showRanking),p.quorumType,p.quorumValue,p.approvalType,p.approvalValue,p.startAt,p.endAt,p.status, p.status==='closed' ? now : null, p.status==='archived' ? now : null, now, poll.id
  )];
  if (body.options && !poll.has_votes) {
    statements.push(env.DB.prepare('DELETE FROM options WHERE poll_id=?').bind(poll.id));
    p.options.forEach((o,i)=> statements.push(env.DB.prepare('INSERT INTO options(id,poll_id,code,label,description,sort_order) VALUES(?,?,?,?,?,?)').bind(o.id || crypto.randomUUID(),poll.id,o.code,o.label,o.description||'',i)));
  }
  await env.DB.batch(statements);
  await audit(env, poll.id, user, 'poll_updated', { fields: Object.keys(body) });
  return response({ ok: true }, 200, request, env);
}

async function deletePoll(user, env, request, poll) {
  try { await requirePollManager(user, env, poll); } catch (e) { return response({ error: e.code }, e.status, request, env); }
  if (poll.has_votes) return response({ error: 'poll_has_votes_archive_instead' }, 409, request, env);
  await env.DB.prepare('DELETE FROM polls WHERE id=?').bind(poll.id).run();
  return response({ ok: true }, 200, request, env);
}

async function duplicatePoll(user, env, request, poll) {
  try { await requirePollManager(user, env, poll); } catch (e) { return response({ error: e.code }, e.status, request, env); }
  const opts = await getOptions(env, poll.id);
  const body = { ...pollToInput(poll), title: `${poll.title}（副本）`, status: 'draft', options: opts, startAt: null, endAt: null };
  const fakeReq = new Request(request.url, { method:'POST', headers:request.headers, body:JSON.stringify(body) });
  return createPoll(user, env, fakeReq);
}

async function importWhitelist(user, env, request, poll) {
  try { await requirePollManager(user, env, poll); } catch (e) { return response({ error: e.code }, e.status, request, env); }
  if (poll.eligibility_mode !== 'whitelist') return response({ error:'poll_not_whitelist_mode' },400,request,env);
  const body = await parseJson(request);
  const rows = Array.isArray(body.entries) ? body.entries : [];
  if (!rows.length || rows.length > 5000) return response({ error:'entries_required_or_too_many' },400,request,env);
  const stmts = [];
  for (const item of rows) {
    const email = normalizeEmail(typeof item === 'string' ? item : item.email);
    if (!email) continue;
    stmts.push(env.DB.prepare('INSERT OR REPLACE INTO whitelist(poll_id,email,display_name) VALUES(?,?,?)').bind(poll.id,email,typeof item==='object' ? String(item.name||'') : ''));
  }
  if (stmts.length) await env.DB.batch(stmts);
  await audit(env,poll.id,user,'whitelist_imported',{count:stmts.length});
  return response({ok:true,count:stmts.length},200,request,env);
}

async function getWhitelist(user, env, request, poll) {
  try { await requirePollManager(user, env, poll); } catch (e) { return response({ error:e.code },e.status,request,env); }
  const rows = await env.DB.prepare('SELECT email, display_name, created_at FROM whitelist WHERE poll_id=? ORDER BY email').bind(poll.id).all();
  return response({entries:rows.results||[]},200,request,env);
}

async function castVote(user, env, request, poll) {
  const eligible = await checkEligibility(env,poll,user);
  if (!eligible) return response({error:'not_eligible'},403,request,env);
  if (effectiveStatus(poll) !== 'open') return response({error:'poll_not_open'},409,request,env);
  const body = await parseJson(request);
  const choices = normalizeChoices(body.choices);
  const opts = await getOptions(env,poll.id);
  const validation = validateChoices(poll, opts, choices);
  if (validation) return response({error:validation},400,request,env);

  const existing = await env.DB.prepare('SELECT * FROM participation WHERE poll_id=? AND uid=?').bind(poll.id,user.uid).first();
  if (existing && !poll.allow_change) return response({error:'already_voted'},409,request,env);

  const ballotId = existing?.ballot_id || crypto.randomUUID();
  const now = new Date().toISOString();
  const named = poll.anonymity === 'named';
  const anon = !named;
  const voteCount = choices.reduce((s,c)=>s+c.votes,0);
  const ballotJson = JSON.stringify(choices);

  const stmts = [];
  if (existing) {
    stmts.push(env.DB.prepare('UPDATE participation SET email=?,display_name=?,vote_count=?,updated_at=? WHERE poll_id=? AND uid=?').bind(user.email,user.name,voteCount,now,poll.id,user.uid));
    stmts.push(env.DB.prepare('UPDATE ballots SET voter_uid=?,voter_email=?,voter_name=?,is_named=?,choice_json=?,updated_at=? WHERE id=? AND poll_id=?').bind(named?user.uid:null,named?user.email:null,named?user.name:null,b(named),ballotJson,now,ballotId,poll.id));
  } else {
    stmts.push(env.DB.prepare('INSERT INTO participation(poll_id,uid,email,display_name,vote_count,ballot_id,submitted_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').bind(poll.id,user.uid,user.email,user.name,voteCount,anon?null:ballotId,now,now));
    stmts.push(env.DB.prepare('INSERT INTO ballots(id,poll_id,voter_uid,voter_email,voter_name,is_named,choice_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').bind(ballotId,poll.id,named?user.uid:null,named?user.email:null,named?user.name:null,b(named),ballotJson,now,now));
    stmts.push(env.DB.prepare('UPDATE polls SET has_votes=1,first_vote_at=COALESCE(first_vote_at,?),status=?,updated_at=? WHERE id=?').bind(now, effectiveStatus(poll) === 'open' ? 'open' : poll.status, now, poll.id));
    // M1: freeze rules + options on first vote.
    try { await freezePollRules(env, poll); } catch (e) { await audit(env, poll.id, user, 'freeze_failed', { error: String(e) }); }
  }
  await env.DB.batch(stmts);
  await syncBallotChoices(env,poll.id,ballotId,choices);
  await audit(env,poll.id,user,existing?'vote_changed':'vote_submitted',{anonymous:anon,voteCount});
  return response({ok:true,changed:!!existing,voteCount},200,request,env);
}

async function getResults(user, env, request, poll) {
  const admin = await isAdmin(user, env);
  const canManage = isSuper(user, env) || (admin && poll.owner_uid === user.uid);
  const participation = await env.DB.prepare('SELECT uid FROM participation WHERE poll_id=? AND uid=?').bind(poll.id,user.uid).first();
  const eff = effectiveStatus(poll);
  const visible = canManage || poll.results_visibility === 'public' || (poll.results_visibility === 'after_vote' && participation) || (poll.results_visibility === 'after_close' && ['closed','archived'].includes(eff));
  if (!visible) return response({error:'results_not_visible'},403,request,env);

  const opts = await getOptions(env,poll.id);
  // M4-01: lazily backfill ballot_choices for any pre-existing ballot, then
  // aggregate in SQL instead of shipping every ballot to the Worker.
  await backfillBallotChoices(env,poll.id);
  const counts = Object.fromEntries(opts.map(o=>[o.id,0]));
  const agg = await env.DB.prepare('SELECT option_id, SUM(votes) AS votes FROM ballot_choices WHERE poll_id=? GROUP BY option_id').bind(poll.id).all();
  let totalBallots=0,totalVotes=0;
  for (const r of agg.results||[]) {
    if (counts[r.option_id] !== undefined) { counts[r.option_id]=Number(r.votes||0); totalVotes+=Number(r.votes||0); }
  }
  const totalBallotsRow = await env.DB.prepare('SELECT COUNT(*) n FROM participation WHERE poll_id=?').bind(poll.id).first();
  totalBallots = Number(totalBallotsRow?.n||0);
  const results = opts.map(o=>({id:o.id,code:o.code,label:o.label,votes:counts[o.id]||0}));
  const denom = poll.vote_mode==='allocate' ? Math.max(totalVotes,1) : Math.max(totalBallots,1);
  results.forEach(r=>r.percentage=Number(((r.votes/denom)*100).toFixed(2)));
  results.sort((a,b)=>b.votes-a.votes || a.code.localeCompare(b.code));
  results.forEach((r,i)=>r.rank=i+1);
  const eligibleCount = await getEligibleCount(env,poll);
  const quorum = calculateQuorum(poll,totalBallots,eligibleCount);
  const approval = results.map(r=>({...r,approved:calculateApproval(poll,r.votes,totalBallots,totalVotes)}));
  return response({pollId:poll.id,totalParticipants:totalBallots,totalVotes,eligibleCount,quorum,results:approval,effectiveStatus:eff},200,request,env);
}

// M4-03: return only the current user's ballot so the UI can pre-fill an
// editable ballot and show original/updated times. Anonymous polls pool their
// ballots (participation.ballot_id and ballots.voter_uid are null per M3-06),
// so for those we return the most recent anonymous ballot's choices.
async function getMyBallot(user, env, request, poll) {
  const existing = await env.DB.prepare('SELECT * FROM participation WHERE poll_id=? AND uid=?').bind(poll.id, user.uid).first();
  if (!existing) return response({ voted: false, choices: null, submittedAt: null, updatedAt: null }, 200, request, env);

  const ballotId = existing.ballot_id;
  const isNamed = existing.voter_uid !== null;
  let ballot = null;
  if (isNamed) {
    ballot = await env.DB.prepare('SELECT choice_json, created_at, updated_at FROM ballots WHERE id=?').bind(ballotId).first();
  } else {
    // Anonymous: no uid->ballot link; return the most recent anonymous ballot.
    ballot = await env.DB.prepare('SELECT choice_json, created_at, updated_at FROM ballots WHERE poll_id=? AND voter_uid IS NULL ORDER BY id DESC').bind(poll.id).first();
  }
  if (!ballot) return response({ voted: false, choices: null, submittedAt: null, updatedAt: null }, 200, request, env);

  const choices = normalizeChoices(safeJson(ballot.choice_json, []));
  return response({ voted: true, choices, submittedAt: ballot.created_at, updatedAt: ballot.updated_at }, 200, request, env);
}

async function getParticipants(user, env, request, poll) {
  try { await requirePollManager(user,env,poll); } catch(e){ return response({error:e.code},e.status,request,env); }
  const rows = await env.DB.prepare('SELECT email,display_name,vote_count,submitted_at,updated_at FROM participation WHERE poll_id=? ORDER BY submitted_at').bind(poll.id).all();
  return response({participants:rows.results||[]},200,request,env);
}

async function getAudit(user, env, request, poll) {
  try { await requirePollManager(user,env,poll); } catch(e){ return response({error:e.code},e.status,request,env); }
  const rows = await env.DB.prepare('SELECT actor_email,action,detail_json,created_at FROM audit_logs WHERE poll_id=? ORDER BY id DESC LIMIT 500').bind(poll.id).all();
  return response({logs:(rows.results||[]).map(r=>({...r,detail:safeJson(r.detail_json,{})}))},200,request,env);
}

async function exportPoll(user, env, request, poll, type) {
  try { await requirePollManager(user,env,poll); } catch(e){ return response({error:e.code},e.status,request,env); }
  let csv='';
  if (type==='participants') {
    const rows=await env.DB.prepare('SELECT display_name,email,vote_count,submitted_at FROM participation WHERE poll_id=? ORDER BY submitted_at').bind(poll.id).all();
    csv=toCsv(['name','email','vote_count','submitted_at'],(rows.results||[]).map(r=>[r.display_name,r.email,r.vote_count,r.submitted_at]));
  } else if (type==='named_votes') {
    if (poll.anonymity!=='named') return response({error:'anonymous_poll_no_named_export'},400,request,env);
    const opts=await getOptions(env,poll.id); const map=Object.fromEntries(opts.map(o=>[o.id,o.label]));
    const rows=await env.DB.prepare('SELECT voter_name,voter_email,choice_json,created_at,updated_at FROM ballots WHERE poll_id=? ORDER BY created_at').bind(poll.id).all();
    csv=toCsv(['name','email','choices','created_at','updated_at'],(rows.results||[]).map(r=>[r.voter_name,r.voter_email,safeJson(r.choice_json,[]).map(c=>`${map[c.optionId]||c.optionId} x${c.votes}`).join(' | '),r.created_at,r.updated_at]));
  } else {
    const resultReq=new Request(request.url,{headers:request.headers});
    const res=await getResults(user,env,resultReq,poll); const data=await res.json();
    if (!data.results) return response(data,res.status,request,env);
    csv=toCsv(['rank','code','option','votes','percentage','approved'],data.results.map(r=>[r.rank,r.code,r.label,r.votes,r.percentage,r.approved]));
  }
  return new Response('\ufeff'+csv,{status:200,headers:{...corsHeaders(request,env),'content-type':'text/csv; charset=utf-8','content-disposition':`attachment; filename="${poll.id}-${type}.csv"`}});
}

async function getPoll(env,id){ return env.DB.prepare('SELECT * FROM polls WHERE id=?').bind(id).first(); }
async function getOptions(env,id){ const r=await env.DB.prepare('SELECT id,code,label,description,sort_order FROM options WHERE poll_id=? ORDER BY sort_order,code').bind(id).all(); return r.results||[]; }

// M4-01: keep the normalized `ballot_choices` tally in lockstep with a ballot's
// choice_json. DELETE + INSERT in one batch is atomic; the PRIMARY KEY
// (poll_id, ballot_id, option_id) guarantees one row per option so a re-vote
// never leaves stale tallies behind. choice_json stays the single authoritative
// record; ballot_choices is a derived index read by SQL aggregation.
async function syncBallotChoices(env,pollId,ballotId,choices){
  const stmts=[env.DB.prepare('DELETE FROM ballot_choices WHERE poll_id=? AND ballot_id=?').bind(pollId,ballotId)];
  for(const c of choices) stmts.push(env.DB.prepare('INSERT OR IGNORE INTO ballot_choices(poll_id,ballot_id,option_id,votes) VALUES(?,?,?,?)').bind(pollId,ballotId,c.optionId,c.votes));
  if(stmts.length>1) await env.DB.batch(stmts);
}

// M4-01: lazily backfill ballot_choices from choice_json for any ballot that
// predates this table. node:sqlite has no JSON1, so choice_json is parsed in JS.
// Gated by a NOT IN subquery so warm polls cost one indexed scan, no writes.
async function backfillBallotChoices(env,pollId){
  const rows=await env.DB.prepare('SELECT id,choice_json FROM ballots WHERE poll_id=? AND id NOT IN (SELECT DISTINCT ballot_id FROM ballot_choices WHERE poll_id=?)').bind(pollId,pollId).all();
  const stmts=[];
  for(const row of rows.results||[]) for(const c of normalizeChoices(safeJson(row.choice_json,[]))) stmts.push(env.DB.prepare('INSERT OR IGNORE INTO ballot_choices(poll_id,ballot_id,option_id,votes) VALUES(?,?,?,?)').bind(pollId,row.id,c.optionId,c.votes));
  if(stmts.length) await env.DB.batch(stmts);
}

function publicPoll(p){
  return {
    id:p.id,ownerEmail:p.owner_email,title:p.title,description:p.description,anonymity:p.anonymity,voteMode:p.vote_mode,maxVotes:p.max_votes,
    requireAllVotes:!!p.require_all_votes,allowChange:!!p.allow_change,eligibilityMode:p.eligibility_mode,allowedDomain:p.allowed_domain,
    resultsVisibility:p.results_visibility,showPercentages:!!p.show_percentages,showRanking:!!p.show_ranking,
    quorumType:p.quorum_type,quorumValue:p.quorum_value,approvalType:p.approval_type,approvalValue:p.approval_value,
    startAt:p.start_at,endAt:p.end_at,status:p.status,hasVotes:!!p.has_votes,createdAt:p.created_at,updatedAt:p.updated_at
  };
}
function pollToInput(p){ return {...publicPoll(p),voteMode:p.vote_mode,eligibilityMode:p.eligibility_mode,allowedDomain:p.allowed_domain,resultsVisibility:p.results_visibility,quorumType:p.quorum_type,quorumValue:p.quorum_value,approvalType:p.approval_type,approvalValue:p.approval_value}; }

function validatePollInput(body){
  const title=String(body.title||'').trim(); if(!title) return {error:'title_required'};
  if (title.length > 200) return {error:'title_too_long'};
  const anonymity=['named','anonymous'].includes(body.anonymity)?body.anonymity:null; if(!anonymity)return{error:'invalid_anonymity'};
  const voteMode=['single','multiple','allocate'].includes(body.voteMode)?body.voteMode:null; if(!voteMode)return{error:'invalid_vote_mode'};
  const maxVotes=voteMode==='single'?1:Number(body.maxVotes==null?1:body.maxVotes); if(!Number.isInteger(maxVotes)||maxVotes<1||maxVotes>100)return{error:'invalid_max_votes'};
  const eligibilityMode=['public','whitelist','domain'].includes(body.eligibilityMode)?body.eligibilityMode:null; if(!eligibilityMode)return{error:'invalid_eligibility_mode'};
  let allowedDomain=null;
  if (eligibilityMode==='domain'){
    const raw=String(body.allowedDomain||'').trim().toLowerCase();
    if(!raw)return{error:'domain_required'};
    if (raw.includes('@')||raw.includes('/')||raw.includes(':'))return{error:'invalid_domain'};
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(raw))return{error:'invalid_domain'};
    allowedDomain=raw;
  }
  const resultsVisibility=['public','after_vote','after_close','admin_only'].includes(body.resultsVisibility)?body.resultsVisibility:'after_close';
  const quorumType=['none','count','percent'].includes(body.quorumType)?body.quorumType:'none';
  if (quorumType === 'percent' && eligibilityMode !== 'whitelist') return {error:'percent_quorum_requires_whitelist'};
  const approvalType=['none','gt50','gte50','two_thirds','percent','count'].includes(body.approvalType)?body.approvalType:'none';
  const description=String(body.description||'').trim(); if (description.length > 5000) return {error:'description_too_long'};
  const options=(body.options||[]).map((o,i)=>({id:o.id,code:String(o.code||'').trim(),label:String(o.label||'').trim(),description:String(o.description||'').trim()}));
  if(options.length<2)return{error:'at_least_two_options'};
  if(options.length>100)return{error:'too_many_options'};
  for (const o of options){
    if(!o.code)return{error:'option_code_required'};
    if (o.code.length>30)return{error:'option_code_too_long'};
    if(!o.label)return{error:'option_label_required'};
    if (o.label.length>300)return{error:'option_label_too_long'};
    if (o.description.length>2000)return{error:'option_description_too_long'};
  }
  const codes=new Set(options.map(o=>o.code.toLowerCase())); if(codes.size!==options.length)return{error:'duplicate_option_code'};
  const status=['draft','scheduled','open','paused','closed','archived'].includes(body.status)?body.status:'draft';
  const startAt=body.startAt?new Date(body.startAt).toISOString():null; const endAt=body.endAt?new Date(body.endAt).toISOString():null;
  if(startAt&&endAt&&startAt>=endAt)return{error:'invalid_date_range'};
  return {value:{title,description,anonymity,voteMode,maxVotes,requireAllVotes:!!body.requireAllVotes,allowChange:!!body.allowChange,eligibilityMode,allowedDomain,resultsVisibility,showPercentages:body.showPercentages!==false,showRanking:body.showRanking!==false,quorumType,quorumValue:body.quorumValue==null?null:Number(body.quorumValue),approvalType,approvalValue:body.approvalValue==null?null:Number(body.approvalValue),startAt,endAt,status,options}};
}

async function checkEligibility(env,poll,user){
  if(poll.eligibility_mode==='public') return true;
  if(poll.eligibility_mode==='domain') return user.email.endsWith('@'+String(poll.allowed_domain||'').toLowerCase());
  if(poll.eligibility_mode==='whitelist') return !!(await env.DB.prepare('SELECT 1 x FROM whitelist WHERE poll_id=? AND email=?').bind(poll.id,user.email).first());
  return false;
}

// Poll state machine (M1). status is the authoritative state machine value.
// 0 draft, 1 scheduled, 2 open, 3 paused, 4 closed, 5 archived.
const ALLOWED_TRANSITIONS = {
  draft: ['draft', 'scheduled', 'open'],
  scheduled: ['scheduled', 'open', 'closed', 'draft'],
  open: ['open', 'paused', 'closed', 'archived'],
  paused: ['paused', 'open', 'closed'],
  closed: ['closed', 'archived'],
  archived: ['archived']
};
function effectiveStatus(p) {
  if(['paused','closed','archived','draft'].includes(p.status)) return p.status;
  const now=Date.now(); const start=p.start_at?Date.parse(p.start_at):null; const end=p.end_at?Date.parse(p.end_at):null;
  if(end&&now>=end)return'closed'; if(start&&now<start)return'scheduled'; if(p.status==='scheduled'&&!start)return'scheduled'; return p.status==='scheduled'?'open':p.status;
}

// M1: validate a poll state transition. Throws {code,status} when forbidden.
async function assertTransition(env, poll, fromStatus, toStatus, user) {
  if (fromStatus === toStatus) return;
  const allowed = ALLOWED_TRANSITIONS[fromStatus];
  if (!allowed || !allowed.includes(toStatus)) {
    throw { code: 'invalid_transition', status: 409,
      detail: `cannot go from ${fromStatus} to ${toStatus}` };
  }
  // Record the transition immutably (store status strings for readability).
  await env.DB.prepare('INSERT INTO poll_state_transitions(poll_id,from_state,to_state,by_uid,by_email,version) VALUES(?,?,?,?,?,?)')
    .bind(poll.id, poll.status, toStatus, user?.uid ?? null, user?.email ?? null, (poll.version || 1) + 1).run();
}

// M1: freeze poll rules + options into poll_version_locks once first vote arrives.
async function freezePollRules(env, poll) {
  if (poll.options_frozen_at) return;
  const opts = await getOptions(env, poll.id);
  const snapshot = JSON.stringify({
    vote_mode: poll.vote_mode, max_votes: poll.max_votes,
    require_all_votes: !!poll.require_all_votes, allow_change: !!poll.allow_change,
    options: opts.map(o => ({ id: o.id, code: o.code, label: o.label }))
  });
  await env.DB.prepare('UPDATE polls SET options_frozen_at=? , version=version+1 WHERE id=?').bind(new Date().toISOString(), poll.id).run();
  await env.DB.prepare('INSERT OR REPLACE INTO poll_version_locks(poll_id,version,rule_snapshot) VALUES(?,?,?)')
    .bind(poll.id, (poll.version || 1) + 1, snapshot).run();
}

// M1: snapshot closed results immutably.
async function snapshotCloseResults(env, poll) {
  try {
    const opts = await getOptions(env, poll.id);
    // M4-01: backfill + aggregate in SQL (same path as getResults) so the
    // closed snapshot is computed from ballot_choices, not choice_json.
    await backfillBallotChoices(env, poll.id);
    const counts = Object.fromEntries(opts.map(o => [o.id, 0]));
    const agg = await env.DB.prepare('SELECT option_id, SUM(votes) AS votes FROM ballot_choices WHERE poll_id=? GROUP BY option_id').bind(poll.id).all();
    let totalBallots = 0;
    for (const r of agg.results || []) {
      if (counts[r.option_id] !== undefined) { counts[r.option_id] = Number(r.votes || 0); }
    }
    const totalBallotsRow = await env.DB.prepare('SELECT COUNT(*) n FROM participation WHERE poll_id=?').bind(poll.id).first();
    totalBallots = Number(totalBallotsRow?.n || 0);
    const results = opts.map(o => ({ id: o.id, code: o.code, label: o.label, votes: counts[o.id] || 0 }));
    const snapshot = JSON.stringify({ poll_id: poll.id, status: 'closed', results, at: new Date().toISOString() });
    await env.DB.prepare('INSERT OR REPLACE INTO poll_result_snapshots(poll_id,snapshot,created_at) VALUES(?,?,?)')
      .bind(poll.id, snapshot, new Date().toISOString()).run();
  } catch (e) { await audit(env, poll.id, { uid: null, email: null }, 'snapshot_close_failed', { error: String(e) }); }
}

function normalizeChoices(raw){
  if(!Array.isArray(raw))return[];
  const map=new Map();
  for(const item of raw){ const optionId=String(item?.optionId||''); const votes=Number(item?.votes||1); if(!optionId||!Number.isInteger(votes)||votes<1)continue; map.set(optionId,(map.get(optionId)||0)+votes); }
  return [...map.entries()].map(([optionId,votes])=>({optionId,votes}));
}
function validateChoices(poll,opts,choices){
  if(!choices.length)return'no_choice'; const valid=new Set(opts.map(o=>o.id)); if(choices.some(c=>!valid.has(c.optionId)))return'invalid_option';
  const total=choices.reduce((s,c)=>s+c.votes,0);
  if(poll.vote_mode==='single'&&(choices.length!==1||total!==1))return'single_requires_one_choice';
  if(poll.vote_mode==='multiple'){ if(choices.some(c=>c.votes!==1))return'multiple_no_duplicate_votes'; if(choices.length>poll.max_votes)return'too_many_choices'; if(poll.require_all_votes&&choices.length!==poll.max_votes)return'must_use_all_votes'; }
  if(poll.vote_mode==='allocate'){ if(total>poll.max_votes)return'too_many_votes'; if(poll.require_all_votes&&total!==poll.max_votes)return'must_use_all_votes'; }
  return null;
}

async function getEligibleCount(env,poll){
  if(poll.eligibility_mode==='whitelist'){ const r=await env.DB.prepare('SELECT COUNT(*) n FROM whitelist WHERE poll_id=?').bind(poll.id).first(); return Number(r?.n||0); }
  if(poll.eligibility_mode==='public'||poll.eligibility_mode==='domain') return null;
  return null;
}
function calculateQuorum(poll,participants,eligible){
  if(poll.quorum_type==='none')return{configured:false,met:true};
  if(poll.quorum_type==='count'){const required=Number(poll.quorum_value||0);return{configured:true,type:'count',required,actual:participants,met:participants>=required};}
  if(poll.quorum_type==='percent'){if(!eligible)return{configured:true,type:'percent',required:Number(poll.quorum_value||0),actual:null,met:null,reason:'eligible_count_unknown'}; const actual=eligible?participants/eligible*100:0;return{configured:true,type:'percent',required:Number(poll.quorum_value||0),actual:Number(actual.toFixed(2)),met:actual>=Number(poll.quorum_value||0)};}
}
function calculateApproval(poll,votes,participants,totalVotes){
  const type=poll.approval_type; if(type==='none')return null; const base=poll.vote_mode==='allocate'?totalVotes:participants; const pct=base?votes/base*100:0;
  if(type==='gt50')return pct>50; if(type==='gte50')return pct>=50; if(type==='two_thirds')return pct>=66.6666667; if(type==='percent')return pct>=Number(poll.approval_value||0); if(type==='count')return votes>=Number(poll.approval_value||0); return null;
}

async function audit(env,pollId,user,action,detail){
  let actorUid = user?.uid ?? null;
  let actorEmail = user?.email ?? null;
  // M3-06: for anonymous polls, don't record actor identity in the audit log.
  try {
    const poll = await env.DB.prepare('SELECT anonymity FROM polls WHERE id=?').bind(pollId).first();
    if (poll && poll.anonymity === 'anonymous') { actorUid = null; actorEmail = null; }
  } catch (e) {}
  await env.DB.prepare('INSERT INTO audit_logs(poll_id,actor_uid,actor_email,action,detail_json) VALUES(?,?,?,?,?)').bind(pollId,actorUid,actorEmail,action,JSON.stringify(detail||{})).run();
}
function normalizeEmail(v){const e=String(v||'').trim().toLowerCase();return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)?e:null;}
function safeJson(v,fallback){try{return JSON.parse(v)}catch{return fallback}}
function b(v){return v?1:0;}
function toCsv(headers,rows){return [headers,...rows].map(row=>row.map(csvCell).join(',')).join('\r\n');}
function csvCell(v){const s=String(v??''); if(/^[\+@=\-]/.test(s)) return "'"+s; return /[",\r\n]/.test(s)?`"${s.replace(/"/g,'""')}"`:s;}
