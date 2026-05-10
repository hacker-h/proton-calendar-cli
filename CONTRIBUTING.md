# Contributing

Run the local contribution gate before opening a pull request:

```bash
pnpm install --frozen-lockfile
pnpm run ci:local
```

The local gate starts with `pnpm run check:toolchain`, which verifies the Node engine, the exact `packageManager` pnpm version, and the browser/cookie/crypto dependency metadata used by login automation. Use the pinned pnpm from `package.json`; do not update the lockfile with a different package manager version.

For dependency maintenance, run:

```bash
pnpm run check:toolchain
pnpm run check:browser
pnpm outdated
```

When updating Playwright, Chrome/browser automation, `@steipete/sweet-cookie`, or `openpgp`, keep PR CI credential-free and use mocked tests first. Run live Proton canaries only through the scheduled/manual workflow with dedicated credentials, then check the dependency health artifact for outdated packages and browser install drift. For native cookie dependency updates, rerun `pnpm approve-builds` and review `pnpm-workspace.yaml` so approved build packages stay intentional.

Pull requests should not require Proton credentials. Use mocked/unit tests for normal changes. Live Proton checks are reserved for scheduled/manual canaries because they spend quota and can fail due to Proton-side auth challenges or backend drift. To reproduce the canary locally with dedicated credentials, set `PROTON_USERNAME`, `PROTON_PASSWORD`, and optional `PROTON_TEST_CALENDAR_ID`, then run `pnpm run ci:live`; it bootstraps cookies, writes `secrets/ci-live.env`, starts the local API, and runs `pnpm run test:live`.

Never commit files from `secrets/`, `.tmp/`, `.sisyphus/`, browser profiles, or raw CI artifacts.

Run `git-crypt unlock` before `pnpm run sync:github-secrets`; the sync script refuses locked `encrypted/local-live.env` files before touching GitHub secrets.
