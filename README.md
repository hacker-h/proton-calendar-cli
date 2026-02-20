# proton-calendar-api

Private repository scaffold for the Proton Calendar API project.

POC status: manual Proton login and SweetLink cookie extraction is verified and working; implementation is now focused on single-calendar meeting APIs.

## Manual login cookie bootstrap (SweetLink)

This repo now includes a basic bootstrap flow that:

1. opens a dedicated Chrome window for manual Proton login,
2. detects when Proton Calendar is loaded and auth cookies are present,
3. exports cookies via `@steipete/sweet-cookie` (with DevTools/SweetLink fallback),
4. closes the browser, and
5. writes the cookie bundle to `secrets/proton-cookies.json`.

### Setup

```bash
pnpm approve-builds
pnpm install
```

`sweetlink` needs native sqlite/keytar bindings to read Chrome cookies. If setup fails, rerun `pnpm approve-builds` and reinstall.

If keychain prompts block extraction, the bootstrap script will automatically try to read `Chrome Safe Storage` and pass it to `sweet-cookie`.

### Run

```bash
pnpm run bootstrap:cookies
```

Optional flags:

```bash
pnpm run bootstrap:cookies -- --timeout 900 --poll 2 --output secrets/proton-cookies.json
```

### Tests

```bash
pnpm test
```

## API (single calendar only)

Environment variables:

```bash
export TARGET_CALENDAR_ID="assistant-calendar-id"
export API_BEARER_TOKEN="replace-me"
export COOKIE_BUNDLE_PATH="secrets/proton-cookies.json"
export PROTON_BASE_URL="https://calendar.proton.me"
```

Run API server:

```bash
pnpm start
```

Routes:

- `GET /v1/health`
- `GET /v1/auth/status`
- `GET /v1/events?start=<iso>&end=<iso>&limit=<n>&cursor=<token>`
- `GET /v1/events/:eventId`
- `POST /v1/events`
- `PATCH /v1/events/:eventId`
- `DELETE /v1/events/:eventId`

Notes:

- This API only supports single-instance events (no recurrence).
- The service enforces one configured calendar via `TARGET_CALENDAR_ID`.
