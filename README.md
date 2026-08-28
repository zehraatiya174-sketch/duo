# Duo

A private messaging app for exactly two people. Real-time messages, voice and
video calls, and view-once media that is genuinely destroyed rather than merely
hidden.

Next.js 15 · React 19 · Socket.IO · Prisma · PostgreSQL · Tailwind v4

---

## Why it is shaped this way

**One process, not serverless.** Next.js and Socket.IO share a single HTTP
server in `server/index.ts`. This is not a preference. A persistent socket
cannot live in a serverless function, and — more importantly — the 30-second
sweep that destroys expired messages only exists inside a long-lived process. On
a serverless host, view-once messages would outlive their expiry. That is a
privacy bug, so Vercel and friends are ruled out.

**Exactly one instance.** Socket.IO runs without a Redis adapter. A second
replica would put the two users in separate rooms and neither would see the
other's messages. Never enable autoscaling.

**Two gates, in order.** A passphrase gate stands in front of everything —
including the sign-in screen — so a stranger cannot even tell that accounts
exist here. Behind it, the usual session check. Both are optimistic cookie
checks at the edge; real authorization runs again in every route handler.

**Sealed messages are a lifecycle, not a counter.** Opening one reserves a
view, rendering confirms it, closing spends it, and abandoning hands it back.
A plain `viewCount++` cannot tell a look that was taken from one that failed to
load, and would charge for both. See `lib/ephemeral/session.ts`.

---

## Running it locally

```bash
npm install --legacy-peer-deps
cp .env.example .env        # then fill it in — see below
npx prisma migrate deploy
npm run db:seed             # creates the two allowlisted accounts
npm run dev
```

`--legacy-peer-deps` is required: `better-auth` declares an optional peer on
SvelteKit that npm otherwise refuses to resolve.

### The environment

Everything is validated at boot by `lib/env.ts`, which refuses to start rather
than run half-configured. The variables that actually matter:

| Variable | Notes |
| --- | --- |
| `DATABASE_URL` | PostgreSQL. Neon's free tier is a good fit. |
| `AUTHORIZED_USER_1` / `_2` | The only two addresses that may hold an account. |
| `BETTER_AUTH_SECRET` | 32+ random characters. |
| `VERIFICATION_PASSPHRASE` | The first gate. No default, on purpose. |
| `MEDIA_ENCRYPTION_KEY` | 64 hex chars. **Changing it makes every existing upload unreadable.** |
| `MEDIA_URL_SECRET` | Signs short-lived media URLs. |
| `STORAGE_PROVIDER` | `local`, `supabase`, `cloudinary`, `s3`, or `b2`. |

`NEXT_PUBLIC_*` variables are **build arguments**, not runtime configuration.
`next build` inlines them into the client bundle, so changing one requires a
rebuild. A restart silently keeps the old value — this has bitten this project
before.

---

## Commands

```bash
npm run dev          # tsx watch on server/index.ts
npm run build        # prisma generate && next build
npm run verify       # typecheck + lint + unit tests
npm run test         # vitest
npm run test:e2e     # playwright, needs a real database
npm run db:studio    # browse the data
```

---

## Deploying to Render (free)

`render.yaml` is a working blueprint. Point Render at this repo and it will
build the Dockerfile.

1. Create a free Postgres at [neon.tech](https://neon.tech) and copy the pooled
   connection string into `DATABASE_URL`. Render's own free Postgres expires
   after 30 days; Neon's does not. **Put the Render service in the same region
   as the Neon project** — a request makes several sequential round trips inside
   one transaction, so a cross-country hop is not merely slower.
2. Create a Supabase project, make a private bucket named exactly **`Media`**,
   and set `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
   `SUPABASE_STORAGE_BUCKET`. The bucket name is part of every object path, so
   it must match. The service-role key bypasses row-level security — it must
   never reach the browser.
3. Fill in the `sync: false` variables in the Render dashboard.
4. **Keep it awake.** The free plan sleeps after 15 minutes idle, and a sleeping
   container runs no purge sweep, so sealed messages would survive past their
   expiry. Point a free uptime pinger (cron-job.org) at `/api/health` every 10
   minutes — 744h/month sits just under the 750h free allowance.

Verify after the first deploy that Render passed the `NEXT_PUBLIC_*` values into
the Docker build. If the client cannot reach the socket, that is the first thing
to check: the Dockerfile's `ARG` defaults point at `localhost`.

---

## Layout

```
app/            routes and API handlers
server/         the single-process entry point
socket/         realtime: auth, handlers, presence, broadcast
services/       business logic — messages, ephemeral, storage, admin
lib/            env, db, auth, crypto, validation, motion
features/       feature-scoped UI (chat, calls, auth, admin)
components/ui/  the design system primitives
prisma/         schema, migrations, seed
tests/          vitest suites; tests/e2e is playwright
```

Design tokens live in `styles/globals.css` as CSS custom properties. There is no
`tailwind.config.js` — Tailwind v4 reads the stylesheet.
# duo
