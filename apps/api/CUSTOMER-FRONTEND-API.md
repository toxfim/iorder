# Customer frontend API handoff

Date: 2026-10-25. Audience: backend implementation (Claude).

The current change implements **customer frontend only** in `apps/customer`. No API controllers, services, database schema or migrations are changed. The wire shapes below are **proposed contracts for integration**, not evidence that endpoints already exist. Canonical zod schemas and types are in `packages/shared/src/contracts/customer-goods.ts`; import them rather than duplicating shapes.

## Confirmed product behavior

- My Products is a history of goods delivered to the caller's organization. It is not stock, resale history or warranty tracking.
- Both mobile and desktop list **product groups**, never one top-level product row per IMEI. Selecting a group opens a **separate page**, not an accordion.
- Search supports product name/code and IMEI/SN/MK. A physical unit can contain multiple identification codes (for example IMEI slots); keep those codes grouped under that unit.
- The profile link is always present. The Orders link appears only when the received-goods collection is nonempty, independently of the current order filter/search/page.
- Empty before first delivery and zero search matches are different UI states.
- After the first receipt, introduce My Products. The approved design uses a dismissible sheet with View My Products / Later; the exact server persistence policy below is a proposal.
- Customer history has only order placed, order confirmed and delivered timestamps. Warehouse/accounting steps and staff internals are not displayed. Preserve full internal audit/event history.

## Authentication and isolation

Reuse existing verified Mini App `Authorization: tma <initData>` and website `Authorization: Bearer <token>`. Resolve organization from the authenticated actor, never from a customer-supplied organizationId. Scope **every** lookup, code search, group, count, cursor and detail query by active organization membership. Staff must not enter customer-only routes.

Use explicit allow-listed DTOs. Never return cost, purchase price, supplier, margin, exchange rate, accounting skip/mode, payment method, internal staff identifiers or raw event payloads. Use the same 404 for missing/foreign product or unit; search for a foreign code returns no match and does not reveal another organization.

## Proposed endpoints

All reads are `Cache-Control: no-store`. IDs are UUIDs, timestamps ISO 8601 UTC (the frontend formats Asia/Tashkent). Money remains decimal strings UZS in the existing order APIs. Product counts refer to historical received physical units, not current stock.

### GET /me/products/summary

```json
{
  "hasProducts": true,
  "productCount": 3,
  "unitCount": 7,
  "discoveryPending": false
}
```

This summary is **unfiltered**. `hasProducts` drives the Orders entry. Never derive it from a paginated list or search result. Keep counts and boolean consistent. `discoveryPending` should be true only when eligible received goods exist and this caller has not acknowledged the first-receipt introduction. Suggested scope: authenticated user + organization; persist server-side so it works across devices. The UI does not infer first receipt from order counts or store sensitive goods data in localStorage. Errors hide the optional Orders link; Profile remains available and the goods page offers retry.

### GET /me/products?search=&cursor=&limit=20

```json
{
  "products": [
    {
      "productId": "11111111-1111-4111-8111-111111111111",
      "productCode": "SAM-A17-128",
      "name": "Samsung Galaxy A17",
      "icon": "phone",
      "unitCount": 4,
      "codeCount": 4,
      "codeKinds": ["IMEI"],
      "lastDeliveredAt": "2026-10-24T10:20:00.000Z"
    }
  ],
  "nextCursor": null
}
```

Group by stable productId **before pagination**. A code match returns its product group; group counts describe the complete own-organization group, not just matching units. `icon` presentation hints: phone/headphones/tv/box; box is the generic fallback. Suggested sorting: latest delivery descending, productId tie-break. Cursor is opaque to the frontend, deterministic and query-bound. Names should follow the request locale/existing localization convention. Products with no codes may still appear if received; do not fabricate codes.

### GET /me/products/:productId?search=&cursor=&limit=20

Returns `{ product: CustomerGoodsGroup, units: CustomerReceivedUnit[], nextCursor: string | null }`. Scope the product to the organization even when the unit search is empty. Search filters units within that product by any of their code slots; a product-name match can include all its units. The separate product page shows the product heading, full group count, search field and physical unit rows/cards.

### GET /me/products/:productId/units/:unitId

Returns `{ product: CustomerGoodsGroup, unit: CustomerReceivedUnit }`. A unit must belong to both the requested product and the caller's organization. Full unit shape:

```json
{
  "id": "22222222-2222-4222-8222-222222222222",
  "unitNumber": 1,
  "codes": [{ "kind": "IMEI", "slot": 1, "value": "353918000104281" }],
  "orderId": "33333333-3333-4333-8333-333333333333",
  "orderNumber": "IO-1048",
  "milestones": {
    "orderedAt": "2026-10-23T05:42:00.000Z",
    "confirmedAt": "2026-10-23T06:08:00.000Z",
    "deliveredAt": "2026-10-24T10:20:00.000Z"
  },
  "receivedAt": "2026-10-24T10:25:00.000Z"
}
```

Code kinds are IMEI/SERIAL/MARKING (display labels IMEI/SN/MK). Keep code values as strings, including leading zeros and exact content required for copy/search. `slot` distinguishes multiple codes of one kind on one physical unit. Stable unit IDs must survive pagination and code corrections. Do not use codeValue as an ID. `unitNumber` identifies a unit within its source order line; it is not a global sequence across all orders.

Milestones come from real customer-visible events; absent times are null. Never infer confirmation/delivery from `updatedAt`, assume delivery at receipt time, or return warehouse/accounting times instead. The UI shows a pending label for absent events. `receivedAt` is separate from driver delivery; only return its actual timestamp.

### POST /me/products/discovery/ack

No body; 204. Idempotently record this caller's acknowledgement after the sheet is dismissed or opened. Record the change in the audit transaction, without codes or secrets. Do not mark it seen just because summary was fetched. Failed acknowledgement leaves it eligible for a future visit; the current view must remain usable. Repeated acknowledgements should not duplicate history rows.

## Existing orders APIs

Continue supporting existing `GET /orders`, `GET /orders/:id`, `GET /orders/:id/timeline` and `POST /orders/:id/receive` with expectedRowVersion and current permission rules. The frontend currently projects the legacy timeline into three milestones: SUBMITTED, first MANAGER_APPROVED, first DELIVERED, sorted by occurrence time. Keep rejection/cancellation reasons available separately from this simplified history. The frontend does not change transitions or grant receipt/cancellation permissions.

After successful receipt the frontend refreshes summary; make received goods and discovery eligibility visible consistently with the committed receipt. Do not call external providers inline. Existing order DTOs remain strict and unchanged by this frontend work.

## Decisions still requiring backend/product confirmation

- Exact eligibility cutoff: driver DELIVERED vs customer RECEIVED. Frontend consumes API eligibility, not a hardcoded production status filter. Demo fixtures currently model RECEIVED whole physical units only.
- Warehouse scan validation, duplicate rules, corrections and final code visibility before delivery remain proposals in `docs/private/product/spec-serial-tracking.md`. This handoff does not authorize all of that draft.
- Define how quantity-only/fractional goods map to received physical units; do not manufacture unit codes or silently round quantities.
- Confirm discovery persistence/ack scope and retention. The API fields above are the proposed cross-device solution.

## Required backend tests

Real PostgreSQL tests for organization isolation on every endpoint, foreign code search/ID non-disclosure, customer allow-list/cost-field leak checks, received eligibility, grouping before pagination, stable query-bound pagination, multi-slot units, no codes for untracked goods, correct milestone timestamps, and idempotent audited discovery acknowledgement. Existing receipt transaction/outbox/idempotency tests remain required.

## Frontend integration

`apps/customer/src/features/customer-goods/api/customer-goods-api.ts` is the HTTP adapter. `CustomerGoodsApi` is injected through the existing customer services. The fake adapter is dev/test-only; it must never ship in a normal production build. There is no production fallback to fake goods when endpoints are unavailable. Missing endpoints produce a retryable page error and leave the optional Orders shortcut hidden.

## Backend status (Claude, 2026-10-25)

All five endpoints are implemented in `apps/api/src/modules/orders/customer-goods.*` with real-PostgreSQL integration tests (`apps/api/test/unit-codes.int-spec.ts`). Answers to the open points above:

- **Eligibility:** owner decision [C] 2026-10-25: a unit appears once its order is `RECEIVED` (customer confirmed), not at driver `DELIVERED`.
- **Units:** one row per physical piece, created when the manager approves the order, also for quantity goods (no codes). Codes are scanned by the warehouse per unit while picking (release is blocked until the product's required codes are there). `unitNumber` = piece number within the order line.
- **Quantities are whole pieces only** (owner: "bizda kasr miqdor bo'lmaydi"). The cart and manager edit now use `wholeQuantityStringSchema` (`2` / `2.000` accepted, `2.5` → 422). `apps/customer/src/features/customer-cart/domain/quantity-input.ts` still parses with `quantityStringSchema` and accepts `2,5`: please switch it to `wholeQuantityStringSchema` and adjust its tests/strings.
- **Query:** `customerGoodsQuerySchema` (`search` ≤ 512, `cursor`, `limit` 1–50, default 20) is now in `packages/shared/src/contracts/customer-goods.ts`. A cursor reused with a different search/product answers **422** `VALIDATION_FAILED` (path `cursor`).
- **Search:** product name / code (ILIKE) or a live code value (ILIKE) or its normalised key (spaces removed, upper-case), so `4901 5420 3237 518` finds the IMEI. List: groups whose units match, counts are the full group. Product page: a product name/code match keeps all units, otherwise only units whose codes match.
- **name / productCode:** the order-line snapshot of the latest delivery (what the customer saw when ordering), not a live translation; there is no `lang` parameter.
- **icon:** `phone` when the group has IMEI codes, otherwise `box` (`headphones` / `tv` are never sent yet).
- **Milestones:** first `MANAGER_APPROVED`, first `DELIVERED`, first `RECEIVED` event times; `orderedAt` = submit time. `lastDeliveredAt` = delivered time (fallback received, then submit) of the newest unit.
- **Ordering:** groups by `lastDeliveredAt` desc, productId desc; units by delivered time desc, unit id desc.
- **Discovery:** stored server-side per (user, organization) in `customer_goods_discovery_acks`; the first ack writes one `audit_log` row (`CUSTOMER_GOODS_DISCOVERY_ACKNOWLEDGED`), repeats write nothing; `discoveryPending` = has received goods and this person has not acknowledged.
- **Errors:** staff on these routes → 403; foreign or malformed product/unit id → 404; responses carry `Cache-Control: no-store`.
- **Fixture note:** the demo IMEI `353918000104281` in the handoff/fixtures fails the Luhn check the server enforces (strict); `353918000104287` is valid.
- **Seen in the real-API browser run (2026-10-25):** the My Products introduction sheet showed a broken image: `apps/customer/public/` is not served, because the customer `vite.config.ts` sets `publicDir` to `packages/web-core/public`. Also, on the customer login form, a mouse click on «Kirish» and Enter did not submit while `form.requestSubmit()` did. This was through browser automation and may not happen with a real mouse, but please check.

## Stock figure and quantity limit (2026-11-09)

Every item of `GET /price-list/current` and every cart line has `orderableStock`: how many WHOLE pieces can be ordered now, as a JSON integer, or `null`. `0` means OUT OF STOCK: say so in words ("Qolmagan"), keep the product visible, and do not let it into the cart (the server refuses with 409 `STOCK_LIMIT_EXCEEDED` and `orderableStock: 0`); a cart line with `problem: "STOCK_EXCEEDED"` and `orderableStock: 0` can only be removed. `null` means "show nothing and do not limit": the stock is unknown or not tracked, and such a product can be ordered in any quantity. Do not label these products in any way, and never show them as out of stock. The figure is a total over all customers (free stock after the holds of approved orders); it moves by itself, so take it from the latest cart answer for a product that is in the cart.

- `PUT /cart/items/:productId` with a quantity above the figure: 409 `STOCK_LIMIT_EXCEEDED`, `details.lines = [{ "productId": "...", "orderableStock": 12 }]` with the CURRENT figure; the cart is unchanged. The same answer when a line already above the figure is lowered but not far enough.
- A cart line whose quantity is above the figure (the stock fell later) has `problem: "STOCK_EXCEEDED"`. Unlike the other problems it KEEPS `unitPrice`, `lineTotal`, the deferred amounts and `rrp`, and it counts in `totalAmount`; `canSubmit` is false until the quantity is set to `orderableStock` or lower (or the line is removed when the figure is 0).
- `POST /orders` reads the stock again: 409 `STOCK_LIMIT_EXCEEDED` with every line above its figure in `details.lines`; no order is created, the cart stays. Nothing is reserved by a cart or by a submitted order.
- Orders, the order list and the timeline never carry a stock figure.

## Payment plan (2026-10-30)

`POST /orders` needs the body `{ "paymentPlan": "FULL" | "DEFERRED", "expectedTotalAmount": "<the total shown for that plan>" }` (no defaults; 409 `CART_TOTAL_CHANGED` with `details.currentTotalAmount` when it moved, no order created; a replay of the key still returns the order). `PUT /orders/:id/payment-plan` with `{ paymentPlan, expectedRowVersion }` changes the plan inside the window (409 `PAYMENT_PLAN_WINDOW_ENDED`, `PAYMENT_PLAN_NOT_CHANGEABLE`, `ORDER_CHANGED`, `DEFERRED_PRICE_UNAVAILABLE`). The order answer has `paymentPlanChangeableUntil` and `paymentPlanTotals` (`{ FULL, DEFERRED }`), both null outside the window. `GET /cart` also answers `deferredTotalAmount` (null = the plan cannot be chosen) and, per line, `deferredUnitPrice` and `deferredLineTotal`. Since 2026-11-09 every cart line and every item of `GET /price-list/current` also has `rrp`: the recommended retail price of ONE piece in UZS as a money string, or null when the product has none (always null on a cart line with a `problem`). It is information to show next to the line; it is in no total and in no order. Orders and the order list carry `paymentPlan`; the timeline has `PAYMENT_PLAN_CHANGED` with `paymentPlanChange`. Refusal: 409 `DEFERRED_PRICE_UNAVAILABLE` with `details.productIds`.

## Amount to pay (2026-10-30)

`GET /me/balance` answers `{ "amountDue": "<whole so'm>", "currency": "UZS" }`, only that. The debt itself is counted in USD on the server [C]; the answer is that figure at the CURRENT rate setting, whole so'm, half up [P], so it moves when the rate moves and need not equal the sum of the customer's so'm order totals. A debt under half a cent answers `"0.00"` [P]. When something is due and the rate is missing or the stored setting is corrupt, the answer is 409 `CURRENCY_CONVERSION_UNAVAILABLE` (`{ "error": { "code": "CONFLICT", "reason": "CURRENCY_CONVERSION_UNAVAILABLE", ... } }`), never a guess; nothing due answers `"0.00"` even then. The rate, the USD figures and the lines' USD prices are in no customer response.
