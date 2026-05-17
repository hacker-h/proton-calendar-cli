# proton-calendar-cli

Goal: a full-featured personal automation command-line tool for Proton Calendar.

`pc` lets you log in, list events, create events, patch only the fields you change, and delete events from Proton Calendar. It also supports multi-calendar routing, recurring events, scoped recurrence edits, and JSON output for automation.

This is unofficial. Proton does not provide a stable public Calendar API for this use case, so the CLI uses a local API bridge backed by a browser-login cookie bundle in `secrets/`.

## Quickstart

Install the latest standalone `pc` CLI on Linux or macOS:

```bash
curl -fsSL https://raw.githubusercontent.com/hacker-h/proton-calendar-cli/main/scripts/install.sh | sh
pc --help
```

The installer downloads the matching GitHub release binary, verifies its sibling
`.sha256` file, smoke-checks `pc --help`, and installs to
`${XDG_BIN_HOME:-$HOME/.local/bin}` unless `PC_INSTALL_DIR` or `--dir` is set.
If `pc` is not found after installation, add the printed directory to your
`PATH`.

For a source checkout with the local API server:

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
| `pc update` | Check or replace a standalone release binary from GitHub Releases | `pc update --check` |
| `pc doctor auth` | Check whether the saved Proton session works or can refresh | `pc doctor auth` |
| `pc calendars` | List discovered calendars and configured defaults | `pc calendars -o table` |
| `pc ls` | List events; defaults to current ISO week | `pc ls next 7 --title review` |
| `pc export` | Export a bounded date range as local ICS from normalized events | `pc export --from 2026-07-01 --to 2026-07-31 > calendar.ics` |
| `pc import <file>` | Import a bounded local ICS file through normal event creation | `pc import calendar.ics` |
| `pc new` | Create an event from `field=value` pairs | `pc new title="Demo" start=2026-03-10T10:00:00Z end=2026-03-10T10:30:00Z timezone=UTC` |
| `pc edit` | PATCH-style update; only provided fields are sent | `pc edit evt-1 title="Updated" --clear description` |
| `pc rm` | Delete an event or recurring scope | `pc rm evt-1 --scope series` |

Useful list examples:

```bash
pc ls                              # current week
pc ls today                        # current UTC day
pc ls tomorrow                     # next UTC day
pc ls next 7                       # next seven UTC days, starting today
pc ls w+                           # current and next week
pc ls w++                          # current and next two weeks
pc ls m 7 2026                     # month
pc ls y 2026                       # year
pc ls --from 2026-07-01 --to 2026-07-31
pc ls --protected
pc ls --unprotected
pc ls --title review --location "room b"
pc ls next 7 --title review --protected
pc ls -o table
```

ICS import/export examples:

```bash
pc export --from 2026-07-01 --to 2026-07-31 > july.ics
pc export --calendar cal_123 --start 2026-07-01T00:00:00Z --end 2026-08-01T00:00:00Z > july.ics
pc import july.ics
pc import --calendar cal_123 july.ics
```

ICS support is intentionally bounded and local-API based. Export serializes the normalized events returned by `CalendarService.listEvents()`; import parses supported `VEVENT`s and creates each event through the same `CalendarService.createEvent()` path used by `pc new`. The implementation does not use or claim support for any official Proton import/export endpoint.

Supported ICS fields are `UID`, `SUMMARY`, `DESCRIPTION`, `LOCATION`, `DTSTART`, `DTEND`, all-day `VALUE=DATE`, UTC dates, `TZID` datetime values, and `RRULE` shapes already supported by the existing recurrence parser. `VTIMEZONE` components are accepted only as timezone metadata; unsupported components such as `VALARM` and unsupported `VEVENT` properties such as attendees, organizer/invite data, attachments, URLs, categories, and arbitrary passthrough fields are rejected with diagnostics before import mutations. File parsing is capped at 10 MB and 15000 events; this local create-event importer creates at most 50 events per request to avoid long-running private API mutation loops on free accounts.

Privacy note: ICS files contain event titles, descriptions, locations, and schedules in plain text. Keep exported files out of CI artifacts and shared logs unless you have reviewed the contents.

Supported event fields:

- `title`
- `description`
- `location`
- `start` and `end` as ISO datetimes, or date-only values for all-day events
- `timezone`
- `allDay`
- `protected` (defaults to `true`; set `false` to allow shared-calendar members to edit)
- `recurrence` with `freq`, `interval`, `count`, `until`, `byDay`, `byMonthDay`, `weekStart`, `exDates`
- `reminder` as a single friendly reminder such as `10m`, `1h`, or `2d`
- `reminders` as comma-separated friendly app reminders such as `10m,1h`
- `notifications` as `null` or an array of up to 10 Proton-compatible notification objects; omitted `pc edit`/PATCH fields preserve existing notifications, and `notifications=null` clears event-specific notifications

Friendly reminders compile to raw Proton notification objects before the API calls Proton: `reminder=10m` becomes `[{"Type":1,"Trigger":"-PT10M"}]`, and `reminders=10m,1h` becomes `[{"Type":1,"Trigger":"-PT10M"},{"Type":1,"Trigger":"-PT1H"}]`. Supported durations are positive integers with `m`, `h`, or `d`. Only default app reminders are supported in friendly syntax; channel-prefixed values such as `email:1h` are rejected because Proton rejected the generated Type 2 shape in live testing. Raw notification objects are still passed through to Proton, for example `notifications='[{"Type":1,"Trigger":"-PT10M"}]'`. Do not combine `reminder`/`reminders` with `notifications` in the same mutation. Use `notifications=null` or `pc edit --clear notifications` to clear event-specific reminders.

Attendee invitations remain a research/prototype boundary, not a supported API or CLI feature. Public Proton shared calendar code models real invitations as organizer-mode iCalendar operations with `METHOD:REQUEST` for create/update and `METHOD:CANCEL` for cancellation; sync payloads need `SharedKeyPacket`, `SharedEventContent`, `AttendeesEventContent`, clear `Attendees` token/status rows, `Permissions`, and `IsOrganizer`. The repository includes a disabled pure builder in `src/proton/internal/invite-prototype.js` to keep that payload shape under tests without sending invitations. The production event path still omits `ORGANIZER` and `ATTENDEE` because Proton treats organizer-bearing events as invitations and may make them read-only or send notifications.

Inbound mail invitations are also outside the current Calendar-only API bridge. Proton documents inbound ICS invites as a Proton Mail flow: the message arrives in Proton Mail, Proton auto-adds the invite to the default calendar, and the user can answer Yes/Maybe/No from Mail or Calendar; forwarded invitations cannot be answered from Proton Mail: <https://proton.me/support/add-event-from-inbox> and <https://proton.me/support/auto-add-invites>. Proton's manual ICS import is a separate Calendar settings flow, not RSVP-capable ingestion; Proton documents that imported event participants are unsupported and `.ics` imports have 10 MB / 15000-event limits: <https://proton.me/support/how-to-import-calendar-to-proton-calendar>. Because this project has no Proton Mail client, message search, attachment ingestion, or RSVP response endpoint, `PROTON_LIVE_ENABLE_INVITES` is reserved for future observed Mail-backed tests and stays opt-in with second-account credentials.

Conferencing, attachments, categories, and special calendars are explicit unsupported boundaries until their private API shapes can be observed safely. Proton's Meet docs describe encrypted Meet links generated by the web app, with optional auto-add only when an event has invitees: <https://proton.me/support/calendar-meet>. Proton's Zoom docs require a paid Proton plan, a Zoom account, and sometimes organization admin approval, so Zoom creation is not free-account-testable: <https://proton.me/support/calendar-zoom>. Appointment scheduling can use Proton Meet but is paid-plan gated, and non-Meet links are plain location text rather than auto-created Zoom metadata: <https://proton.me/support/calendar-appointment-scheduling>. Public holiday calendars are separate web/Android-managed calendars, count toward plan calendar quotas, and are not normal event fields: <https://proton.me/support/public-holiday-calendars>. The CLI therefore treats `URL`, `ATTACH`, `CATEGORIES`, `CONFERENCE`, organizer/attendee data, and arbitrary ICS passthrough as unsupported import fields instead of silently dropping or mutating them.

For monthly recurrence, `byDay` supports weekdays such as `MO` and ordinal weekdays such as `+1MO`, `2TU`, and `-1FR` for every Monday, the first Monday, second Tuesday, and last Friday of each month. Combine `byDay` with `byMonthDay` to match dates such as Friday the 13th. Months without the requested ordinal weekday are skipped.
For monthly `byMonthDay`, values past the end of a shorter month fall back to that month's last day, so a `31` rule emits Feb 28/29 and Apr 30 instead of silently skipping those months.

Recurring event scopes are `series`, `single`, and `following`. `single` and `following` require an occurrence start:

```bash
pc edit evt-series --scope single --at 2026-03-12T09:00:00Z title="One-off"
pc rm evt-series --scope following --at 2026-03-12T09:00:00Z
```

Notes:

- Output defaults to JSON. Use `-o table` for human-readable list output.
- `pc edit` is PATCH-style: omitted fields are not sent.
- `pc edit --clear` currently supports `description`, `location`, and `notifications`.
- `pc new --dry-run` and `pc edit --dry-run` validate arguments and print the JSON request preview without reading local API config or calling the API. Edit dry-runs preview the differential patch only; they do not fetch the existing event or verify that it exists.
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

`pc`, `pnpm start`, and the local live canary load an optional `.env` file from the current working directory, matching ProtonMail-style local CLI setup. Real shell environment variables take precedence over `.env` values. Keep `.env` local-only; it is ignored by git and must be owner-only readable/writable, for example `chmod 600 .env`. For ProtonMail-style credential names, `PROTONMAIL_USERNAME` and `PROTONMAIL_PASSWORD` are accepted as aliases for `PROTON_USERNAME` and `PROTON_PASSWORD`; `PROTONMAIL_USERNAME2` and `PROTONMAIL_PASSWORD2` map to `PROTON_USERNAME2` and `PROTON_PASSWORD2` for opt-in second-account live tests.

The local API server requires a bearer token and calendar scope. `pc login` generates these in `secrets/pc-server.env`; manual setup needs at least:

```bash
export API_BEARER_TOKEN=replace-me
export COOKIE_BUNDLE_PATH=secrets/proton-cookies.json
export TARGET_CALENDAR_ID=cal_123
# or: export ALLOWED_CALENDAR_IDS=cal_123,cal_456
# optional: export DEFAULT_CALENDAR_ID=cal_123
```

Run `pc calendars` after the API server is running to see the calendars visible to the saved Proton session and which one is configured as default or target. `pc login --default-calendar cal_123` writes `DEFAULT_CALENDAR_ID` and allows all calendars discovered during login. To change the local default later without re-running browser login, run `pc calendars --set-default cal_456 --server-env secrets/pc-server.env`, then restart the API server with the updated env file. `pc login --target-calendar cal_123` preserves the hard-lock mode for automations that must never mutate another calendar.

Supported issue #121 calendar management subset is intentionally non-destructive and free-account-safe. The local API can read and patch existing user calendar settings at `GET/PATCH /v1/calendar-settings`, existing per-calendar settings at `GET/PATCH /v1/calendars/:calendarId/settings`, and existing calendar metadata at `PATCH /v1/calendars/:calendarId` for `name`, `description`, `color`, and `display`. The CLI exposes the same subset through `pc calendars --settings`, `pc calendars --calendar cal_123 --settings`, and `pc calendars --calendar cal_123 name="Work" color=#3366ff`. Calendar creation, deletion, and key setup remain deferred because they can consume quota, require key orchestration, or destroy user data.

`TARGET_CALENDAR_ID` hard-locks all requests to one calendar. Without it, `ALLOWED_CALENDAR_IDS` controls explicit calendar routes and `DEFAULT_CALENDAR_ID` is used for plain event commands.

On Proton `401`/`403`, the server tries to refresh auth from saved `REFRESH-*` cookies and persists returned `Set-Cookie` headers back to the cookie bundle. Cookie bundle writes use a sidecar lock at `COOKIE_BUNDLE_PATH.lock`, re-read the bundle under that lock, then atomically rename a same-directory temp file into place. This prevents concurrent CI workers from clobbering each other's refreshed cookies and avoids partial JSON at the bundle path after failed writes.

Runtime browser relogin is available but disabled by the generated env file. Enable it only for unattended workers that need recovery beyond cookie refresh:

```bash
export PROTON_AUTO_RELOGIN=1
export PROTON_RELOGIN_MODE=headless
export PROTON_RELOGIN_COOLDOWN_MS=300000
export PROTON_RELOGIN_LOCK_PATH=secrets/proton-cookies.json.relogin.lock
```

The relogin lock prevents multiple processes from opening Chrome at once; the cooldown avoids repeated failed relogin attempts. Stale cookie and relogin locks are removed after their grace windows so a crashed worker does not permanently block recovery.

## Automation Contract

Automation callers should treat `pc` as a JSON command surface with private-API risk:

- Success output goes to stdout as `{ "data": ... }`.
- Error output goes to stderr as `{ "error": { "code", "message", "details" } }`.
- `error.code` is the stable key for scripts; `error.message` is for humans.
- Passwords, cookie values, refresh tokens, session blobs, bearer tokens, and raw Proton payloads must not appear in normal output, logs, or CI artifacts.
- `RATE_LIMITED` is retryable; respect `error.details.retryAfterSeconds` or `retryAfterMs` before trying again.
- `AUTH_CHALLENGE_REQUIRED` is not retryable without a human; stop automation for captcha, MFA, account-lock, or human-verification states.
- Use `--output json` or `-o json` in scripts, even though JSON is the default today.
- Run `pc doctor auth --fail-on-relogin-required` before unattended jobs so stale cookies, relogin needs, and local API problems fail before mutations.
- Prefer short date ranges and explicit calendar scope; avoid broad polling loops that repeatedly decode the same private API payloads.
- Continue API pagination with `nextCursor`; it pages the sorted output window but does not reduce peak memory for that request because recurring events are expanded after the full date range is fetched and decoded. If a list command returns `EVENT_LIST_PAGE_LIMIT` or `UPSTREAM_EVENT_PAGE_LIMIT`, narrow the date range or calendar scope instead of treating the partial window as complete.
- Use `X-Idempotency-Key` for HTTP API mutation retries when available; the CLI does not expose an idempotency flag yet, so retry CLI mutations only after checking whether the event already changed.
- Back off on auth challenges, rate limits, `Retry-After`, captcha, or human-verification states. Do not loop through repeated browser logins.
- Treat Proton private API shape drift as expected operational failure. Alert, preserve sanitized logs, and require human triage instead of silently continuing.

Exit codes:

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | General or internal failure |
| `2` | Validation, usage, configuration, or local secret-permission failure |
| `3` | Auth/session/login failure |
| `4` | Local API unavailable |
| `5` | Proton upstream, rate-limit, pagination-cap, or private API drift failure |
| `6` | Unsupported private-API state or login challenge |

The JSON envelope remains the stable machine-readable contract; use `error.code` for exact branching and the process exit code for broad CI/action categories.


## Automation Guardrails

`pc` is best suited for personal or small-team automation where failures can be inspected quickly. Do not rely on it as a stable public SaaS integration contract. Proton can require new interactive login steps, change private endpoints, throttle requests, or reject saved browser sessions.

Recommended CI/CD pattern:

```bash
set -euo pipefail
pc doctor auth -o json --fail-on-relogin-required
pc ls next 7 --title deploy -o json
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
- For scheduled jobs, respect `RATE_LIMITED` retry details before retrying, add exponential backoff for transient upstream failures, and notify a human after the first auth challenge or private-API drift failure.
- Keep live Proton checks required only for trusted CI contexts with dedicated credentials and safe cleanup; never expose Proton secrets to forked pull-request code.

## Development

```bash
pnpm run lint          # ESLint static analysis
pnpm run typecheck     # TypeScript checkJs contract checks
pnpm test              # mocked/unit suite
pnpm run test:unit:junit # mocked/unit suite with reports/junit.xml
pnpm run ci:local      # static checks + unit suite + package/bin smoke + npm publish readiness
pnpm run readiness:npm-publish # metadata, package contents, and npm dry-run readiness
pnpm run ci:live       # bootstrap live Proton session, start API, run live tests
pnpm test:live:api     # requires live Proton env/session
pnpm test:live:cli     # requires live Proton env/session
```

Pull-request CI runs the required no-quota local gate: frozen pnpm install, static ESLint/checkJs checks, mocked unit tests with an uploaded JUnit report, the packaged `pc` binary smoke, and the npm publish-readiness check. The package smoke packs this checkout, verifies required package files and Node engine metadata, installs the tarball with engine checks enabled, and then runs `pc --help` plus a JSON config-error path from the installed package. The npm readiness check validates publish metadata, the package `files` allowlist, the `pc` bin target, required README/LICENSE/CHANGELOG inclusion, Node engines, and sanitized `npm pack --dry-run` plus `npm publish --dry-run` output without npm credentials.

The live Proton canary runs only for trusted CI contexts: pushes to `main`, scheduled/manual runs, and same-repository pull requests. It installs Chromium, requires dedicated `PROTON_USERNAME` and `PROTON_PASSWORD` secrets, bootstraps a temporary cookie bundle, writes `secrets/ci-live.env`, starts the local API with that environment, and then runs live tests against the running API. If `PROTON_LIVE_ENABLE_SECOND_ACCOUNT=1` and `PROTON_USERNAME2` / `PROTON_PASSWORD2` are configured, the canary also bootstraps an isolated second-account cookie bundle at `secrets/proton-cookies-second.json` and records only its path in the generated env file. Pull requests from forks do not receive repository secrets and therefore skip the live canary; they still run the offline gates.

Plan-gated live tests must stay explicit. Free-account-safe tests are the default. Paid, shared-calendar, invite/RSVP, conferencing metadata, Proton Meet, Zoom, availability, appointment-scheduling, subscribed-calendar, holiday-calendar, and birthday-calendar tests must be gated with `PROTON_LIVE_ENABLE_*` flags. Use `PROTON_LIVE_ENABLE_CONFERENCING_METADATA=1` only for read-only observed metadata snapshots, `PROTON_LIVE_ENABLE_PROTON_MEET=1` only when creating real Proton Meet links is acceptable, and `PROTON_LIVE_ENABLE_ZOOM=1` only with a paid Proton account plus Zoom integration approval. Second-account tests require `PROTON_LIVE_ENABLE_SECOND_ACCOUNT=1` plus `PROTON_USERNAME2` and `PROTON_PASSWORD2` GitHub Actions secrets.

After live tests run, the canary compares sanitized response shapes from the local API bridge against `test/fixtures/live-drift-baseline.json` and uploads `reports/live-drift.json`. Missing surfaces or required fields fail with `proton_api_drift`; additive fields are reported for review but do not fail the canary. Drift reports must contain only schema metadata and next-action guidance, never cookies, bearer tokens, event contents, or raw Proton payloads.

## Releases

Releases are automated from the GitHub `main` branch with semantic-release.
Merge Conventional Commit messages such as `feat: ...`, `fix: ...`, or
`feat!: ...` to `main` to create the next GitHub release and `v<version>` tag.

Each GitHub release attaches standalone `pc` binaries and SHA-256 checksum files
for these platforms:

| Asset | Platform |
| --- | --- |
| `pc-linux-x64` | Linux x64 |
| `pc-macos-arm64` | macOS Apple Silicon |
| `pc-macos-x64` | macOS Intel |
| `pc-windows-x64.exe` | Windows x64 |

Download the asset for your platform, verify the sibling `.sha256` file, make it
executable on POSIX systems, and place it on your `PATH` as `pc`. Example:

```bash
sha256sum -c pc-linux-x64.sha256
chmod +x pc-linux-x64
./pc-linux-x64 --help
```

On Linux and macOS, the one-line installer automates those steps:

```bash
curl -fsSL https://raw.githubusercontent.com/hacker-h/proton-calendar-cli/main/scripts/install.sh | sh
```

Pin a release tag or choose a user-writable install directory:

```bash
curl -fsSL https://raw.githubusercontent.com/hacker-h/proton-calendar-cli/main/scripts/install.sh | sh -s -- --version v1.10.0
curl -fsSL https://raw.githubusercontent.com/hacker-h/proton-calendar-cli/main/scripts/install.sh | sh -s -- --dir "$HOME/bin"
PC_INSTALL_DIR="$HOME/bin" sh scripts/install.sh --version v1.10.0
```

The default install directory is `${XDG_BIN_HOME:-$HOME/.local/bin}`. The
installer refuses unsupported OS/architecture combinations, never uses `sudo`,
and fails if the target directory is not writable. Windows users should download
`pc-windows-x64.exe` and its checksum manually from GitHub Releases.

Uninstall a standalone installer-managed binary by deleting the installed file:

```bash
rm -f "${PC_INSTALL_DIR:-$HOME/.local/bin}/pc"
```

Security note: `curl | sh` executes remote code. To inspect before running:

```bash
curl -fsSLO https://raw.githubusercontent.com/hacker-h/proton-calendar-cli/main/scripts/install.sh
less install.sh
sh install.sh --version v1.10.0
```

The installer verifies the downloaded release asset against the release
`.sha256` file. That detects corrupted or partial downloads; it does not protect
against a compromised GitHub release or repository.

Standalone release binaries can update themselves from GitHub Releases:

```bash
pc update --check
pc update
pc update --version v1.9.0
```

`pc update` selects the release asset for the current OS/architecture, downloads
the sibling `.sha256` file, verifies the downloaded binary, smoke-checks
`--help`, and then replaces the current executable. It fails safely for npm,
source checkout, symlinked, and unsupported-platform installs; update those with
their package manager or by downloading a release asset manually. On Windows the
replacement is scheduled through a short helper because running `.exe` files
cannot be overwritten in place.

Release CI smoke-tests each generated binary with `pc --help` and a JSON
configuration-error path before uploading it. The binaries embed only the CLI
code and runtime dependencies; Proton credentials, cookie bundles, local config
files, `.env` files, and `secrets/` contents are never embedded.

semantic-release also updates `CHANGELOG.md` and commits that changelog update
back to `main` with `[skip ci]`. npm publishing is not enabled. The release
workflow only proves npm publish readiness with dry-run commands that strip npm
credentials and cannot publish from pull-request CI.

Until npm publishing is enabled, semantic-release tags remain the release version
source and `package.json` is only package metadata for local pack/readiness
checks. Do not treat `package.json.version` as the published npm version until
`@semantic-release/npm` is added to the release pipeline.

If npm publishing is enabled later, prefer npm trusted publishing over long-lived
`NPM_TOKEN` credentials: configure this repository and release workflow as the
trusted publisher on npmjs.com, add GitHub Actions OIDC permission
`id-token: write` only to the release publishing job, use a supported npm CLI,
and then add `@semantic-release/npm` to the semantic-release plugin chain.
Trusted publishing from GitHub Actions can generate npm provenance for public
packages; keep PR checks credential-free and dry-run only.

Local release checks:

```bash
pnpm run ci:local
pnpm run readiness:npm-publish
pnpm run release:dry-run
```

## Current Limitations

- Requires a local API server; normal event commands do not talk directly to Proton.
- Uses unofficial private Proton endpoints that can change without a compatibility window.
- Login/bootstrap depends on Chrome and local cookie/session export.
- Browser login can stop on 2FA, captcha, human-verification, locked-account, or changed-UI states.
- Rate limits and `Retry-After` behavior are controlled by Proton and should stop automation until backoff expires.
- List pagination uses `nextCursor` for output continuation only; broad date ranges still fetch, decode, expand recurrences, and sort the whole requested range before slicing the returned page.
- `recurrence.count` and `recurrence.until` cannot both be set.
- Proton currently rejects `scope=following` deletes in live recurrence tests with an upstream `UPSTREAM_ERROR`; use `scope=single` or `scope=series` deletes until that private API behavior is confirmed.
- Reminder controls support common friendly syntax and Proton-compatible `Notifications` objects directly; attendee invitation payload research is present only as a disabled non-sending prototype, with no Proton Mail invite ingestion, RSVP state, conference metadata, attachments, categories/tags, special-calendar creation, or arbitrary ICS passthrough yet.
- ICS import/export is limited to simple local events and recurrence rules already supported by this CLI; alarms, attendees, organizer/invite data, attachments, categories, and arbitrary passthrough fields are rejected.
- Live tests require a Proton account and calendar suitable for automated cleanup.

## License

MIT. See [LICENSE](LICENSE).
