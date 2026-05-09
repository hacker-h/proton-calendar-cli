# Contributing

Run the local contribution gate before opening a pull request:

```bash
pnpm install --frozen-lockfile
pnpm run ci:local
```

Pull requests should not require Proton credentials. Use mocked/unit tests for normal changes. Live Proton checks are reserved for scheduled/manual canaries because they spend quota and can fail due to Proton-side auth challenges or backend drift.

Before `pnpm run sync:github-secrets`, run `git-crypt unlock` so `encrypted/local-live.env` is plaintext.

Never commit files from `secrets/`, `.tmp/`, `.sisyphus/`, browser profiles, or raw CI artifacts.
