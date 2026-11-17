# Product photos API

Status: built 2026-10-29 on `feat/product-images` (owner decision: photos on the server's disk,
`sharp` approved, managed by MANAGER and ADMIN and by a program through a scoped API token).
Limits and sizes marked [P] are proposals.

Who uses it: the staff app (later: Ostatok and Narxlar pages) and a bulk-upload program (Codex)
that never signs in through a browser.

## Base URL and authentication

- Staging: `https://dev.dashboard.iorder.uz/api` (Apache forwards `/api/` to the api). Production
  has no environment yet; uploading there needs the owner's separate approval.
- Every `/staff/product-images/...` request needs `Authorization: Bearer <token>`:
  - a staff website session of a MANAGER or ADMIN, or
  - an API token `iot_...` (47 characters) issued for the scope `MANAGE_PRODUCT_IMAGES`.
- An API token acts as the staff member it was issued for, but ONLY for its scopes: with a
  `MANAGE_PRODUCT_IMAGES` token every other route answers 403, even when that person's role could
  call it. It stops working (401) when it expires, is revoked, or the person is blocked; it answers
  403 when the person no longer holds a role that allows the action.
- The photo files (`/media/...`) are public: their ids are UUID v7 (a timestamp plus 74 random
  bits), not guessable.

### Issuing and revoking a token (owner only)

Tokens are issued only with the CLI on the server; there is no endpoint. The token is printed
ONCE; only its SHA-256 is stored. Hand it over through a secret channel (never a chat log, a
repository or a ticket) and revoke it when the job is done.

```sh
# inside the api container of the environment (it has DATABASE_URL), e.g. staging:
docker exec -it iorder-staging-api-1 node dist/cli/api-token-issue.main.js \
  --user admin@iorder.uz --name codex-photos --scope MANAGE_PRODUCT_IMAGES --days 7
docker exec -it iorder-staging-api-1 node dist/cli/api-token-revoke.main.js --id <token id>
```

Locally: `pnpm --filter @iorder/api api:token-issue -- --user ... --name ... --scope MANAGE_PRODUCT_IMAGES`.

- `--user`: the STAFF login of an ACTIVE manager or admin (the token acts as them).
- `--days`: 1 to 30, default 7 [P].
- `--scope`: only `MANAGE_PRODUCT_IMAGES` exists [P]; repeatable for future scopes.
- Issuing and revoking are written to `audit_log` (`CLI_API_TOKEN_ISSUED` / `CLI_API_TOKEN_REVOKED`,
  no person, never the token itself).

## Endpoints

### `GET /staff/product-images/products`

Active products in product-code order (case-insensitive), with their live photos (primary first).

Query: `limit` 1..200 (default 100), `cursor` (the `nextCursor` of the previous page),
`withoutImages=true` (only products that still have no photo).

```json
{
  "items": [
    {
      "productCode": "14273",
      "name": "Mi In-Ear Headphones Basic",
      "images": [
        {
          "imageId": "0195f0a0-1c2d-7e3f-8a4b-5c6d7e8f9a0b",
          "isPrimary": true,
          "url": "/api/media/product-images/0195f0a0-1c2d-7e3f-8a4b-5c6d7e8f9a0b/large",
          "thumbUrl": "/api/media/product-images/0195f0a0-1c2d-7e3f-8a4b-5c6d7e8f9a0b/thumb",
          "sourceUrl": "https://example.com/item/14273",
          "width": 1200,
          "height": 900,
          "createdAt": "2026-10-29T08:00:00.000Z"
        }
      ]
    }
  ],
  "nextCursor": null
}
```

`url` and `thumbUrl` are relative to the web origin (prefix the site, e.g.
`https://dev.dashboard.iorder.uz`). `nextCursor` is null on the last page (a full
last page may still be followed by one empty page).

### `GET /staff/product-images/products/{productCode}`

One product (matched ignoring letter case; also an inactive one) with its live photos, primary
first: the same shape as one `items` entry above. `404 NOT_FOUND` for an unknown code. The staff
app's photo manager reads it.

### `POST /staff/product-images/products/{productCode}/images`

`multipart/form-data`:

| Part | Required | Notes |
|---|---|---|
| `file` | yes | JPEG, PNG or WebP (detected from the bytes, not the file name or MIME type) |
| `sourceUrl` | no | `http(s)` URL, at most 2000 characters; stored for reference, never fetched |
| `isPrimary` | no | `true` / `false`. Omitted: primary only if the product has no primary photo |

Header `Idempotency-Key` is REQUIRED: 8-128 characters of `A-Z a-z 0-9 _ . : -` (a UUID is fine).
Use a new key per photo and the SAME key when retrying that photo.

`{productCode}` is matched ignoring letter case (URL-encode it).

Responses:

- `201` new photo: `{ "imageId", "productCode", "url", "thumbUrl", "isPrimary" }`.
- `200` the same key was already answered for the same product and the same file: the first
  result again; nothing new is stored. Also after that photo was removed: the original response
  comes back, but its URLs then answer `404` (upload again with a NEW key to add it again).
  Concurrent requests with the same key get one `201` and `200` replays.
- `409 IDEMPOTENCY_KEY_REUSED`: the key was used before with another file or product.
- `409 PRODUCT_IMAGE_DUPLICATE`: this exact file is already on the product
  (`error.details.imageId` = the existing photo).
- `409 PRIMARY_IMAGE_EXISTS`: `isPrimary=true` but the product already has a primary photo
  (`error.details.imageId` = the current primary). Nothing is replaced automatically: upload
  without `isPrimary` (or `false`), then switch with the endpoint below if wanted.
- `404 NOT_FOUND`: no product with this code.
- `413 PAYLOAD_TOO_LARGE`: the file is larger than 10 MB [P].
- `422 VALIDATION_FAILED`: missing file or key, a bad field, not a JPEG/PNG/WebP, unreadable or
  truncated, animated, shorter side below 200 px [P], or more than 24 megapixels [P].

At most 2 photos are processed at the same time by one api process [P]; further uploads wait
(the request simply takes longer). Uploading one photo at a time per client is recommended.

What the server stores: the original upload (never served) and two re-encoded WebP variants
(`large`: longest side ≤ 1200 px, `thumb`: ≤ 256 px [P]; EXIF orientation applied, all metadata
removed; never enlarged). Uploading already-resized photos is welcome but not required.

### `PUT /staff/product-images/images/{imageId}/primary`

Makes this photo the product's primary one (the previous primary becomes non-primary). `200` with
the photo (same shape as in the list); `404` when the photo is unknown or removed.

### `DELETE /staff/product-images/images/{imageId}`

Removes a wrongly uploaded photo: `204`. The record and the files are kept as history; the photo
disappears from the list and its URLs answer `404`. Removing the primary photo leaves the product
WITHOUT a primary (no automatic promotion); set one explicitly. A removed or unknown id: `404`.
The same file can be uploaded again after removal (with a new Idempotency-Key).

### `GET /media/product-images/{imageId}/{large|thumb}`

The WebP file, public, `Cache-Control: public, max-age=31536000, immutable`,
`X-Content-Type-Options: nosniff`. `404` for unknown or removed photos.

## Errors

Every error is `{ "error": { "code", "message", "reason"?, "details"? } }`; `reason` only on
`409 CONFLICT`. `401 UNAUTHENTICATED`, `403 FORBIDDEN`, `404 NOT_FOUND`,
`413 PAYLOAD_TOO_LARGE`, `422 VALIDATION_FAILED` (`details` lists `path` and `message`),
`429` is not used by these routes yet.

## History

Every upload, primary switch and removal writes `audit_log` in the same transaction
(`PRODUCT_IMAGE_UPLOADED`, `PRODUCT_IMAGE_PRIMARY_SET`, `PRODUCT_IMAGE_REMOVED`, entity
`PRODUCT_IMAGE`), with the acting person; changes made with an API token carry `viaApiToken`.

## Operations

- Files: `/srv/iorder/<env>/media/product-images/` on the host, mounted into the api as
  `/srv/media` (`deploy/compose.app.yml`); `deploy.sh` creates the folder for uid 1000. Back it up
  together with the database (no backup job exists yet).
- Orphan files: when the database commit of an upload fails in a way whose outcome is unknown, the
  written files are kept (deleting them could break a committed row). Files whose id has no
  `product_images` row are such orphans; a later cleanup job may remove them (not built).
- Apache has no `LimitRequestBody` on these hosts; if one is added, keep it above 10 MB for
  `/api/staff/product-images/`.
- Staff list rows carry the PRIMARY photo: `imageUrl` (thumb) and `imageLargeUrl` (large), both
  null without a live primary photo, on `GET /staff/stock`, `GET /staff/products/unpriced`,
  `GET /staff/price-list/current` and the staff version detail. A product whose primary was
  removed shows no photo there until a primary is set again (removal never promotes).
- Not built yet: customer-facing photos, rate limiting of failed token attempts.
