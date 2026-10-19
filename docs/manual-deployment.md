# Manual deployment guide (no deployment performed)

For the current Railway + Vercel Twilio hosted demo, follow [hosted-demo.md](hosted-demo.md), which supersedes the original MVP-only instructions below.

This guide is for the developer to execute later. Qevra has not created hosting
projects, connected accounts, changed hosting dashboards or deployed any service.

## 1. Supabase project

Use a separate production Supabase project. Apply every immutable file in
`supabase/migrations` in filename order, preferably using the Supabase CLI's normal
migration workflow. The repository's `npm run db:migrate` helper can also run from a
trusted terminal: it prefers the process DATABASE_URL, otherwise the ignored
apps/api/.env file. Double-check the intended target privately before running.
Never put the production connection string in Git, frontend variables, screenshots
or command history. Do not run migrations automatically on API startup.

Enable email signup, email confirmation and anonymous sign-ins. Configure custom
SMTP for real users: Supabase's default sender is restricted and intended for
non-production use ([Supabase SMTP documentation](https://supabase.com/docs/guides/auth/auth-smtp)).
This is Auth confirmation delivery, not a Qevra invitation or notification feature.
Ordinary users confirm their own email; they never need Supabase Dashboard access.

Set Auth Site URL to the real frontend HTTPS origin and allow its exact /login
redirect, e.g. https://your-frontend.example/login. Qevra sends that current-origin
redirect when registering. Keep localhost redirect entries only for development.
Use exact production redirect paths, as recommended by
[Supabase](https://supabase.com/docs/guides/auth/redirect-urls).
Keep the migrated private Realtime authorization and browser table restrictions.

## 2. Backend: Render / Railway / similar Node host

Manually choose the repository root as the service working directory. Use a Node
version satisfying package.json (Node 22.12+; the project was tested on Node 24).

Build:
```sh
npm ci
npm run build -w @qevra/contracts
npm run build -w @qevra/api
```
Start:
```sh
npm run start -w @qevra/api
```

Set server-only environment variables through the host's secret configuration:

| Variable | Value |
| --- | --- |
| NODE_ENV | production |
| PORT | Host-provided port |
| WEB_ORIGIN | Exact frontend HTTPS origin, no trailing slash/path |
| SUPABASE_URL | Production Supabase HTTPS project origin |
| SUPABASE_PUBLISHABLE_KEY | Production public publishable/legacy anon key |
| DATABASE_URL | Production PostgreSQL URL with sslmode=verify-full |
| PAYMENT_PROVIDER | DISABLED |
| MOCK_WHATSAPP_ENABLED | false |

Production startup rejects missing Supabase/database configuration, non-HTTPS
frontend origin, malformed project origin, or database URLs without verify-full.
Use the Supabase connection option compatible with the host's networking. Retain
certificate verification; when a private CA is genuinely required, configure the
trusted certificate as PEM text through DATABASE_CA_CERT. Production now rejects sslrootcert file paths. Never use no-verify or rejectUnauthorized=false.

Express listens on PORT and handles termination signals. The host's build/start
concept is described in [Render's Express guide](https://render.com/docs/deploy-node-express-app).
Real payments remain unsupported. Hosted Twilio demo configuration is documented in hosted-demo.md.

## 3. Frontend: Vercel

Manually select the monorepo root; do not assume an isolated apps/web checkout has
the shared workspace packages. Configure installation/build/output explicitly:

- Install: npm ci
- Build: npm run build -w @qevra/contracts && npm run build -w @qevra/web
- Output: apps/web/dist
- SPA fallback: serve index.html for client routes such as /register, /app/...,
/q/... and /ticket/....

The equivalent Vercel rewrite in a manually supplied vercel.json is:
```json
{"rewrites":[{"source":"/(.*)","destination":"/index.html"}]}
```
Review the hosting project's root setting so this config and output directory
resolve from the same root. [Vercel's Vite guide](https://vercel.com/docs/frameworks/frontend/vite)
documents the SPA deep-link requirement. No Vercel configuration or project was
created by this phase.

Build-time public variables:
- VITE_API_URL=https://your-backend.example/api/v1
- VITE_SUPABASE_URL=https://your-project.supabase.co
- VITE_SUPABASE_PUBLISHABLE_KEY=your-public-key

The Vite development /api proxy does not exist on a static production host.
Set the absolute API URL and rebuild when these values change. Never expose
DATABASE_URL, service-role keys, passwords or private provider credentials as VITE_.
API CORS must match the exact frontend origin; it does not use wildcard origin.
Public branch links are derived from the frontend origin automatically.

## 4. Manual smoke checks

1. GET /api/v1/health returns status ok and service qevra-api.
2. GET /api/v1/health/database reports connectivity without infrastructure details.
3. Register a new business user, receive/confirm email, log in, and create a business.
4. Create branch, NONE service and counter; open queue; copy its Customer Queue Link.
5. Register a separate staff user; add their exact email and assign branch/service.
6. In a separate browser, open the public link and join anonymously. Call/start/
complete as assigned staff; verify customer Realtime and in-app notifications.
7. Open OWNER analytics. Confirm STAFF cannot access analytics or team management.
8. Refresh direct routes to confirm the SPA fallback. Check mobile overflow.
9. Confirm mock payment/WhatsApp controls and endpoints are unavailable.

Only NONE services accept new customers in production until a real payment provider
is integrated. Real payment provider not integrated in MVP. No real WhatsApp is
sent. Paid mock demonstrations require the development frontend AND development
API flags; a production build intentionally cannot run the mock demo.

No password reset UI, invitation delivery, subscription billing, exports or
automatic deployment is included. Configure operational backups, monitoring and
appropriate Auth abuse protections as part of the developer's eventual hosting
setup; this phase does not operate production infrastructure.
