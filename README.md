# proton-calendar-cli

Goal: a full-featured personal automation command-line tool for Proton Calendar.

`pc` lets you log in, list events, create events, patch only the fields you change, and delete events from Proton Calendar. It also supports multi-calendar routing, recurring events, scoped recurrence edits, and JSON output for automation.

This is unofficial. Proton does not provide a stable public Calendar API for this use case, so the CLI uses a local API bridge backed by a browser-login cookie bundle in `secrets/`.

## Quickstart

```bash
pnpm approve-builds
pnpm install
pnpm add -g .
pc login
source secrets/pc-server.env
pnpm start
```

In another shell:

```bash
pc doctor auth
pc ls
pc new title="Design review" start=2026-03-10T10:00:00Z end=2026-03-10T10:30:00Z timezone=UTC
```

`pc login` opens Chrome for Proton sign-in, exports cookies/session data, generates a local API token, and writes:

- `secrets/proton-cookies.json`
- `secrets/pc-cli.json`
- `secrets/pc-server.env`

The generated API token is written only to the local config/env files; it is not printed in normal `pc login` output.

Secret files are expected to be owner-only readable/writable on POSIX systems, for example `0600`. The CLI and API reject unsafe group/world-readable cookie bundles and local config files with `SECRET_FILE_UNSAFE_PERMISSIONS` before using them.

To remove local generated secrets without deleting the parent `secrets/` directory or browser profiles, run:

```bash
pc logout
```

`pc logout` removes the configured/default CLI config, server env file, cookie bundle, and known relogin sidecars, reporting files that were already missing.

`pnpm add -g .` registers this checkout's package bin so `pc` is available on your `PATH`. If `pc` is not found, check `pnpm bin -g` and run `pnpm setup` if pnpm has not configured `PNPM_HOME` yet. Local development fallback: `pnpm pc -- <command>` or `node src/cli.js <command>`.

## Commands

| Command | Purpose | Example |
| --- | --- | --- |
| `pc login` | Browser login, cookie export, CLI/server config generation | `pc login --default-calendar cal_123` |
| `pc logout` | Remove local CLI/server/cookie secret files and relogin sidecars | `pc logout` |
| `pc doctor auth` | Check whether the saved Proton session works or can refresh | `pc doctor auth` |
| `pc calendars` | List discovered calendars and configured defaults | `pc calendars -o table` |
| `pc ls` | List events; defaults to current ISO week | `pc ls w++ --title review` |
| `pc new` | Create an event from `field=value` pairs | `pc new title="Demo" start=2026-03-10T10:00:00Z end=2026-03-10T10:30:00Z timezone=UTC` |
| `pc edit` | PATCH-style update; only provided fields are sent | `pc edit evt-1 title="Updated" --clear description` |
| `pc rm` | Delete an event or recurring scope | `pc rm evt-1 --scope series` |

Useful list examples:

```bash
pc ls                              # current week
pc ls w+                           # current and next week
pc ls w++                          # current and next two weeks
pc ls m 7 2026                     # month
pc ls y 2026                       # year
pc ls --from 2026-07-01 --to 2026-07-31
pc ls --protected
pc ls --unprotected
pc ls --title review --location "room b"
pc ls -o table
```

Supported event fields:

- `title`
- `description`
- `location`
- `start` and `end` as ISO datetimes, or date-only values for all-day events
- `timezone`
- `allDay`
- `protected` (defaults to `true`; set `false` to allow shared-calendar members to edit)
- `recurrence` with `freq`, `interval`, `count`, `until`, `byDay`, `byMonthDay`, `weekStart`, `exDates`

For monthly recurrence, `byDay` supports weekdays such as `MO` and ordinal weekdays such as `+1MO`, `2TU`, and `-1FR` for every Monday, the first Monday, second Tuesday, and last Friday of each month. Combine `byDay` with `byMonthDay` to match dates such as Friday the 13th. Months without the requested ordinal weekday are skipped.

Recurring event scopes are `series`, `single`, and `following`. `single` and `following` require an occurrence start:

```bash
pc edit evt-series --scope single --at 2026-03-12T09:00:00Z title="One-off"
pc rm evt-series --scope following --at 2026-03-12T09:00:00Z
```

Notes:

- Output defaults to JSON. Use `-o table` for human-readable list output.
- `pc edit` is PATCH-style: omitted fields are not sent.
- `pc edit --clear` currently supports `description` and `location`.
- Supported recurrence frequencies are `DAILY`, `WEEKLY`, `MONTHLY`, and `YEARLY`.
- Recurrence expansion evaluates at most 50,000 candidates by default; set `RECURRENCE_MAX_ITERATIONS` on the API server to tune that safety cap. If the cap is exhausted, the API returns `RECURRENCE_ITERATION_LIMIT` instead of a partial recurrence list.

## Configuration And Auth

CLI config is read from `secrets/pc-cli.json` by default:

```json
{
  "apiBaseUrl": "http://127.0.0.1:8787",
  "apiToken": "replace-me"
}
```

Environment overrides:

```bash
export PC_CONFIG_PATH=/absolute/path/to/pc-cli.json
export PC_API_BASE_URL=http://127.0.0.1:8787
export PC_API_TOKEN=replace-me
```

The local API server requires a bearer token and calendar scope. `pc login` generates these in `secrets/pc-server.env`; manual setup needs at least:

```bash
export API_BEARER_TOKEN=replace-me
export COOKIE_BUNDLE_PATH=secrets/proton-cookies.json
export TARGET_CALENDAR_ID=cal_123
# or: export ALLOWED_CALENDAR_IDS=cal_123,cal_456
# optional: export DEFAULT_CALENDAR_ID=cal_123
```

Run `pc calendars` after the API server is running to see the calendars visible to the saved Proton session and which one is configured as default or target. `pc login --default-calendar cal_123` writes `DEFAULT_CALENDAR_ID` and allows all calendars discovered during login. `pc login --target-calendar cal_123` preserves the hard-lock mode for automations that must never mutate another calendar.

`TARGET_CALENDAR_ID` hard-locks all requests to one calendar. Without it, `ALLOWED_CALENDAR_IDS` controls explicit calendar routes and `DEFAULT_CALENDAR_ID` is used for plain event commands.

On Proton `401`/`403`, the server tries to refresh auth from saved `REFRESH-*` cookies and persists returned `Set-Cookie` headers back to the cookie bundle.

Runtime browser relogin is available but disabled by the generated env file. Enable it only for unattended workers that need recovery beyond cookie refresh:

```bash
export PROTON_AUTO_RELOGIN=1
export PROTON_RELOGIN_MODE=headless
export PROTON_RELOGIN_COOLDOWN_MS=300000
export PROTON_RELOGIN_LOCK_PATH=secrets/proton-cookies.json.relogin.lock
```

The lock prevents multiple processes from opening Chrome at once; the cooldown avoids repeated failed relogin attempts.

## Automation Contract

Automation callers should treat `pc` as a JSON command surface with private-API risk:

- Success output goes to stdout as `{ "data": ... }`.
- Error output goes to stderr as `{ "error": { "code", "message", "details" } }`.
- `error.code` is the stable key for scripts; `error.message` is for humans.
- Passwords, cookie values, refresh tokens, session blobs, bearer tokens, and raw Proton payloads must not appear in normal output, logs, or CI artifacts.
- Use `--output json` or `-o json` in scripts, even though JSON is the default today.
- Run `pc doctor auth --fail-on-relogin-required` before unattended jobs so stale cookies, relogin needs, and local API problems fail before mutations.
- Prefer short date ranges and explicit calendar scope; avoid broad polling loops that repeatedly decode the same private API payloads.
- Use `X-Idempotency-Key` for HTTP API mutation retries when available; the CLI does not expose an idempotency flag yet, so retry CLI mutations only after checking whether the event already changed.
- Back off on auth challenges, rate limits, `Retry-After`, captcha, or human-verification states. Do not loop through repeated browser logins.
- Treat Proton private API shape drift as expected operational failure. Alert, preserve sanitized logs, and require human triage instead of silently continuing.

Exit codes:

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | Current general failure code |
| `2` | Reserved for validation or usage failure |
| `3` | Reserved for auth/session failure |
| `4` | Reserved for local API unavailable |
| `5` | Reserved for Proton upstream failure |
| `6` | Reserved for unsupported private-API state or login challenge |

Current commands return `1` for all failures; future behavior should move toward the narrower reserved codes without changing the JSON envelopes.


## Automation Guardrails

`pc` is best suited for personal or small-team automation where failures can be inspected quickly. Do not rely on it as a stable public SaaS integration contract. Proton can require new interactive login steps, change private endpoints, throttle requests, or reject saved browser sessions.

Recommended CI/CD pattern:

```bash
set -euo pipefail
pc doctor auth -o json --fail-on-relogin-required
pc ls --from 2026-07-01 --to 2026-07-07 -o json
pc new title="Deploy window" start=2026-07-02T10:00:00Z end=2026-07-02T10:30:00Z timezone=UTC -o json
```

For noninteractive jobs, prefer:

```bash
pc doctor auth -o json --fail-on-relogin-required
```

`pc doctor auth` emits stable JSON fields for automation: `status`, `automationReady`, `reloginRequired`, `refreshPossible`, `refreshAttempted`, `refreshSucceeded`, and `nextStep.code`. Treat `automationReady: false` or `AUTH_RELOGIN_REQUIRED` as a hard stop before mutations. Current status values are `access_valid`, `refresh_recovered`, `refresh_failed`, and `refresh_unavailable`.

Operational defaults:

- Use a dedicated Proton calendar/account for automation when possible.
- Keep date windows small and bounded; do not scan whole calendars on every run.
- Keep secrets under `secrets/` or CI secret storage and never upload cookie bundles as artifacts.
- Fail closed when output is not valid JSON or when `error.code` is unknown.
- For scheduled jobs, add exponential backoff and notify a human after the first auth or private-API drift failure.
- Keep live Proton checks separate from required pull-request CI unless the runner has dedicated credentials and safe cleanup.

## Development

```bash
pnpm test              # mocked/unit suite
pnpm run test:unit:junit # mocked/unit suite with reports/junit.xml
pnpm run ci:local      # unit suite + package/bin smoke
pnpm test:live:api     # requires live Proton env/session
pnpm test:live:cli     # requires live Proton env/session
```

Pull-request CI runs the required no-quota local gate: frozen pnpm install, mocked unit tests with an uploaded JUnit report, and the packaged `pc` binary smoke. The package smoke packs this checkout, verifies required package files and Node engine metadata, installs the tarball with engine checks enabled, and then runs `pc --help` plus a JSON config-error path from the installed package.

The live Proton canary is optional and runs only for `workflow_dispatch` or the weekly schedule. It installs Chromium, checks for dedicated `PROTON_USERNAME` and `PROTON_PASSWORD` secrets, bootstraps a temporary cookie bundle, and then runs live tests. Pull requests do not require these secrets or the live canary.

## Releases

Releases are automated from the GitHub `main` branch with semantic-release.
Merge Conventional Commit messages such as `feat: ...`, `fix: ...`, or
`feat!: ...` to `main` to create the next GitHub release and `v<version>` tag.

semantic-release also updates `CHANGELOG.md` and commits that changelog update
back to `main` with `[skip ci]`. npm publishing is not enabled; add the npm
plugin and npm credentials separately if package publishing is needed later.

Local release checks:

```bash
pnpm run ci:local
pnpm run release:dry-run
```

## Current Limitations

- Requires a local API server; normal event commands do not talk directly to Proton.
- Uses unofficial private Proton endpoints that can change without a compatibility window.
- Login/bootstrap depends on Chrome and local cookie/session export.
- Browser login can stop on 2FA, captcha, human-verification, locked-account, or changed-UI states.
- Rate limits and `Retry-After` behavior are controlled by Proton and should stop automation until backoff expires.
- `recurrence.count` and `recurrence.until` cannot both be set.
- No attendee invitation flow, RSVP state, reminder controls, conference metadata, attachments, categories/tags, or arbitrary ICS passthrough yet.
- Live tests require a Proton account and calendar suitable for automated cleanup.

## License

MIT. See [LICENSE](LICENSE).
