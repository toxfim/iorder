# Codex: putting product photos on iOrder through the API

A short working guide for a program (Codex) that uploads product photos. The full reference with
every response code is [product-images-api.md](product-images-api.md); this file is what you need
to do the job.

## 1. Setup

The token and base URL are in the repository's root `.env` (gitignored, never commit them):

```sh
IORDER_IMAGES_API_BASE=https://dashboard.iorder.uz/api     # production
IORDER_IMAGES_API_TOKEN=iot_...                            # 47 characters
```

- The token acts as `admin@iorder.uz`, but ONLY for photos (scope `MANAGE_PRODUCT_IMAGES`): every
  other route answers `403`. That is expected, not a bug.
- It expires on the date written next to it in `.env` (7 days). `401` means it expired or was
  revoked: ask the owner for a new one (issued with the server CLI, see the reference).
- Never print the token, put it in a URL, a log, a commit or a chat.
- Staging instead of production: `https://dev.dashboard.iorder.uz/api` with a STAGING token
  (a production token does not work there).

```sh
set -a; . ./.env; set +a
AUTH="Authorization: Bearer $IORDER_IMAGES_API_TOKEN"
```

## 2. Find the products that still need a photo

```sh
curl -sS -H "$AUTH" "$IORDER_IMAGES_API_BASE/staff/product-images/products?withoutImages=true&limit=200"
```

Answer: `{ "items": [ { "productCode", "name", "images": [] } ], "nextCursor" }`. While
`nextCursor` is not null, call again with `&cursor=<nextCursor>`. Only ACTIVE products are listed.

One product (also shows its current photos):

```sh
curl -sS -H "$AUTH" "$IORDER_IMAGES_API_BASE/staff/product-images/products/40459"
```

## 3. Upload a photo

```sh
curl -sS -X POST -H "$AUTH" \
  -H "Idempotency-Key: $(uuidgen)" \
  -F "file=@photos/40459.jpg" \
  -F "sourceUrl=https://example.com/where-the-photo-came-from" \
  "$IORDER_IMAGES_API_BASE/staff/product-images/products/40459/images"
```

- `file`: JPEG, PNG or WebP; at most 10 MB; the shorter side at least 200 px; at most 24 MP; not
  animated. The type is read from the bytes, so the file name does not matter.
- `sourceUrl` (optional): where you found the photo; stored for reference only.
- `isPrimary` (optional): leave it out. The first photo of a product becomes primary by itself.
  The primary photo is the one staff lists show.
- `Idempotency-Key` (required): a NEW key for every photo, and the SAME key when you retry that
  same photo after a timeout or network error. Keep a `productCode → key` log so a rerun of your
  script does not create duplicates.

Outcomes you will meet (an error body is `{ "error": { "code", "message", "reason"? } }`; a
`409` has `code: "CONFLICT"` and its kind in `reason`):

| Code | Meaning | What to do |
|---|---|---|
| `201` | stored | record `imageId`, go on |
| `200` | this key was already done | nothing, it is a safe retry |
| `409 PRODUCT_IMAGE_DUPLICATE` | this exact file is already on the product | skip |
| `409 PRIMARY_IMAGE_EXISTS` | you sent `isPrimary=true` and there is a primary | upload without `isPrimary`, then use step 4 if needed |
| `409 IDEMPOTENCY_KEY_REUSED` | the key was used for another file/product | new key |
| `404` | no product with this code | check the code, skip |
| `413` / `422` | too big / not a usable image | pick another photo |
| `401` | token expired or revoked | stop, ask for a new token |
| `403` | the route is not a photo route | you called the wrong URL |

Upload ONE photo at a time (the server processes at most 2 at once, others wait).

## 4. Fix mistakes

```sh
# make another photo the primary one
curl -sS -X PUT -H "$AUTH" "$IORDER_IMAGES_API_BASE/staff/product-images/images/<imageId>/primary"

# remove a wrong photo (204); a removed primary leaves the product WITHOUT a primary: set one
curl -sS -X DELETE -H "$AUTH" "$IORDER_IMAGES_API_BASE/staff/product-images/images/<imageId>"
```

Every upload, switch and removal is in the audit log as `admin@iorder.uz` with `viaApiToken`.

## 5. Check the result

`url` / `thumbUrl` in the answers are relative to the site: open
`https://dashboard.iorder.uz` + `url` (public, no token needed). The photo also shows on the
staff Qoldiq page.

## 6. A whole run in Node (no dependencies, Node 20+)

Photos named `<productCode>.<jpg|png|webp>` in a folder; the key log makes reruns safe.

```js
// node upload-photos.mjs ./photos
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { extname, join } from 'node:path';

const base = process.env.IORDER_IMAGES_API_BASE;
const auth = { Authorization: `Bearer ${process.env.IORDER_IMAGES_API_TOKEN}` };
const dir = process.argv[2];
const logFile = join(dir, 'upload-log.json');
const log = JSON.parse(await readFile(logFile, 'utf8').catch(() => '{}'));
const types = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

for (const name of await readdir(dir)) {
  const ext = extname(name).toLowerCase();
  if (!types[ext]) continue;
  const code = name.slice(0, -ext.length);
  if (log[code]?.done) continue;
  log[code] ??= { key: randomUUID() };               // same key on every retry of this photo
  await writeFile(logFile, JSON.stringify(log, null, 2));

  const form = new FormData();
  form.append('file', new Blob([await readFile(join(dir, name))], { type: types[ext] }), name);
  const res = await fetch(
    `${base}/staff/product-images/products/${encodeURIComponent(code)}/images`,
    { method: 'POST', headers: { ...auth, 'Idempotency-Key': log[code].key }, body: form },
  );
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) throw new Error('token expired or revoked: stop');
  const reason = body.error?.reason ?? body.error?.code; // a 409 carries its kind in `reason`
  log[code] = { ...log[code], status: res.status, reason, imageId: body.imageId,
    done: res.ok || reason === 'PRODUCT_IMAGE_DUPLICATE' };
  await writeFile(logFile, JSON.stringify(log, null, 2));
  console.log(code, res.status, reason ?? body.imageId);
}
```
