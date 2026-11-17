# ADR-001 — Technology stack and build approach

Status: **Accepted** on 2026-10-19 for sections 3.1–3.7 and 5 (stack and build approach). Hosting (3.8) and the open questions in section 7 are still undecided.
Date: 2026-10-17
Inputs: `product/discovery.md`, `domain/order-lifecycle.md`, `domain/data-model.md`

## 1. Context

iOrder.uz is an internal B2B ordering and order-tracking platform for one trading company. Customers are Telegram-group-based organizations; staff (manager, accountant, warehouse, driver, admin) run the order lifecycle. Core needs:

- Order lifecycle with strict transitions, roles and an audit trail.
- Price list with versions and history; stock read from a Google Sheet.
- Telegram everywhere: bot in groups (daily price post, `/price`), notifications, Mini App, website login.
- Customer data isolation between organizations; cost data staff-only.
- Languages UZ (default), RU, EN.
- No online payment, no Corex integration in the MVP.
## 2. Assumptions [A] (to confirm)

- One or two developers; the product owner is the main developer.
- Low load: one company, tens to hundreds of organizations, up to a few hundred orders a day.
- No fixed hosting provider and no fixed deadline yet.
- "Scalable" means room to grow in features and data, not microservices.
## 3. Decisions and alternatives

### 3.1 Architecture style

| Option | For | Against |
|---|---|---|
| **A. Modular monolith** (one backend app, one database, clear modules) | Simplest to build, test, deploy, debug. Transactions across modules are trivial (status change + event + outbox in one transaction). Easy to split later. | Needs discipline to keep module boundaries. |
| B. Microservices | Independent scaling and deployment. | Heavy for this size: network failures, distributed transactions, several deployments. No benefit at this load. |
| C. Backend-as-a-service (Firebase/Supabase) | Fast start, built-in auth. | State machine, outbox, bot, schedules and Sheets sync still need server code, so logic splits across two places. Vendor lock-in. Telegram auth does not fit the built-in auth well. |

**Recommendation: A, modular monolith.** Modules: `identity`, `organizations`, `catalog` (products, stock cache), `pricing`, `orders`, `notifications`, `telegram`, `sheets-sync`, `audit`.

### 3.2 Backend

| Option | For | Against |
|---|---|---|
| **NestJS (TypeScript)** | Enforced modules, guards for role checks, dependency injection for testing, validation pipes, scheduling support. Suits RBAC + state machine + several integrations. | More boilerplate and concepts to learn. |
| Fastify + own structure | Lighter, fast, less magic. | Module boundaries rely on convention only. |
| Python (Django / FastAPI) | Strong admin tooling (Django). | New language for the team, a second ecosystem next to a TypeScript frontend. |

**Recommendation: TypeScript on Node.js with NestJS.** If you prefer something lighter, Fastify with a strict folder-per-module layout is an acceptable alternative; the rest of this ADR does not change.

### 3.3 Database and data access

- **PostgreSQL.** Relational model with transactions, partial unique indexes (one `PUBLISHED` price list), structured JSON for event payloads, and optional row-level security as defense in depth for organization isolation.
- **ORM: Prisma.** Typed access and migrations. Limitation: partial unique indexes and row-level rules need hand-written SQL inside migrations. Alternatives (Drizzle, Kysely) are viable; no strong reason to switch.
- Money as fixed-point decimal, never floating point. Timestamps in UTC; business rules evaluated in Asia/Tashkent.
### 3.4 Background jobs (price posts, notification outbox, Sheets sync)

| Option | For | Against |
|---|---|---|
| **pg-boss (jobs stored in PostgreSQL)** | No extra server to run. Retries, scheduling, same backup as the data. | Lower throughput than Redis queues (not a concern here). |
| BullMQ (Redis) | Mature, fast. | One more service to host, monitor and back up. |
| In-process cron only | Simplest. | Jobs lost on restart, hard to retry or observe. |

**Recommendation: pg-boss** (verify the maintained version at implementation time). The outbox table stays the source of truth for notifications; the worker reads it.

### 3.5 Frontend

- **Two Vue 3 + TypeScript + Vite apps [C, 2026-10-25]** (this replaces the original single-app decision): a **customer app** and a **staff app** (manager, accountant, warehouse, driver, admin). Each one is responsive and is used both as a Telegram Mini App and as a normal website. Reasons: the customer build never contains staff code, the staff app can later get its own domain, security headers or network restriction, and the two can be released independently. Security does not depend on the split; the server still enforces every permission.
- Code layout (done 2026-10-25): `apps/customer` (`@iorder/customer`), `apps/staff` (`@iorder/staff`) and the shared kit `packages/web-core` (`@iorder/web-core`, imported as `@core/...`: UI kit primitives, design tokens and base styles, the i18n factory with the shared catalogs, http client, formatting, Telegram launch and Login Widget, the bundle rules). Code only one app uses stays in that app. Neither app imports the other; ESLint and each app's bundle check enforce it. The package name and its exact contents are [P].
- No server-side rendering: everything is behind login, there is no SEO need.
- Internationalization with vue-i18n (UZ default, RU, EN). UI component library and design tokens are chosen in the design-system step, not here.
- Staff on phones (driver, warehouse) open the staff app inside Telegram as a Mini App [C, 2026-10-25]. Staff Mini App sign-in already exists: the api's `tma` resolver verifies the init data and a staff role wins over any membership, and the staff app sends the init data when it runs inside Telegram; in a browser staff use the Telegram Login Widget or login/password. Bot links: customer links use `WEB_APP_URL` and staff order links use `STAFF_WEB_APP_URL` (falls back to `WEB_APP_URL` when both apps share one origin); `/start` links to the customer app. Since 2026-11-09 the staff Mini App has its own direct link (`TELEGRAM_STAFF_MINI_APP_URL`) and may have its own bot (`STAFF_MINI_APP_BOT_TOKEN`, off by default), see `customer-website-auth.md`, "The staff Mini App". Open: whether `/start` should send staff to the staff app [P].
### 3.6 Telegram integration

- **Bot: grammY** (TypeScript-first) running in the backend. It posts price lists, answers `/price`, checks group membership, sends status notifications.
- **Bot run mode:** webhook in production, long polling in development and tests (no public URL or tunnel needed). The mode is chosen by an environment variable; the bot logic is the same in both.
- **Mini App identity:** the app sends Telegram's signed init data; the server validates it (HMAC with the bot token) and rejects stale data by checking its timestamp. Init data carries the Telegram user ID and name but not the phone number, so the phone is requested once with Telegram's "share contact".
- **Website login: Log In With Telegram**, which Telegram's documentation describes as standard OpenID Connect. Scopes: `openid`, `profile`, `phone` (verified phone, user consents), `telegram:bot_access` (lets the bot message the user). The server verifies the signed ID token. Only pre-registered website URLs work, and a strict cross-origin-opener header can break the popup.
- All entry points resolve to the same existing user and organization. Owner update (2026-10-24): website customers may use Telegram or login/password; they create credentials after Telegram sign-in. Mini App sign-in remains automatic after signature verification. The existing signed Telegram Login Widget verifier is reused; the OIDC direction above remains a future migration.
- Group membership is checked by the bot; what the bot is allowed to see in a group depends on its rights there (to verify in implementation).
### 3.7 Google Sheet integration

- Service account with **view-only** access, reading only the `Stock_Export` range (no cost columns, see data model 6.2).
- Scheduled sync every few minutes into `stock_cache`. The app never writes to the sheet.
- Check Google API quotas when the sync interval is chosen.
### 3.8 Hosting (not decided)

| Option | For | Against |
|---|---|---|
| **One VPS with Docker Compose** (app, worker, PostgreSQL, reverse proxy) | Cheapest, simple, full control. Fits the monolith. | You own backups, updates, monitoring. |
| Managed platform (PaaS + managed PostgreSQL) | Less operational work. | Higher cost; provider location matters (see below). |
| Kubernetes | Scales. | Far too heavy. |

**Data location needs a check before choosing.** The system stores names and phone numbers of people in Uzbekistan. Uzbekistan has had rules about storing citizens' personal data in the country, and the personal data law was amended in March 2026 to ease cross-border rules. I could not confirm the current text. Until a lawyer or the company's compliance person confirms it, plan to host the database in Uzbekistan.

**Deployment note (origin and CORS):** with two web apps (3.5) this note applies to each of them separately. Both build with base `/` and both use the same public files and some of the same route paths (for example `/orders`), so each app needs its own origin, such as one host per app in front of the same api [P]; serving both from one origin would need a path prefix for one of them first. The api configures no CORS today. Each web app (Mini App and website) must be served from the same origin as the api (for example the reverse proxy serves the built `apps/customer` or `apps/staff` and forwards `/api` to the api), or CORS must be added to the api with an explicit allow-list of the web origin before the two are split across origins. The api's root paths collide with the SPA's own (`/staff/...`), so the web app calls the api under a `/api` prefix (`VITE_API_BASE_URL=/api`) and the proxy strips it before forwarding (the Vite dev server does this; the production reverse proxy must do the same) [P].

Whatever is chosen: automated daily database backups with a tested restore, a staging environment separate from production, secrets in environment configuration (never in the repository), HTTPS everywhere.

### 3.9 Input validation

- **zod** is the single validation library, used at every boundary (HTTP, Telegram payloads, env config, Sheet rows). Schemas that api and web both need live in `packages/shared`, so the contract is defined once. Do not mix it with class-validator.

## 4. Security notes

- Server-side authorization on every endpoint; the UI hiding a button is not security.
- Customer queries are always scoped to the user's organization. An automated test must fail if one organization can read another's orders or prices.
- Cost data is staff-only. Customer endpoints return allow-listed fields; a test fails if a cost field appears.
- Telegram data is never trusted until its signature is verified. Bot token and OIDC client secret are secrets.
- Order status changes go only through one transition function (conditional update + event + outbox in one transaction).
- Audit log is append-only.
- **Two database roles in production (precondition for go-live, added 2026-10-20 after the Phase 1 review).** A *migrator* role owns the tables and runs migrations; the *app* role the running service connects with is a non-owner, non-superuser role with only SELECT/INSERT/UPDATE/DELETE on normal tables and only INSERT/SELECT on `audit_log` and `order_events` (no TRUNCATE, no ALTER, no DISABLE TRIGGER). The immutability triggers (published prices, append-only history) protect against application mistakes only if the app role cannot disable them. Local development and CI still use one superuser role for convenience; integration tests prove the triggers hold against a non-owner role.
## 5. Build approach

### 5.1 Repository and workflow

- One repository (monorepo): `apps/api` (backend + worker), `apps/customer` and `apps/staff` (the two web apps, see 3.5), `packages/shared` (types and constants shared by api and web), `packages/web-core` (frontend kit shared by the two web apps), `docs/`.
- Small, logically grouped changes, each with tests and a short summary of what was verified. No deploy or production data change without explicit approval.
- Architecture decisions recorded in `docs/architecture/` (this file is ADR-001).
### 5.2 Phases (value first)

| Phase | Scope | Result |
|---|---|---|
| 0. Foundations | Repo, CI (lint, type check, tests), environments, database and migrations, config and secrets, i18n skeleton, basic role framework | Empty but deployable app |
| 1. Catalog and prices | Sheet stock sync, products, price list versions, price history, manager price screen | Manager maintains the price list in one place |
| 2. Customers and Telegram | Bot in groups, organizations from groups, Telegram identity, daily price post and `/price` with Excel + web link | **First real value: manual Excel sending stops** |
| 3. Orders | Cart, submit, state machine, events, outbox, customer notifications, order timeline | Customers order and see status |
| 4. Staff workflows | Manager approve/edit/reject, accountant step with the manager's skip-accounting option, warehouse release with driver, driver delivered, customer received, PAID/UNPAID | Full lifecycle |
| 5. Hardening and pilot | Permission and isolation tests, load check, backups restore test, monitoring, pilot with 1–2 groups, then all groups | Production use |

Phases 1–2 deliver value (no more manual price files) before the order flow exists, and they exercise the Telegram and Sheets integrations early, where the main technical risk is.

### 5.3 Testing focus

- Unit tests: order state machine (every allowed and forbidden transition), permission matrix, manager accounting-skip rule, price calculation.
- Integration tests: organization isolation, idempotent submit, concurrent approval, outbox written with the status change.
- Manual or end-to-end smoke: Mini App login, website login, `/price`, one full order through all roles.
## 6. Risks

1. **Telegram dependency:** if Telegram is blocked or unavailable, customers cannot log in or get notifications. Mitigation: in-app timeline is the source of truth; consider a fallback login later.
2. **Sheet fragility:** the stock source is a wide, hand-edited sheet. Mitigation: `Stock_Export` with stable headers, sync health indicator (last sync time visible to managers).
3. **Single developer:** bus factor and review gaps. Mitigation: documentation, tests on the critical logic, small changes.
4. **Data location rules:** possible legal constraint on hosting (see 3.8).
5. **Unresolved business rules:** selling price derivation from cost, details of the skip-accounting option (lifecycle Q14). They do not block phases 0–2.
## 7. Open questions

1. Do you accept NestJS, or prefer the lighter Fastify option?
2. Hosting: own server or provider? Does the company have a server or a data-center contract in Uzbekistan? Who confirms the personal-data rules?
3. Is there a deadline or a date the first pilot should start?
4. Who deploys and monitors production?
5. Is a separate staging environment possible?
## 8. What would change this decision

- Several teams or very high load: reconsider splitting services.
- Telegram unavailable for customers: add another login channel (for example SMS).
- Online payments added: introduce a dedicated payments module with its own compliance work.
