# Duo — single-process image.
#
# Next.js and Socket.IO are served by one Node process (`server/index.ts`), so
# this image is the whole application. It runs unchanged on Fly.io, Railway,
# Render, or any host that can run a container.
#
# `sharp` and `@node-rs/argon2` ship native binaries: build for the architecture
# you deploy to, or pass `--platform`.

FROM node:24-bookworm-slim AS base
WORKDIR /app
ENV NODE_ENV=production

# Prisma's query engine needs OpenSSL at build *and* run time.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

FROM base AS deps

# Pinned deliberately. `npm ci` rebuilds the ideal tree from package.json and
# refuses to continue if the layout it computes differs from the one recorded in
# the lock file — and npm 10 and npm 11 hoist this dependency graph differently
# (npm 11 lifts picomatch@2 to the top with picomatch@4 nested under tinyglobby;
# npm 10 does the opposite). Both trees are correct, but only the one that wrote
# the lock can verify it, so the builder has to run the same npm as whoever ran
# `npm install`. Regenerate the lock if you change this.
RUN npm install -g npm@11.16.0

COPY package.json package-lock.json ./
COPY prisma ./prisma
# Dev dependencies are kept: `prisma` (for `db:deploy` on release) and the
# build toolchain both live there.
RUN npm ci --include=dev

FROM deps AS build

# `NEXT_PUBLIC_*` values are inlined into the client bundle by `next build`, so
# they have to exist at build time rather than at boot. They are public by
# definition — nothing secret belongs here, and nothing secret is passed.
# Railway supplies service variables to the build as arguments; the defaults
# below keep a plain `docker build` working too.
ARG NEXT_PUBLIC_APP_URL=http://localhost:3000
ARG NEXT_PUBLIC_APP_NAME=Duo
ARG NEXT_PUBLIC_SOCKET_URL=
ARG NEXT_PUBLIC_SOCKET_PATH=/api/socket
ARG NEXT_PUBLIC_MAX_UPLOAD_BYTES=104857600

ENV NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL \
    NEXT_PUBLIC_APP_NAME=$NEXT_PUBLIC_APP_NAME \
    NEXT_PUBLIC_SOCKET_URL=$NEXT_PUBLIC_SOCKET_URL \
    NEXT_PUBLIC_SOCKET_PATH=$NEXT_PUBLIC_SOCKET_PATH \
    NEXT_PUBLIC_MAX_UPLOAD_BYTES=$NEXT_PUBLIC_MAX_UPLOAD_BYTES

# `next build` collects page data for the route handlers, which imports
# `lib/env.ts` and therefore validates the *server* schema. These placeholders
# exist only to get past that validation: server variables are read from
# `process.env` at request time, so nothing here is baked into the output.
#
# They are confined to this stage on purpose. The runtime stage starts from
# `base` and copies files only, so none of these reach the final image — which
# is why real secrets must never be passed as build arguments.
ENV DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build \
    BETTER_AUTH_SECRET=build-stage-placeholder-not-a-real-secret \
    BETTER_AUTH_URL=http://localhost:3000 \
    AUTHORIZED_USER_1=build-1@example.invalid \
    AUTHORIZED_USER_2=build-2@example.invalid \
    MEDIA_URL_SECRET=build-stage-placeholder-not-a-real-secret

COPY . .
RUN npm run build

FROM base AS runtime

# Never run as root; the app writes only to the storage directory.
RUN groupadd --system --gid 1001 duo \
  && useradd --system --uid 1001 --gid duo duo

COPY --from=build --chown=duo:duo /app ./

# Only used when STORAGE_PROVIDER=local, and only useful with a volume mounted
# here — an unmounted container filesystem loses uploads on every deploy.
RUN mkdir -p /app/.storage && chown duo:duo /app/.storage

USER duo
EXPOSE 3000

# The platform's own health check should point at /api/health, which returns
# 503 while the database is unreachable.
CMD ["npm", "start"]
