# Motherlink Engage — web app

Next.js (App Router) + Firebase. This is the operator-facing application: projects,
Reddit opportunity analysis, draft generation, account warm-up design, and the
admin surfaces for people, roles and API keys.

> **Read `AGENTS.md` before writing code here.** This Next.js version has breaking
> changes from what you may expect; the guides in `node_modules/next/dist/docs/`
> are the authority.

## Getting started

```bash
npm install
npm run dev          # http://localhost:3010
```

```bash
npm run build        # production build — also typechecks
npx tsc --noEmit     # typecheck alone, faster
npm run lint
```

Tests live at the repo root, not here:

```bash
cd ../../tests && npm run test:unit    # server logic, plain node, no emulator
cd ../../tests && npm run test:rules   # Firestore rules, needs the emulator
```

## Environment

Copy these into `.env.local` for local development, and into the deployment
environment for production. Nothing here has a safe default — the app degrades
visibly rather than silently when one is missing.

### Firebase — required

| Variable | Notes |
|---|---|
| `NEXT_PUBLIC_FIREBASE_API_KEY` | client config; the `NEXT_PUBLIC_*` set is public by design |
| `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` | |
| `NEXT_PUBLIC_FIREBASE_PROJECT_ID` | |
| `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET` | |
| `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID` | |
| `NEXT_PUBLIC_FIREBASE_APP_ID` | |
| `FIREBASE_SERVICE_ACCOUNT` | Admin SDK credentials as JSON. **Server-only — never `NEXT_PUBLIC_`.** |
| `FIREBASE_ADMIN_KEY_PATH` | Instead of the above: a path to the key file, used locally so the key stays outside the repo. **Set one or the other, never both** — inline wins. |

### AI providers

| Variable | Notes |
|---|---|
| `LLM_ENCRYPTION_KEY` | **Required to store any API key.** 32 bytes, base64 — generate with `openssl rand -base64 32`. Without it the API keys pages render a setup notice and refuse to save, and no amount of admin rights fixes it from inside the app: a master key that encrypts the database cannot live in that database. |
| `LLM_ENCRYPTION_KEY_PREVIOUS` | Set only while rotating. Put the outgoing key here so existing envelopes still open, re-seal, then remove it. |
| `DEEPSEEK_API_KEY` | The platform's own account — the default when no user or project key applies. |
| `OPENROUTER_API_KEY` | Optional second platform provider. |

Users and admins add further provider keys **through the app**, not through the
environment; those are encrypted at rest and never leave the server. Which key a
given call actually spends depends on per-project grants and a per-person
entitlement — see `server/llm/resolve.ts` and `server/llm/select.ts`.

### Optional

| Variable | Notes |
|---|---|
| `RESEND_API_KEY` | Provisioning emails. Absent → the app still provisions people; it just does not email them. The email carries no secret. |
| `REDDIT_PROXY_URL` | Route Reddit fetches through a residential proxy. Absent → direct. |
| `NEXT_PUBLIC_APP_URL` | Absolute URL used in emails. Defaults to `http://localhost:3010`. |

## Layout

```
src/app/              routes — (app)/ is the signed-in shell, api/ is the server tier
src/server/           server-only: Admin SDK, auth gates, LLM credentials, crypto
src/modules/reddit/   the Reddit domain — prompts, fetch, approach planning
src/components/       UI
src/lib/              shared client+server types and helpers
```

Every API route authenticates and checks permissions server-side. Navigation is
filtered by role for presentation only — **hiding a link is not a control.**
