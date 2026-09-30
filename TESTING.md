# Acceptance test checklist

## Authentication and roles
- [ ] A normal Google account signs in and receives voter role.
- [ ] `SUPER_ADMIN_EMAIL` receives super_admin role.
- [ ] Super Admin can add an Admin email.
- [ ] Added Admin can sign in and create a poll.
- [ ] Admin A cannot manage Admin B's poll.
- [ ] Super Admin can manage both.

## Eligibility
- [ ] Public poll accepts any authenticated Google account.
- [ ] Whitelist poll accepts listed emails and rejects unlisted emails.
- [ ] Domain poll accepts the configured domain and rejects other domains.
- [ ] CSV whitelist import handles at least 300 rows.

## Vote modes
- [ ] Single mode accepts exactly one option.
- [ ] Multiple mode rejects more than N distinct choices.
- [ ] Multiple + require-all rejects fewer than N choices.
- [ ] Allocate mode permits multiple votes on one option.
- [ ] Allocate mode rejects totals over N.
- [ ] Allocate + require-all rejects totals below N.

## Duplicate voting and changes
- [ ] `allowChange=false`: second submission is rejected.
- [ ] `allowChange=true`: second submission replaces the first ballot.
- [ ] A closed/paused/draft poll rejects voting.

## Named / anonymous
- [ ] Named vote export contains voter email/name + choices.
- [ ] Anonymous participant view contains identity and turnout only.
- [ ] Anonymous result view contains aggregated choices only.
- [ ] Anonymous named-vote export is refused.

## Locking and deletion
- [ ] Before first vote, options and core voting rules can be edited.
- [ ] After first vote, options/core rules are locked.
- [ ] Poll with zero votes can be deleted.
- [ ] Poll with votes cannot be deleted and can be archived.

## Results
- [ ] public results are viewable while open.
- [ ] after_vote results require participation.
- [ ] after_close results are hidden until closed.
- [ ] admin_only results are hidden from voters.
- [ ] Quorum count mode works.
- [ ] Quorum percent mode works for whitelist polls.
- [ ] Approval thresholds calculate as configured.

## Load smoke test
For a 300-user event, simulate requests against a staging poll rather than the production poll. At minimum test:
- 300 participant records
- 300 ballots
- result aggregation
- participant CSV export
- no full-table scan regressions in common paths
