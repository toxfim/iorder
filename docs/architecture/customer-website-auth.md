# Customer website authentication

Owner decisions, 2026-10-24: normal browser visitors can sign in using Telegram or login/password. Customers create their own credentials after Telegram sign-in. Mini App visitors continue automatically after the server verifies init data.

## Implementation

The identity module exposes customer-only `/customer/auth/password-login` and `/customer/auth/telegram-widget` endpoints. They reuse the existing scrypt password hasher, throttling, proof verification, replay protection and session storage. Existing table names `staff_credentials` and `staff_sessions` are retained; their rows already reference users without a staff-role database constraint. No migration or new dependency is required. Staff login endpoints continue to reject customer accounts.

Every customer Bearer request reads the active user and organization membership again. A blocked user, inactive organization, missing membership or ambiguous membership fails closed. Staff actors never acquire customer membership (a staff member in the customer app is a staff viewer, see "Staff in the customer app" below). Existing organization-scoped domain queries remain authoritative.

`GET /customer/auth/credentials` returns only the login and whether Telegram authentication permits editing. `PUT` accepts the caller's own login and password, never a target user id. Both routes require a customer actor. Password-authenticated sessions cannot set credentials; the customer signs in with Telegram again. Credential changes use one transaction for the hash, session revocations and audit event. Passwords and hashes never appear in responses or audit history. A new password must satisfy the existing 8–128 character policy; since 2026-10-28 [C] customer logins and staff logins are separate namespaces: a login is unique within its scope only and `/auth/password-login` looks only among staff logins, so "already taken" never reveals a staff login. Changed [C, 2026-11-09]: `/customer/auth/password-login` no longer looks only among customer logins; it also accepts a staff login and then opens a staff viewer session (next section). The credential routes are customer-only and have their own permission (`MANAGE_OWN_CUSTOMER_LOGIN`), so a staff member is turned away by the guard.

Tokens are validated against the server response schema and kept in the browser with an in-memory fallback (in `localStorage` since 2026-11-09, see "Session lifetime and where the token is kept"; in `sessionStorage` before). They never enter URLs or cookies. Logout clears local identity even when the server request fails. Customer API 401s clear the Bearer token and return website visitors to sign-in. Telegram widget code is lazy-loaded only on browser sign-in or reauthentication screens. Mini App startup does not mount it.

## Staff in the customer app (owner decisions, 2026-11-09)

Staff members may open the customer app (order.iorder.uz and the customer Mini App) [C]. They sign in with their existing STAFF login and password on the customer login form; "Continue with Telegram" and Mini App init data work for them too [C]. They see the catalog and the published prices, the cart works, placing an order is off with the reason shown, and orders and the amount to pay are empty [C]. They are not members of any organization and never see a real organization's orders, debt, discounts or members [C]. Staff may place orders only on staging, into ONE configured test organization; production never allows a staff order [C].

### The staff viewer actor

A staff member on a customer route is a **staff viewer**: an actor with NO staff roles and no membership, carrying only a `staffViewer` block (the roles the person really holds, kept for history, and the organization configured for staff orders or null). Two things produce it:

- **A viewer session.** A session a staff member opens at the customer door is stored with `staff_sessions.staff_viewer = true` (fixed at creation by the session trigger). It resolves to the staff viewer on EVERY route, so a token held by the customer site can never call a `/staff` route, whatever the person's roles. The staff door and its sessions are unchanged.
- **The customer area.** Routes of the customer app are marked `@CustomerArea()` (cart, orders, own balance, own goods, the customer price list, the customer credential routes). The global permission guard replaces a staff actor with the staff viewer on them BEFORE the permission check. This covers the Mini App, whose init data is the same in the staff and the customer app and therefore cannot say which app is calling.

**Production cannot be configured for staff orders** [C, 2026-11-09]. Staging and production both run `NODE_ENV=production`, so each installation states which one it is with `APP_ENVIRONMENT` (`staging` or `production`; empty means production). A deployed api refuses to start when `STAFF_ORDERING_ORGANIZATION_ID` is set and `APP_ENVIRONMENT` is not `staging`. Together with the check at use (an id this database does not have refuses), neither a copied staging line nor a production organization's id can switch staff ordering on in production.

**Becoming staff ends earlier sessions** (security review, 2026-11-09). A session a customer opened at the customer site carries no mark of that door. Before this rule, when the same person later got a staff role, the old token answered with the new staff roles on every `/staff` route. `assignStaffRole` now ends all sessions of a person who receives their FIRST staff role, in the same transaction, with a `STAFF_SESSIONS_REVOKED` audit row (`customer-session-promotion.int-spec.ts`). A further role for someone already staff ends nothing.

**Known limits, not changed here** (same review):
- [closable by configuration since 2026-11-09, OFF by default; switching it on needs the owner] In the Telegram Mini App one bot signs the init data for both apps, so the init data the CUSTOMER Mini App holds for a staff member is also valid on `/staff` routes for its lifetime. The "viewer never has staff power" rule holds for sessions, not for Mini App init data, until `STAFF_MINI_APP_BOT_TOKEN` is set: then only the staff bot's init data makes a staff actor (section "The staff Mini App" below).
- A failed password attempt at the customer door counts against the customer login and the staff login of the same text, so one can lock the other. Logins that exist in both scopes are expected to be rare [P].
- `carts.organization_id` is nullable for the staff viewer's personal cart; nothing in the database ties a NULL to a staff user (the application does).

The permission matrix has a third grant kind, `staffViewer`, on seven rows only; every other row stays closed to a viewer (`staff-viewer.spec.ts` pins the list, `staff-viewer-routes.int-spec.ts` sends a viewer to every registered route of the real AppModule).

| Route | What a staff viewer gets |
|---|---|
| `GET /me` | own profile plus `staffViewer: { canOrder, organizationName }`; `membership: null`, `needsContact: false` |
| `GET /auth/session`, `POST /auth/logout` | own session, sign out |
| `GET /price-list/current` | the published list through the customer DTO, identical to a customer's; no cost, rate, margin or supplier |
| `GET /cart`, `PUT/DELETE /cart/items/:productId` | a personal cart with no organization (`carts.organization_id` NULL, one per person) |
| `POST /orders` | 409 `STAFF_ORDERING_DISABLED` unless an organization is configured (below) |
| `GET /orders`, `GET /orders/:id`, `GET /orders/:id/timeline` | empty list / 404; where ordering is configured, only the orders the viewer placed there [P] |
| `GET /me/balance` | zero, without reading any organization's balance |
| `GET /me/products/summary`, `GET /me/products` | empty; a product or unit is 404 |
| everything else (every `/staff` route, receipt, plan change, own contact, customer credentials, discovery acknowledgement) | 403 |

Own name and phone [C, 2026-11-09]: a customer changes them in the customer profile (`PUT /me/contact`). A staff viewer does not: that route stays 403 for them, the customer profile shows their name read-only with the line "you change your name and phone in your profile in the staff app", and the staff app's own route (`PUT /staff/me/profile`, outside the customer area) does the change (`docs/domain/data-model.md`, "Own profile").

### Ordering: `STAFF_ORDERING_ORGANIZATION_ID`

One optional api setting (a uuid, empty by default; `.env.example`). Empty, as in production: the matrix condition `STAFF_ORDERING_ORGANIZATION` can never hold, `POST /orders` answers 409 `STAFF_ORDERING_DISABLED`, and nothing is written. Set (staging): the viewer's order is written to exactly that organization, by the same submit path as any order (one transaction with the `order_events` row and the `notification_outbox` rows), placed by the staff member and recorded in the staff role they hold; from then on it is an ordinary order of that organization. The organization is never taken from the request. An id that names no ACTIVE organization refuses (409 `ORDERING_ORGANIZATION_INACTIVE`) and `/me` reports `canOrder: false`; there is no fallback to another organization. The customer app only mirrors `canOrder`: the button is disabled with the reason, and the server refuses regardless.

### Sign-in at the customer door

`POST /customer/auth/password-login` looks the login up in BOTH scopes. The customer login is tried first, the staff login second [P]. A CUSTOMER login opens only a member session and a STAFF login only a viewer session. Kept from before: the per-address and per-login throttles, the lockout counters and schedule of each credential, the single answer for every failure ("Invalid credentials"), the audit rows, the re-read of the person under a row lock (blocked users, lost roles). Every failed attempt costs exactly two password checks (a real one per existing login, a dummy one per missing or locked login), so neither the answer nor the work shows whether a login exists or in which scope. A failed attempt counts against every login that was really checked; a successful one counts against nobody (a staff member whose login text a customer also uses does not lock that customer out). `POST /customer/auth/telegram-widget` and Mini App init data: the person's current roles decide, a staff member becomes a viewer.

### Decisions the owner did not state [P]

- Viewers are the staff roles that may browse the price list (manager, accountant, admin, purchasing manager). The warehouse and the driver never see a price anywhere (lifecycle 4.1, 5), so they are refused like anyone who is not a customer.
- The cart is personal and without an organization in both environments; it is not kept under the test organization even where one is configured.
- A viewer reads only the test orders they placed themselves, so the confirmation page after a staging order works. They do not confirm receipt or change the payment plan; a customer of the test organization or staff in the staff app does.
- The customer login wins when one login text exists in both scopes.
- A viewer session carries no staff power; to work as staff the person signs in on the staff site.
- A viewer is not asked for a contact (name and phone) before a test order.

## Session lifetime and where the token is kept (owner decision, 2026-11-09)

The owner: "I have to log in to the dashboard every time I open it. Make the token lifetime two weeks."

**The cause.** Two things, the first one decisive: both web apps kept the Bearer token in `sessionStorage`, which a browser throws away with the tab, so every new tab or browser start began signed out whatever the server allowed; and the server ended a session after 12 hours without use.

**The rule [C].** A person who opens the site at least once in two weeks is not asked to sign in again, also after closing the browser. It holds for the staff site and the customer site alike (one session table).

| Limit | Value | Why |
|---|---|---|
| Idle (`STAFF_SESSION_IDLE_SECONDS`) | 14 days [C] | the owner's two weeks; every use moves it forward (written at most every 5 minutes) |
| Absolute (`STAFF_SESSION_ABSOLUTE_SECONDS`) | 90 days [P] | so that the two-week rule is what people meet, while a copied token still stops working by itself within a quarter; rejected: 14 days (a daily user would sign in every two weeks, against the rule) and no limit at all |

Both can be set per installation (at most 180 days); a value in `api.env` REPLACES the default, so a server that still carries an old short value keeps asking people to sign in.

**Storage.** The token now lives in `localStorage` (one module, `@core/lib/session-token-store`, used by both apps), with the in-memory fallback as before; a token an older version left in `sessionStorage` is adopted once per page load and never after a sign-out in this browser (a sign-out leaves a marker that the next sign-in removes; security review 2026-11-10). It still never enters a URL or a cookie. The trade-off, accepted for the owner's rule: the token stays on the device until sign-out or until the server ends the session, so a shared computer needs a sign-out; a script running on the page could read it, as it could read `sessionStorage` before (the CSP of the vhosts allows scripts from the site itself and telegram.org only). Rejected [P]: an HttpOnly cookie, which a page script cannot read but which brings back a CSRF surface and needs the api, both apps and the proxy changed together.

**What ends a session early** is unchanged and tested again on a ten-day-old session (`staff-auth.int-spec.ts`): sign-out, a blocked person, the loss of the last staff role (for a viewer session: of the roles that open the customer app), a new password, a changed Telegram id, and "the first staff role ends earlier sessions". A 401 on any call clears the stored token and shows the sign-in page.

**Several tabs.** The token is now shared by every tab of the browser. A tab that hears (the `storage` event) that another tab signed in or out starts again, so it never keeps showing one person while the stored token belongs to another.

**Which credential a tab sends** (both apps, security review 2026-11-10). A website sign-in made in THIS tab wins (the person asked for it). Otherwise, while the tab holds Telegram's init data, the init data wins over a token found in storage: the token outlives the webview now, and a sign-in made earlier on a device must never speak for whoever opens the Mini App next. Only without init data is a stored token sent. A 401 ends only the credential the call carried: a refused init data (an unknown person in the Mini App, a forged `#tgWebAppData=` fragment opened in a browser) never drops a website token that other tabs may use, and the fragment alone never clears anything (a crafted link must not sign a customer out of every tab).

## Staff continue on the customer site with their dashboard sign-in (owner decision, 2026-11-09)

The owner: "When staff enter the order page they must continue automatically with their dashboard login." The staff site and the customer site are different origins with separate storage, so the customer site cannot see the dashboard session. A **one-time handoff** connects them. Its outcome is always a VIEWER session, exactly as if the person had signed in at the customer door with the staff login.

### The flow

1. **From the dashboard.** The sidebar shows "Mijoz sahifasi" (roles that may be viewers; hidden when the api names no customer site). Pressing it marks the intent (a one-shot mark in the tab's `sessionStorage`, which the new tab inherits) and opens `/handoff` of the staff app in a new tab.
2. **The handoff page** (`/handoff`, a staff route outside the shell) goes ahead by itself only on an intent of the person: the mark of step 1, or the customer site having sent them (its origin is the referrer, which no third-party page can forge). A bare navigation, which any website could cause, shows a button "Continue to the customer site" and does nothing until it is pressed (security review 2026-11-10). It then asks `POST /staff/customer-site/handoff` with the dashboard session and sends the browser to the address in the answer: the customer site with the code in the URL FRAGMENT (`<WEB_APP_URL>/#handoff=<code>`). A fragment is sent to no server and is in no referrer. Not signed in on the dashboard: the route guard shows the normal staff sign-in and returns here afterwards (the mark survives; a person sent by the customer site sees the button after signing in).
3. **On the customer site**, at start, the fragment is removed from the address bar before anything else runs, and the code is exchanged at `POST /customer/auth/handoff` for a session token. A session the handoff replaces is ended on the server afterwards (`POST /auth/logout` with the old token), so no live session is left behind. On failure the normal sign-in page shows with one short note; a person who was signed in stays signed in.
4. **Opening the customer site directly.** While a person who may be handed over is signed in on the dashboard, the staff app keeps a NON-secret hint cookie on the parent domain both sites share (`iorder_site_hint_<staff host>=1`, two weeks, renewed on every visit, removed on the dashboard's sign-in page). The customer site, only when it has no session, is not inside Telegram, has not tried in this browser within the last hour, and saw no explicit sign-out here within the last twelve hours (both `localStorage` marks, so they hold in every tab), looks for the hint; if there is one it asks `GET /customer/auth/handoff` for the staff site's handoff page and sends the browser there once. The page of step 2 does the rest and the person lands on the customer page they asked for (remembered in the tab's `sessionStorage`, never sent anywhere).

**The viewer session lives and dies with the dashboard session it came from** (security review 2026-11-10). `staff_sessions.source_session_id` records the dashboard session a handoff code turned into the viewer session (NULL for every session a sign-in door opened; fixed at creation by the session trigger). A sign-out of the dashboard session revokes every session whose source it is, in the same transaction, under the person's row lock (the same lock the exchange takes before it checks its source, so a sign-out racing an exchange cannot leave a child behind); the audit row of the sign-out counts them (`handedOverSessionsRevoked`). And every request with a session that has a source is refused once the source is revoked, idle or expired, so a lapsed dashboard session takes its children with it without any sign-out. A viewer session opened at the customer door has no source and is not touched.

### Security properties (each has a test, mostly in `apps/api/test/staff-handoff.int-spec.ts`)

- The code is 256 random bits, stored only as its SHA-256 (`staff_handoff_codes`), lives 60 seconds [P], and works once: one `UPDATE ... WHERE used_at IS NULL RETURNING` uses it up, so of two simultaneous exchanges exactly one succeeds. A code that reached the server is used up whatever the outcome.
- It is bound to the staff user AND to the dashboard session that asked: sign-out, a block, a new password or lost roles end the code with the session. The source session is checked again inside the transaction that opens the viewer session, under the person's row lock, so a revocation that commits a moment before cannot be outrun.
- It only ever opens a viewer session: the exchange has no parameter for anything else and reuses the customer-door code path (person re-read under the row lock; blocked staff and staff without a viewer role get nothing).
- It cannot turn a viewer session back into a staff session: asking for a code is a `/staff` route with its own action `OPEN_CUSTOMER_SITE` (the staff roles that browse the price list), which has no viewer grant, and the service refuses a viewer session as the source.
- It needs a website session: Mini App init data and API tokens get no code (inside Telegram the customer Mini App signs the person in by itself) [P].
- A used, expired, unknown or malformed code gets one answer, byte for byte the answer of a wrong password.
- Throttled like the sign-in endpoints: asking, 10 per person per minute [P]; exchanging, the sign-in throttles (per address, the global failure cap), failures only.
- **No open redirect.** Neither address is ever taken from a request, a cookie or storage: the api builds both from its own configuration (`WEB_APP_URL`, `STAFF_WEB_APP_URL`). The request body of the issuing route is strict and empty (a `returnTo` is a 422), and the web apps leave only for an http(s) address the api named.
- The hint cookie is not a credential: its value is never read, no address comes from it, and forging it buys one redirect to the staff sign-in page. A visitor without it is never sent anywhere and causes no request. At most one automatic attempt per browser session, so no loop.
- History: `STAFF_HANDOFF_ISSUED` (entity `STAFF_HANDOFF`, by the person, with the session id and the expiry, never the code); the exchange writes the usual `CUSTOMER_SESSION_CREATED` row with `staffViewer` and `handoff` (the code row's id); a refusal writes `AUTH_SIGN_IN_FAILED` with method `STAFF_HANDOFF` (aggregated per minute when no person is known).
- Codes are not history (the audit log is): when a person asks for a new code, their codes that were used, or expired, more than a day ago are deleted in the same transaction (there is no cleanup job to put this in). The trigger allows exactly that deletion and refuses an earlier one; a fresh row still cannot be deleted or rewritten.

### Known limits [P]

- **Whoever opens a fresh code is signed in as its owner's viewer.** As with every sign-in started from the other side, a staff member could send somebody the customer site address with their own unused code; the person who opens it within the minute is then signed in as that staff member's VIEWER (published prices and a personal cart, no staff power, no organization data) and loses their own sign-in on that device (that session is ended on the server as well). It needs an insider, gains nothing a viewer does not already have, and is in history under the insider's name. Accepted; closing it would mean the dashboard click no longer works on a device that is already signed in on the customer site.
- **A hint cookie with another `Path` cannot be cleared.** `clearSiteHint` expires the hint on `Path=/` and on every parent domain of the staff host; a hint somebody set by hand with another path stays. All it does is make the customer site try once: the one-attempt-per-browser-and-hour guard and the twelve-hour hold after a sign-out are the protection, and the trip ends on the staff sign-in page.
- **A session ended on the dashboard while the customer site is open** is noticed by the customer site on its next request (a 401), not at once.
- **The dashboard address is public.** `GET /customer/auth/handoff` names the staff site to anybody who asks (as a build variable in the customer bundle would).
- The throttles and the one-request-per-tab rule are per process and per browser tab; they slow abuse down and are not the security boundary (the code's own properties are).

### Configuration

No new variable. The web apps learn each other's address from the api at run time, which reads the two settings that already exist for bot links:

| Setting (api) | Needed for | When missing |
|---|---|---|
| `WEB_APP_URL` | the handoff itself (the customer site address) | the sidebar entry is hidden, `POST /staff/customer-site/handoff` answers 404 |
| `STAFF_WEB_APP_URL` | the automatic handoff when the customer site is opened directly | nobody is ever sent to the staff site; the click from the dashboard still works |

Both sites must share a parent domain for the hint cookie (`dashboard.iorder.uz` and `order.iorder.uz` share `iorder.uz`). On localhost and IP addresses no hint is written or read: local development and the fake API mode never bounce.

### Decisions the owner did not state [P]

- The addresses come from the api at run time instead of two new build variables (`VITE_...`), so the servers need no new configuration and the two ends cannot disagree.
- The session opened by a handoff keeps the sign-in method of the dashboard session it came from (no new value in `staff_sessions.method`); history marks it as a handoff.
- The dashboard entry opens a new tab and the code is asked for by the page that opens, never ahead of time (a code asked for on page load would be stale by the click).
- An explicit sign-out on the customer site is honoured for that tab only; a new tab continues automatically again while the dashboard session lives.

## Development and operation

The localhost web demo still uses fake APIs. Demo credentials live in memory for the current page lifetime and are discarded on reload; they do not create a real server account. The demo stores only a SHA-256 digest for comparison, not a plaintext password; real authentication always uses the existing server scrypt hasher. Real Telegram login requires the bot token on the API, `VITE_TELEGRAM_BOT_USERNAME` on the web and an allowed website domain configured with Telegram. When the bot username is absent, the screen explicitly reports that Telegram sign-in is not configured.

Customer self-registration and organization creation are not introduced. Telegram must resolve an existing active customer. Losing Telegram access does not grant a public credential-reset path.

## Verification

Unit/component coverage includes credential write authorization, hash-only persistence and transactional audit/revocation, fresh organization membership on Bearer requests, browser form submission, repeated-password validation, Telegram reauthentication, session token storage and logout. PostgreSQL integration tests cover both login methods, proof replay/forgery, customer/staff separation, credential uniqueness and session revocation; running them requires the local test database on port 5433.


## Login UI and local verification (2026-10-26)

Both apps now use the shared responsive login layout and password form. Website password and Telegram Login Widget requests still use the existing public endpoints (`/auth/password-login`, `/auth/telegram-widget` for staff; `/customer/auth/password-login`, `/customer/auth/telegram-widget` for customers). The widget payload is sent unchanged. Successful customer login reloads `/me` with the validated Bearer token; staff adopts the server's roles and honors only a permitted internal redirect. Mini App init-data authentication remains automatic.

## Two bots for the two websites (2026-11-06)

Telegram allows ONE Login Widget domain per bot (`/setdomain` in BotFather), and a parent domain does not cover its subdomains (`iorder.uz` gave "Bot domain invalid" on `dashboard.iorder.uz`). The customer website (`order.iorder.uz`) keeps the main bot, so the staff website (`dashboard.iorder.uz`) uses a second bot that does nothing but sign staff in: `STAFF_LOGIN_BOT_TOKEN` (api, verifies the staff widget proof) and `VITE_STAFF_TELEGRAM_BOT_USERNAME` (the widget on the staff login page, a `deploy.env` build argument). Each site accepts proofs of its own bot only (`/auth/telegram-widget` → the login bot, `/customer/auth/telegram-widget` → the main bot; integration test in `staff-auth.int-spec.ts`). Everything else — staff notifications, the `t.me/<bot>?start=` link that connects a staff member, group membership, both Mini Apps — stays on the main bot: a Telegram user id is the same in every bot, so a staff member signed in through the login bot is the same `users` row the main bot notifies. Both settings empty: the staff widget uses the main bot, as before. BotFather setup: main bot `/setdomain order.iorder.uz`, login bot `/setdomain dashboard.iorder.uz`.

## The staff Mini App (owner request, 2026-11-09)

Owner [C, 2026-11-09]: every staff member has a Telegram id attached, and staff use the staff app as a Telegram Mini App too, signed in automatically.

### Why the staff app asked for a login inside Telegram (traced 2026-11-09)

1. **No staff Mini App was registered.** A page receives Telegram's init data only when Telegram launches it as a Mini App: a `web_app` button in a private chat, the bot's menu button, or a direct link `t.me/<bot>/<app>` registered in BotFather. The only registered Mini App (`TELEGRAM_MINI_APP_URL`, `t.me/<bot>/app`) is the CUSTOMER app. The staff address had one Mini App entry: the `web_app` button "Open in the Mini App" under a staff order notification, which administrators never receive (lifecycle 6.1). Every other way of opening the staff address inside Telegram (the "Open on the website" `url` button, a pasted link) is Telegram's in-app browser: no init data, so the app correctly saw nobody and showed the form.
2. **The app did not behave as a Mini App.** It read the init data and sent it (`Authorization: tma`), and the api resolved a linked staff member, but: it never told Telegram it was ready or asked for full height; a stored website session that had ended was not followed by the init data (the form came up although Telegram could have signed the person in); and every refusal (Telegram id not linked on an account created before 2026-10-28, blocked, unknown, init data older than `TELEGRAM_INIT_DATA_MAX_AGE_SECONDS`) ended on the bare login form with no explanation.

### What the staff app does inside Telegram

- Start-up (`apps/staff/src/app/telegram-launch.ts`): reads the launch fragment, sends `web_app_ready` / `web_app_expand`, follows Telegram's safe areas and back button, and opens the page the launch asked for. A direct link with `?startapp=order_<order id>` opens that order (the same start value as the customer Mini App's order link, one definition in `@iorder/shared`: `orderStartParam`, `orderIdOfStartParam`); a `web_app` button opens its own address. Any other start parameter is ignored. The parameter only chooses a screen.
- Sign-in: `GET /auth/session` with the init data, no form, on first open and on return. A website session of the tab that ended gives way to the init data (start-up and while the app is open).
- Refusal [P]: a launch the server did not sign in as staff gets the screen `/telegram-sign-in` instead of the form. The server answers every reason identically (401), so the screen does not guess: it lists what to do (reopen from Telegram; ask a manager or administrator to link the Telegram id, which is shown, read unverified from the launch; or sign in with login and password, one button away, which drops the Telegram identity of the tab). Someone signed in without a staff role (a customer, or a main-bot launch while a staff bot is configured) sees the same screen with the "for staff only" wording. Outside Telegram nothing changed: the form, the widget, the `/forbidden` page.
- Screen: the app keeps its own light/dark setting and paints Telegram's header in the top bar's colour; bars pinned to the top or bottom add `--safe-top` / `--safe-bottom` (`packages/web-core/src/styles/base.css`: `env()` plus Telegram's safe areas, which its webview reports only through events); Telegram's back button does what the page's own back link does (`AppBackLink`, staff app only).

### The notification button

The api builds "Open in the Mini App" of a staff message in the one button builder (`notifications/order-buttons.ts`; the link and the bot fact come from `WebLinks.staffOrderMiniApp` and `WebLinks.staffWebAppSignsIn`):

| `TELEGRAM_STAFF_MINI_APP_URL` | `STAFF_MINI_APP_BOT_TOKEN` | Button |
|---|---|---|
| set | either | `url` button `<link>?startapp=order_<id>`: Telegram opens the staff Mini App, signed by the bot the link belongs to |
| empty | empty | `web_app` button of the main bot with the order address, as before 2026-11-09 [P: kept so nothing changes until the owner registers the Mini App] |
| empty | set | no Mini App button, only "Open on the website" (a main-bot launch would sign nobody in) |

### Binding staff sign-in to a staff bot (`STAFF_MINI_APP_BOT_TOKEN`, OFF by default)

Not set: exactly as before, `BOT_TOKEN`'s bot signs both Mini Apps. Set (a second bot, never the same token as `BOT_TOKEN`; the api refuses to start otherwise):

- Init data signed by the staff bot makes a **staff actor** and nothing else. A customer who opens the staff bot's Mini App is nobody (401): it is not a customer door. On customer-area routes the guard turns the staff actor into the viewer as for any staff actor.
- Init data signed by the main bot makes a **customer member** or, for a staff member, the **staff viewer** on EVERY route (the same actor a viewer session gives), never a staff actor. Warehouse and driver, whose roles do not open the customer app, are nobody, like their viewer session.
- One setting can serve the Login Widget and the Mini App: the SAME bot may be `STAFF_LOGIN_BOT_TOKEN` and `STAFF_MINI_APP_BOT_TOKEN` (put the same token in both). They stay two settings [P] because `STAFF_LOGIN_BOT_TOKEN` is already set in production: reusing it would have switched the binding on at deploy and broken the main bot's `web_app` buttons. Rejected: a boolean "the login bot also hosts the Mini App" (a second way to say the same thing).
- Tests: `telegram-actor.resolver.spec.ts` (both bots, every role), `staff-viewer-routes.int-spec.ts` (the real AppModule with the production resolver: main-bot init data of each staff role against every registered route; staff-bot init data on staff and customer routes; a customer through each bot), `env.spec.ts`.

### The staff bot's `/start` (owner request, 2026-11-10)

Production uses option B below: `@iorder_staff_bot` is the staff bot (Login Widget and Mini App, `t.me/iorder_staff_bot/app`), `@iOrder_uzbot` the customer bot. Until 2026-11-10 the staff bot received no updates, so `/start` in its chat did nothing. Now, with `STAFF_BOT_WEBHOOK_SECRET` set and the webhook registered, it answers a private command (module `telegram/staff-bot/`):

- Language first [C, owner 2026-11-13, both bots]: a private `/start` answers "Tilni tanlang / Выберите язык / Choose a language" with three buttons in one row ("🇺🇿 O'zbekcha", "🇷🇺 Русский", "🇺🇸 English", flags since 2026-11-14 [owner]; inline buttons with `callback_data` `lang:<uz|ru|en>`). A press saves the language for a person who has a `users` row (audited `USER_LANGUAGE_CHANGED`, by the person, only when it changes; nobody is created by a press), removes the buttons, and gives the answer below in the chosen language, with what each command does ("/start: tilni tanlash va ilovani ochish", "/lang: tilni o'zgartirish", "/help: ilova tugmalari va shu yordam"). `/help` gives the same answer at once, in the stored language. `/lang` [owner 2026-11-14] asks the same question at any time, with no payload (both bots; a group `/lang` on the main bot gets the command list, since a press counts only in a private chat and groups speak UZ [P]).
- Command menu [owner 2026-11-14]: Telegram's menu next to the message field (`setMyCommands`) lists `/start`, `/lang`, `/price` on `@iOrder_uzbot` and `/start`, `/lang` on the staff bot (no `/price` there); `/help` still answers but is not listed. UZ is the default list, RU and EN are set under their language codes (Telegram picks by the language of the person's Telegram app). One module, `modules/telegram/bot-command-menu.ts`. Deployment step, once per environment after the menu changes: `node dist/cli/bot-set-commands.main.js --confirm` inside the api container (`pnpm --filter @iorder/api bot:set-commands -- --confirm` locally).
- An ACTIVE person with a staff role (found by the Telegram id): "Xayrli tong, <first word of the stored name>!", the command list, "iOrder ilovasini oching:" and ONE row of two buttons [C, owner 2026-11-10]: "Brauzerda ochish" (a `url` button, no colour) and "Ilovada ochish" (a `web_app` button, `style: "primary"`, blue). Both open `STAFF_WEB_APP_URL/`; the `web_app` launch is signed by the staff bot, so it signs the person in. The owner offered "Xayrli tong, <name>" or "Xayrli tong boss"; the name was chosen because every staff member gets the message.
- [P] The greeting follows the Tashkent time: "Xayrli tong" 05:00-10:59, "Xayrli kun" 11:00-17:59, "Xayrli kech" 18:00-04:59 (no "Xayrli tun", which is a farewell). Language: the person's stored language (RU "Доброе утро/день/вечер", EN "Good morning/afternoon/evening").
- Anybody else (unknown, a customer, a blocked staff member) gets only "Bu bot faqat iOrder xodimlari uchun." with no link. Groups and plain messages are ignored. The only thing the bot writes is the chosen language (above); a failed reply is logged by kind only; at most 5 commands and presses per chat in 10 seconds.
- Route `POST /telegram/webhook-staff/<secret>` with the same proof as the main webhook (URL segment AND header, constant time); 404 without the staff bot, the secret, or webhook mode. Registration (once, by the person deploying): `setWebhook` of the STAFF bot with `url=https://dashboard.iorder.uz/api/telegram/webhook-staff/<secret>` (any host that proxies `/api` works), `secret_token=<secret>`, `allowed_updates=["message","callback_query"]` (the second since 2026-11-13: without it the language buttons do nothing, so the webhook must be registered again). Local polling for the staff bot is not built.

### The customer bot's private `/start` (owner request, 2026-11-13) [C]

`@iOrder_uzbot` asks the language the same way: a private `/start` answers the trilingual question with the three buttons, and a press saves the language (as above) and answers with the app link and what each command does (`/start`, `/lang`, `/price`, `/help`). A deep link is handled only AFTER the choice, in the chosen language: the payload of a PERSON invite (`org_<token>`) or of the staff "turn on notifications" link (`staff_<token>`) rides in each button's data (`lang:<code>:<payload>`, at most 64 bytes, which both fit; a longer payload would be handled at once as before [P]), and the press binds or connects, answering the outcome with the command list in one message. Button data is untrusted: strictly parsed, only these two payload kinds are acted on, and the token services check the token as for a typed `/start`. A group `/start` (including the one Telegram sends when the bot is added through a group invite) is unchanged: no question, the group binds at once. Without a bot token nothing is asked and an invite still binds at once. The main webhook must be registered again with `allowed_updates=["message","my_chat_member","chat_member","callback_query"]` (`ALLOWED_UPDATES`).

### Owner steps (BotFather and server)

Nothing below is done by the code; until it is done the app behaves as before. In every step the Web App URL is the staff app's address and `<short>` is the short name typed in BotFather (suggested: `staff`).

**A. One bot (simplest; the limit above stays open).** In BotFather: `/newapp` → choose the MAIN bot of the environment → title "iOrder Staff", a description, a 640×360 picture, no GIF → Web App URL (staging `https://dev.dashboard.iorder.uz/`, production `https://dashboard.iorder.uz/`) → short name `staff`. On the server add to that environment's `api.env`: `TELEGRAM_STAFF_MINI_APP_URL=https://t.me/<main bot>/staff`, then restart the api and the worker.

**B. A staff bot (closes the limit; recommended for production).** Use the bot that already signs staff in on the website (production `@iorder_staff_bot`; staging needs its own second test bot, created with `/newbot`). In BotFather: `/newapp` → choose THAT bot → same title, picture and Web App URL as in A → short name `staff`; optionally `/setmenubutton` → that bot → the same URL, so the bot's chat has an "open" button for administrators, who get no notifications. On the server add to `api.env`: `STAFF_MINI_APP_BOT_TOKEN=<that bot's token>` (in production the same value as `STAFF_LOGIN_BOT_TOKEN`) and `TELEGRAM_STAFF_MINI_APP_URL=https://t.me/<that bot>/staff`, then restart the api and the worker. Effects to expect: "Open in the Mini App" buttons under messages sent BEFORE the switch are main-bot launches and now end on the refusal screen (the button of every later message works); staff who open the customer Mini App stay viewers there. Staff do not have to start the staff bot to open its Mini App; notifications keep coming from the main bot.

Either way, staff can also open `https://t.me/<bot>/staff` directly (worth pinning in a staff chat). Not verified here: a real Telegram client (no real Telegram call is made by tests), so the first launch on a phone is the owner's check.

The decorative login illustration was replaced on 2026-10-28 with the owner's `Order delivery animation request.zip` composition: phone order, packing, truck loading, departure, and confirmation/logo. The shared `OrderJourney` implements its ten-second loop in Vue/SVG and CSS without the export's React/editor runtime or external font requests. Its confirmation caption is translated in UZ/RU/EN and is not a live order notification. Reduced-motion users see a static phone; the loop continues while a login control is focused (owner update, 2026-10-28). The existing layout still hides the illustration below 1200px.

Vite reads environment files from each app's folder, not the repository root. For a local real-API check, copy each app's `.env.example` to its `.env.local`, set `VITE_USE_REAL_API=true` and the public `VITE_TELEGRAM_BOT_USERNAME`, and restart that app. `VITE_USE_FAKE_API=true`, if set, takes precedence and must be removed for this check. Run the API on port 3000; Vite proxies `/api` to it from customer port 5174 and staff port 5173. Keep the secret `BOT_TOKEN` only in the API's root environment. Real Telegram website login also needs the matching website domain registered with the bot. An absent bot username is reported explicitly rather than replaced by a fake sign-in button.

Auth integration verification passed 53 tests across `customer-auth.int-spec.ts`, `staff-auth.int-spec.ts`, and `telegram-auth.int-spec.ts` against the real local PostgreSQL test database. These tests use locally signed test Telegram proofs, not a person's live Telegram authorization. A live Telegram consent flow and the registered domain have not been verified. Do not interpret a development demo identity as a real account.
