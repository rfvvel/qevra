# Phase 2 — business configuration

## Scope and result

Phase 2 adds business, branch, service, serving-capacity and membership
configuration to the existing modular monolith. All business data passes through
Express. Supabase Auth, pg, SQL transactions and the original database schema are
retained. No new migration was necessary; the already-applied foundation SQL was
not edited. No manual remote schema changes were made.

No tickets, queue calls, ETA, payments, notifications, WhatsApp, analytics,
subscriptions, QR generation or deployment are implemented. The public branch
page is a read-only service catalog.

## API

All paths below are under /api/v1. Business routes require a verified permanent
Supabase bearer token. Anonymous sessions cannot access any business endpoint.
Success responses are resource objects (201 on creation) or arrays (200 on lists).
PATCH returns the updated object. Errors use the existing error envelope:
400 validation, 401 missing/invalid identity, 403 disallowed role, 404 unavailable
or out-of-scope resource, 409 duplicate resource or final-owner conflict.

| Methods | Path |
| --- | --- |
| GET, POST | /businesses |
| GET, PATCH | /businesses/:businessId |
| GET, POST | /businesses/:businessId/branches |
| GET, PATCH | /businesses/:businessId/branches/:branchId |
| GET, POST | /businesses/:businessId/branches/:branchId/services |
| GET, PATCH | /businesses/:businessId/branches/:branchId/services/:serviceId |
| GET, POST | /businesses/:businessId/branches/:branchId/services/:serviceId/counters |
| PATCH | /businesses/:businessId/branches/:branchId/services/:serviceId/counters/:counterId |
| GET, POST | /businesses/:businessId/members |
| PATCH | /businesses/:businessId/members/:memberId |
| PUT | /businesses/:businessId/members/:memberId/assignments |
| GET (public) | /public/branches/:slug |

Business creation atomically creates a staff profile if needed, the business and
an OWNER membership. Existing profile names are not overwritten.

Business requests use name, slug and status (ACTIVE or INACTIVE), mapped to the
existing database is_active boolean. Branch/service/counter requests use their
documented snake_case fields. PATCH changes only submitted fields; it does not
inject creation defaults. Empty PATCH and unknown request properties are rejected.

Money values are decimal integer **strings** in JSON, for example
price_amount: "80000" and deposit_amount: "10000". They remain bigint in PostgreSQL.
No float conversion or global pg bigint parser is used. Values up to PostgreSQL's
signed bigint maximum are accepted and rendered with BigInt formatting. Currency
is IDR. Deposit validation runs against the complete merged service on PATCH.

Names, slugs, UUIDs, IANA timezones, positive durations, prefixes, money, roles and
payment configuration are validated through packages/contracts. Duplicate slugs,
prefixes, counter names and memberships map to sanitized 409 responses.

## Authorization matrix

| Action | OWNER | MANAGER | STAFF |
| --- | --- | --- | --- |
| Create a new business | Any permanent user becomes owner of their new business | Same | Same |
| Read their business | Yes | Yes, when active | Yes, when active |
| Update business information/status | Yes | No | No |
| List/read branches | All | Assigned only | Assigned only |
| Create branch | Yes | Yes; assigned to the new branch atomically | No |
| Update branch | All | Assigned only | No |
| List/read services/counters | All | Assigned branches | Assigned branches AND services |
| Create/edit services/counters | All | Assigned branches | No |
| Manage memberships/assignments | Yes | No | No |

A manager creating a new branch cannot grant access to any existing branch.
An inactive business remains accessible to its owners so it can be reactivated;
it is hidden from managers, staff and public visitors. Assigned inactive branches
and services remain readable in configuration; public visibility requires the
business, branch and service all to be active.

Every scoped operation validates the complete business/branch/service relationship.
URLs, roles and IDs supplied by the browser do not grant access. Staff cannot edit
even their assigned services in Phase 2; their configuration access is read-only.

Mutation transactions lock the business row before reloading current membership.
Reads take a shared lock. Membership/role changes use that same lock, preventing
final-owner demotion/deactivation races through these endpoints. This is
application-level protection; trusted manual SQL administrators can bypass it.
There is no transaction-local database actor context.

The previous requireBusinessRole foundation helper remains covered by its original
tests. The configuration module uses the transaction-scoped businessScope helper
to combine current membership checks with branch/service checks and locking.

## Membership management

POST /members accepts user_id (Supabase Auth UUID) and role. Only an existing,
confirmed, non-anonymous Auth user is eligible. No directory search, new-user
creation, invitation email or password management endpoint is provided.

Development flow:
1. Project administrator creates/confirms the user in Supabase Authentication → Users.
2. Copy that user's UUID. Do not copy passwords or tokens.
3. An owner adds the UUID and chooses OWNER, MANAGER or STAFF in Team & access.
4. Assign managers to branches; assign staff to branches and services.

PUT /assignments replaces both assignment sets atomically, using branch_ids and
service_ids arrays. Every service must belong to a selected branch in the same
business. Duplicate or cross-tenant IDs are rejected before existing assignments
are removed. Owners need no assignments; managers receive no individual service
assignments. Inactive members cannot receive assignments.

PATCH /members supports role and is_active. Deactivation revokes membership
instead of deleting its history. Role changes and deactivation clear stale
assignments; an owner explicitly assigns the new scope afterward. At least one
active owner must remain. The UI returns to business selection if the current
owner removes their own owner access.

## Dashboard and public routes

- /login — functional staff email/password login and local-session sign out.
- /app — authenticated business selector.
- /app/onboarding — create business.
- /app/:businessId — overview and owner settings.
- /app/:businessId/branches — scoped branch list and creation.
- /app/:businessId/branches/:branchId — branch editing and public link.
- /app/:businessId/branches/:branchId/services — scoped service list and creation.
- /app/:businessId/branches/:branchId/services/:serviceId/settings — service and counter configuration.
- /app/:businessId/staff — owner membership/role/assignment management.
- /q/:branchSlug — business/branch details and active services; no queue actions.

Route guards protect the dashboard UI. Express remains the authority. Identity
changes remount protected content so a prior user's data is not retained.
Forms share backend validation contracts. Loading, empty, error and disabled-save
states are included. Counter capacity is derived from active counter rows.

## Tests and reproducible verification

Run from the repository root:

```sh
npm run check
npm run test:database
npm run verify:phase2
npm run audit:secrets
```

The ordinary suite runs offline and skips database integration files when no
TEST_DATABASE_URL is set. test:database loads the development connection from the
ignored API .env and runs both real SQL suites. All fixtures are rolled back.

The Phase 2 HTTP integration suite uses real routes, validation, authorization,
repositories and PostgreSQL. Only identity-token verification is mocked for
synthetic users. It covers:
- business creation and automatic ownership, duplicate rollback;
- business/branch/service/counter creation and updates;
- money precision and payment-rule validation, including partial-update preservation;
- cross-business, cross-branch, cross-service and invalid parent-child access;
- member creation, assignment validation, role restrictions and immediate revocation;
- final-owner protection and visibility of inactive resources.

verify:phase2 uses real Supabase staff login, real Express routes and real PostgreSQL
in an isolated headless Edge browser. It checks the full demo flow, invalid deposit
feedback, counter updates, staff assignment, refresh persistence, public access,
mobile overflow and signout. It uses savepoints inside an outer transaction and
rolls back all configuration/test-identity fixtures afterward. No demo businesses
are intentionally left in the database. Existing user passwords and data are not
changed. Browser traces and credential-bearing session files are not saved.
Status-only reports and screenshots of synthetic test data are under ignored
.runtime/. Port 3001 (or configured API PORT) must be free for this isolated harness.

The test Auth account must be configured through TEST_STAFF_EMAIL and
TEST_STAFF_PASSWORD in apps/api/.env. Never put these values in VITE_ variables.
Only public Supabase configuration is included in the browser bundle.

## Suggested manual demo

1. npm run dev, then open http://localhost:5173/login.
2. Sign in using a confirmed development staff account.
3. Create business “Salon ABC” with a unique slug.
4. Open Branches & services and create “Central Park” with a unique public slug.
5. Open View services and create “Haircut”, price 80000, duration 30, prefix A.
6. Add “Stylist station 1”; rename or deactivate it to observe capacity.
7. In Team & access add another confirmed Auth user's UUID and assign scope.
8. Open the branch's public URL in a private window: only active services appear.
9. Sign in as the other user to inspect assigned scope; direct out-of-scope API
   requests are also covered by the integration tests.
10. Try deactivating/demoting the final owner: a 409 error preserves ownership.

No email invitations or account registration UI, pagination, display-name editing,
hard deletion or QR generation are included. Lists are intended for MVP-sized
businesses. Business and branch slug edits change their links; redirects are not
implemented. The development-only /__verify route from Phase 1.5 remains available
in Vite development and absent in the production bundle.

Phase 3 is not started.

## Files created or changed in Phase 2

Created:
- packages/contracts/src/configuration.ts
- apps/api/src/modules/configuration/access.ts
- apps/api/src/modules/configuration/repository.ts
- apps/api/src/modules/configuration/routes.ts
- apps/web/src/app/auth-context.tsx
- apps/web/src/components/ui.tsx
- apps/web/src/lib/configuration-api.ts
- apps/web/src/lib/use-resource.ts
- apps/web/src/features/auth/login.tsx
- apps/web/src/features/configuration/forms.tsx
- apps/web/src/features/configuration/business-pages.tsx
- apps/web/src/features/configuration/branch-pages.tsx
- apps/web/src/features/configuration/service-pages.tsx
- apps/web/src/features/configuration/staff-page.tsx
- apps/web/src/features/public/branch-page.tsx
- tests/configuration-contracts.test.ts
- tests/configuration.integration.test.ts
- scripts/verify-phase2-browser.mjs
- docs/phase-2.md

Updated:
- packages/contracts/src/index.ts
- apps/api/src/app.ts
- apps/api/src/middleware/error-handler.ts
- apps/web/src/app/router.tsx
- apps/web/src/components/layouts.tsx
- apps/web/src/main.tsx
- apps/web/src/lib/auth.ts
- apps/web/src/styles/index.css
- apps/web/vite.config.ts
- apps/web/package.json
- tests/api.test.ts
- scripts/test-database.mjs
- package.json, package-lock.json and README.md

The .env files and foundation migration were not changed during Phase 2.

## Final verification results

- TypeScript: passed for all workspaces.
- ESLint: passed.
- Offline/API/contract tests: 20 passed, 2 database suites skipped intentionally.
- Explicit real database integration run: 14 passed, 0 skipped.
- Frontend, backend and contracts builds: passed. Vite reports two non-blocking
  annotation warnings inside the installed Zod dependency; no build errors.
- Real browser flow: passed, including staff assignment, session refresh, public
  browsing without signup, and mobile overflow checks.
- Secret audit: .env ignored, no configured credentials in Git candidate files
  or captured browser/process logs. No files staged or committed.
- All integration/browser test fixtures were rolled back.
- Original migration reused without alteration; no new migration required.

Input limits include 1–1440 minutes per service, 1–5 uppercase letters per queue
prefix, and PostgreSQL's positive signed bigint range for money amounts.

Phase 2 is complete. No Phase 3 work has been started.
