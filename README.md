# Vote Platform

A reusable voting platform designed for **300+ Google-account users** while staying within free-tier services for small deployments.

## Architecture

- **GitHub Pages** — static frontend (Vite)
- **Firebase Authentication** — Google Sign-In only
- **Cloudflare Worker** — trusted voting API and authorization layer
- **Cloudflare D1** — poll, participant, ballot, admin and audit data

No privileged secret is stored in the browser.

## Features

### Roles
- **Super Admin**: configured through `SUPER_ADMIN_EMAIL`; manages all polls and admins.
- **Admin**: appointed by Super Admin using Google email; can only manage polls they created.
- **Voter**: any authenticated Google account that satisfies the selected eligibility rule.

### Eligibility
Per poll:
- Public Google account
- Email whitelist (manual paste or CSV import)
- Specified Google/Workspace email domain

### Ballot identity
- Named poll
- Anonymous poll: admin can see who participated but normal APIs do not expose who selected which option.

See `SECURITY.md` for the anonymity boundary.

### Vote modes
- `single`: one option / one vote
- `multiple`: choose up to N distinct options
- `allocate`: N votes can be distributed, including multiple votes to the same option

Each poll can require all votes to be used or allow unused votes.

### Lifecycle
`draft → scheduled → open ↔ paused → closed → archived`

Polls with no votes may be deleted. Once a valid vote exists, core rules are locked and the poll must be archived instead of deleted.

### Result controls
- live/public
- visible after a voter submits
- visible after closing
- admin only

Supports vote totals, percentages, ranking, quorum and approval thresholds.

### Exports
- participant CSV
- named-vote CSV for named polls
- result CSV

## Free-tier sizing

As of September 2026, Cloudflare Workers Free provides 100,000 requests/day and D1 Free provides 5 million rows read/day, 100,000 rows written/day and 5 GB account storage. A 300-person poll is tiny relative to those limits when queries remain indexed.

Free-tier limits can change. Always check the current provider pages before a large event.

## Quick deployment

Read `DEPLOYMENT.md` for the full setup. In short:

1. Create a Firebase project and enable Google sign-in.
2. Add your GitHub Pages domain to Firebase authorized domains.
3. Create a Cloudflare D1 database.
4. Deploy the Worker with the Firebase project ID, Super Admin email and allowed frontend origins.
5. Put your Firebase web configuration + Worker URL in `frontend/src/config.js`.
6. Push the repository to GitHub and enable GitHub Pages via GitHub Actions.

## CSV whitelist format

```csv
email,name
alice@example.com,Alice
bob@example.com,Bob
```

`name` is optional. A one-column `email` CSV also works.

## Important behavior

- One Firebase UID can have only one participation record per poll.
- If `allowChange=false`, a second submission is rejected.
- If `allowChange=true`, the previous ballot is replaced until closing.
- For anonymous polls, the normal participant endpoint contains identity and turnout only, never choices.
- A poll's core voting rules and options become immutable after its first valid ballot.

## Local development

Frontend:

```bash
cd frontend
npm install
npm run dev
```

Worker:

```bash
cd worker
cp wrangler.toml.example wrangler.toml
npm install
npx wrangler d1 migrations apply vote-platform-db --local
npm run dev
```

Add `http://localhost:5173` to `ALLOWED_ORIGINS`.
