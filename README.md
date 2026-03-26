# Voice Notes

## Local Development

Frontend-only development:

```bash
npm run dev
```

Frontend plus Vercel API routes for sync:

```bash
npm run dev:sync
```

`npm run dev` serves the app with Vite only. It does not execute the Vercel functions in [`api/`](/Users/bclinkinbeard/.codex/worktrees/9518/voice-notes/api), so cloud sync must be tested with `npm run dev:sync` or a deployed URL.

## Sync Scope

Cloud sync currently ships:

- lists
- transcriptions
- note metadata like ordering, completion state, duration, categories, and sentiment

Audio recordings stay on the device where they were captured and are not synced yet.

## Vercel Preview Automation

If preview deployments are protected, add `VERCEL_AUTOMATION_BYPASS_SECRET` to your shell or `.env.local`.

Build an automation-friendly preview URL:

```bash
npm run preview:url -- https://your-preview.vercel.app
```

Open a protected preview directly in Playwright CLI:

```bash
scripts/playwright-open-preview.sh https://your-preview.vercel.app --headed --config .playwright/cli.config.json
```

The helper adds:

- `x-vercel-protection-bypass=<secret>`
- `x-vercel-set-bypass-cookie=true`

That lets the first automated request set the bypass cookie so the browser session can continue without a manual Vercel login.
