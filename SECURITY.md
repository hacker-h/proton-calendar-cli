# Security Policy

This project is an unofficial Proton Calendar automation tool. Proton Calendar does not provide a stable public API contract for this use case, so upstream behavior can change without notice.

## Secrets

- Keep generated cookie bundles, API tokens, and runtime env files under `secrets/` or `.tmp/` only.
- Keep cross-machine local credentials under `encrypted/` only when `git-crypt` is unlocked and intentionally configured.
- Do not commit plaintext credentials, exported cookie bundles, browser profiles, or CI env files.
- Store CI credentials as GitHub Actions repository secrets or GitLab protected, masked CI/CD variables.

## Reporting Issues

Please report vulnerabilities privately through GitHub security advisories when available. Do not include live Proton cookies, passwords, session blobs, or full upstream responses in public issues.

## CI Safety

Pull-request CI must stay no-quota and credential-free. Live Proton canaries should run only on scheduled/manual workflows using a dedicated empty test account and sanitized logs.

GitLab live credentials must be protected and masked, and live jobs must run only on protected runners/branches. Do not upload cookie bundles, generated `ci-live.env` files, browser profiles, or API bearer tokens as artifacts. Keep unavoidable CI artifacts limited to sanitized reports such as JUnit XML with short expiration.
