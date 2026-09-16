# End-to-end suite

`pnpm --filter @polycast/web e2e` builds nothing: run `pnpm build` first (the web server is
`next start`). Requirements: Postgres on `DATABASE_URL` (docker compose or the CI service), the
media worker venv (`services/media-worker/.venv`), and a Playwright Chromium
(`pnpm --filter @polycast/web exec playwright install chromium`). ffmpeg is optional; with it the
fixture is a 10-minute test video, without it a 12-second WAV.

`global-setup.ts` resets the database schema (`POLYCAST_RESET_SCHEMA=1`, refused in production),
starts the API on :4100 and the worker loop, and Playwright serves the web app on :3100.
Every screen is checked with axe; serious and critical violations fail the run.
