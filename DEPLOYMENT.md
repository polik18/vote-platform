# Deployment guide

This guide keeps the frontend on GitHub Pages and uses free-tier Firebase Authentication + Cloudflare Workers/D1.

## 1. Firebase: Google login

1. Open Firebase Console and create a project.
2. Go to **Authentication → Sign-in method**.
3. Enable **Google**.
4. Go to **Project settings → Your apps → Web app** and create a web app.
5. Copy the web config into `frontend/src/config.js`:

```js
firebase: {
  apiKey: '...',
  authDomain: 'YOUR_PROJECT.firebaseapp.com',
  projectId: 'YOUR_PROJECT',
  appId: '...'
}
```

6. In Authentication settings, add your final GitHub Pages host to authorized domains. Example:
   - `YOUR_GITHUB_USERNAME.github.io`
   - If using a custom domain, also add that domain.

Do not create or expose a Firebase service-account private key for this project.

## 2. Cloudflare: Worker + D1

Install dependencies:

```bash
cd worker
npm install
npx wrangler login
```

Create D1:

```bash
npx wrangler d1 create vote-platform-db
```

Cloudflare returns a `database_id`. Copy:

```bash
cp wrangler.toml.example wrangler.toml
```

Edit `wrangler.toml`:

```toml
FIREBASE_PROJECT_ID = "the same Firebase projectId"
SUPER_ADMIN_EMAIL = "your-google-account@example.com"
ALLOWED_ORIGINS = "http://localhost:5173,https://YOUR_GITHUB_USERNAME.github.io"

database_id = "the D1 id returned by Cloudflare"
```

Apply schema:

```bash
npx wrangler d1 migrations apply vote-platform-db --remote
```

Deploy API:

```bash
npm run deploy
```

Wrangler prints a URL similar to:

```text
https://vote-platform-api.YOUR_SUBDOMAIN.workers.dev
```

Put it in `frontend/src/config.js`:

```js
apiBase: 'https://vote-platform-api.YOUR_SUBDOMAIN.workers.dev/api'
```

## 3. Test locally

```bash
cd frontend
npm install
npm run dev
```

Open the Vite URL, usually `http://localhost:5173`.

Test:
- Google login
- Super Admin role
- Add another admin
- Create a draft poll
- Open it
- Vote using another Google account
- Try duplicate voting
- Test named and anonymous polls
- Import a CSV whitelist
- Export results

## 4. Deploy to GitHub Pages

Create a GitHub repository and put this entire project at its root.

Commit and push to `main`.

In GitHub:

1. **Settings → Pages**
2. Set **Source** to **GitHub Actions**.
3. Push to `main` or manually run **Deploy GitHub Pages**.

The included workflow builds `frontend/` and deploys `frontend/dist`.

After you know the final Pages URL, confirm the host is present in:
- Firebase Authentication authorized domains
- Worker `ALLOWED_ORIGINS`

Redeploy the Worker if you change `ALLOWED_ORIGINS`.

## 5. First administrator setup

`SUPER_ADMIN_EMAIL` is authoritative. Sign in to the website with that exact Google email.

Open **管理員** to add other administrator emails. They become Admin when they sign in with the matching Google account.

## 6. Recommended pre-event test

Before a real 300-person vote:

1. Create a copy of the final poll.
2. Use 5–10 different test accounts.
3. Verify whitelist/domain behavior.
4. Verify first-ballot rule locking.
5. Verify result visibility before/after closing.
6. Verify CSV exports in Excel/Google Sheets.
7. Check mobile layout.
8. Close the test poll and confirm it cannot accept votes.

## 7. Time handling

Times are stored as ISO UTC timestamps and rendered in each browser's local timezone. For Taiwan users this normally displays Asia/Taipei time automatically.

## 8. Cost control

This source uses only free-plan-compatible services. Do not upgrade Cloudflare or Firebase billing unless you intentionally want paid capacity. Provider free-tier limits are not contractual and can change; check them before a large deployment.
