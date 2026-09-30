# Security notes

## Authentication
All API requests require a Firebase ID token. The Worker verifies the token signature, issuer and audience against Firebase/Google public keys.

## Authorization
- `SUPER_ADMIN_EMAIL` is the global super administrator.
- Emails in the D1 `admins` table are administrators.
- Normal administrators can only manage polls where `owner_uid` equals their Firebase UID.
- Voting eligibility is checked server-side for public, whitelist and domain modes.

## Anonymous polls
For an anonymous poll, `ballots` do not contain the voter UID, email or name. `participation` stores who has participated, while `ballots` store choices. The API never returns a voter-to-choice mapping for anonymous polls.

This is **administrative anonymity, not cryptographic secret-ballot anonymity**. The `participation` record retains an internal `ballot_id` so the system can support "change vote before closing". An operator with direct D1 database access can therefore correlate a participant and ballot. If you require anonymity even from the infrastructure/database owner, use a cryptographic voting protocol and independent trust boundaries instead.

## Frontend configuration
Firebase web configuration is not a secret. Never place Cloudflare API tokens, Firebase service-account private keys, or other privileged credentials in the GitHub Pages repository.

## Operational recommendations
- Keep the GitHub repository public only if you are comfortable with the source being visible; the design assumes no secrets are stored in the frontend.
- Restrict `ALLOWED_ORIGINS` to your actual GitHub Pages origin and localhost during development.
- Use a dedicated Firebase project and Cloudflare D1 database for this platform.
- Review Cloudflare and Firebase account access periodically.
