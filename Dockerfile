# syntax=docker/dockerfile:1.7
# ---- Stage 1: builder ----
# Debian-slim (glibc) over alpine (musl) — better-sqlite3's native build
# is more reliable on glibc and matches the most-tested path across the
# MCP-server ecosystem.
FROM node:24-bookworm-slim AS builder

# better-sqlite3 invokes node-gyp during `npm ci` and needs Python + a
# C++ toolchain. The runtime stage discards this entirely, so the apt
# layer is paid only at build time.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# `--ignore-scripts` skips the prepare hook (which would `npm run build`
# before src/ lands). The native better-sqlite3 compile shares this RUN
# so its cache invalidation is bound to lockfile changes — re-running
# `npm rebuild` on every src/ edit would otherwise re-download + re-link
# the .node binary.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts \
 && npm rebuild better-sqlite3

COPY tsconfig.json ./
COPY src ./src
RUN npm run build \
 && npm prune --omit=dev

# ---- Stage 2: runtime ----
FROM node:24-bookworm-slim AS runtime

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
# Shipped at runtime — src/lib/version.ts reads it via
# fileURLToPath(import.meta.url) → ../../package.json for PACKAGE_VERSION.
COPY --from=builder /app/package.json ./package.json

# The `node` user (UID 1000) pre-exists in the official node image —
# principle of least privilege. Operators chown the mounted vault to
# 1000:1000 OR pass `--user $(id -u):$(id -g)` at run time. See
# README "Docker > Vault mount + permissions".
USER node

# Documents the default HTTP port. Effective only under `--transport
# http`; ignored under stdio. Does NOT publish to the host — that needs
# `--network=host` (Linux) or a future network-bind ADR.
EXPOSE 3000

# Caller-supplied args REPLACE CMD wholesale (Docker semantics — no
# append), so any `docker run image <flag>` invocation must re-state
# `--vault /vault` if it wants that default. Stdio MCP launchers pass
# their own full arg list; compose.yaml relies on CMD for the vault path.
ENTRYPOINT ["node", "dist/index.js"]
CMD ["--vault", "/vault", "--transport", "http"]
