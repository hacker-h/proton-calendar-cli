# Security Policy

This project is an unofficial Proton Calendar automation tool. Proton Calendar does not provide a stable public API contract for this use case, so upstream behavior can change without notice.

## Secrets

- Keep generated cookie bundles, API tokens, and runtime env files under `secrets/` or `.tmp/` only.
- A repo-local `.env` file is allowed only for ProtonMail-style local CLI compatibility. Keep it gitignored, machine-local, and owner-only readable/writable, for example `0600`; the CLI rejects unsafe permissions before loading it.
- Keep cross-machine local credentials under `encrypted/` only when `git-crypt` is unlocked and intentionally configured.
- Do not commit plaintext credentials, exported cookie bundles, browser profiles, or CI env files.
- Store CI credentials as GitHub Actions repository secrets or GitLab protected, masked CI/CD variables.
- Store second-account live test credentials as `PROTON_USERNAME2` and `PROTON_PASSWORD2` secrets only; enable their tests with explicit `PROTON_LIVE_ENABLE_SECOND_ACCOUNT=1` plus a feature gate.

## Reporting Issues

Please report vulnerabilities privately through GitHub security advisories when available. Do not include live Proton cookies, passwords, session blobs, or full upstream responses in public issues.

## CI Safety

Pull-request CI must stay no-quota and credential-free. Live Proton canaries should run only on scheduled/manual workflows using a dedicated empty test account and sanitized logs.

GitLab live credentials must be protected and masked, and live jobs must run only on protected runners/branches. Do not upload cookie bundles, generated `ci-live.env` files, browser profiles, or API bearer tokens as artifacts. Keep unavoidable CI artifacts limited to sanitized reports such as JUnit XML with short expiration.

Live canary triage and drift reports may be uploaded only when they contain sanitized failure class, stage, command, surface, endpoint, schema-shape, owner, expiry, and next-action metadata. Quarantine manifests must be time-bounded and must not contain raw Proton responses, cookie values, generated env files, bearer tokens, event contents, or browser profile data.
