# One build for both targets. The server's Docker (19.03) is old: only Alpine images run there
# (glibc images fail on its seccomp profile), and BuildKit features such as RUN --mount are not used.
#
#   api: the NestJS api and the pg-boss worker (same image, different command)
#   web: builds the staff and customer dists; deploy.sh copies them out of the image

FROM node:24-alpine AS deps
RUN npm install -g pnpm@11.17.0
WORKDIR /app
# The server's kernel ignores container memory limits, so the builds cap their own heap.
ENV CI=true \
    NODE_OPTIONS=--max-old-space-size=1536
# Manifests first, so a source-only change reuses the installed node_modules layer.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/staff/package.json apps/staff/
COPY apps/customer/package.json apps/customer/
COPY packages/shared/package.json packages/shared/
COPY packages/web-core/package.json packages/web-core/
RUN pnpm install --frozen-lockfile
COPY . .

FROM deps AS api-build
# prisma.config.ts reads DATABASE_URL; `prisma generate` never connects to it.
RUN DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build pnpm turbo run build --filter=@iorder/api

FROM api-build AS api
# compose.app.yml sets the runtime heap cap per process.
ENV NODE_ENV=production \
    NODE_OPTIONS=
WORKDIR /app/apps/api
USER node
CMD ["node", "dist/main.js"]

FROM deps AS web
# Public values only (they end up in the browser bundle). Never a token here.
ARG VITE_TELEGRAM_BOT_USERNAME=
ARG VITE_TELEGRAM_BOT_URL=
ARG VITE_STAFF_TELEGRAM_BOT_USERNAME=
ENV VITE_USE_REAL_API=true \
    VITE_API_BASE_URL=/api \
    VITE_TELEGRAM_BOT_USERNAME=${VITE_TELEGRAM_BOT_USERNAME} \
    VITE_TELEGRAM_BOT_URL=${VITE_TELEGRAM_BOT_URL} \
    VITE_STAFF_TELEGRAM_BOT_USERNAME=${VITE_STAFF_TELEGRAM_BOT_USERNAME}
# check:bundle builds both apps, then fails if fake data or staff vocabulary leaked into a dist.
RUN pnpm turbo run check:bundle --filter=@iorder/staff --filter=@iorder/customer
