# Known limitations

1. **Anonymous is administrative, not cryptographic anonymity.** The normal API/UI does not reveal voter-to-choice mapping, but an infrastructure owner with direct D1 access can correlate internal records because change-vote support requires an internal ballot reference.
2. **One person = one Google account, not one physical person.** A person with multiple eligible Google accounts can vote once per eligible account unless you use a whitelist tied to one approved email per person.
3. **Percent quorum requires whitelist mode.** Public and domain modes do not provide a known total eligible population, so use a fixed-count quorum there.
4. **No automatic Google Workspace directory count.** The app validates the email domain but does not query an organization's directory.
5. **No images/files.** Candidate options are text-only by design.
6. **Provider free tiers may change.** The project is designed for current free tiers; verify limits before a large event.
7. **No cryptographic election guarantees.** Do not use this implementation for governmental elections or other high-stakes secret-ballot elections without independent security review and a purpose-built verifiable voting protocol.
