# Match maintainer host: .node-version / rustc 1.94.0 (see rust-toolchain.toml).
#
# SELF-HOST / OpenAccess ONLY. This image builds the public `relay-broker`
# binary. SealWire Cloud (licensed) is built from the private repository as
# `sealwire-broker-private` and must never use this Dockerfile as its production
# image.
FROM node:26.10.0-bookworm AS frontend-build
WORKDIR /app

COPY package.json package-lock.json vite.config.js ./
# `npm ci` runs the root package's `prepare` script, so the file it executes has
# to exist here too. It no-ops outside a Git checkout. Copied file-scoped rather
# than as the whole scripts/ dir to keep this layer's cache from busting on every
# unrelated script change.
COPY scripts/install-git-hooks.mjs scripts/highlighter-build-plugin.mjs scripts/third-party-notices.mjs scripts/third-party-notices-plugin.mjs ./scripts/
COPY scripts/third-party-license-overrides.json ./scripts/
COPY docs/third-party ./docs/third-party
COPY frontend ./frontend
# frontend/shared/* re-exports from the private crate's frontend, so `frontend`
# alone is not a self-contained build tree.
COPY crates/sealwire-private/frontend ./crates/sealwire-private/frontend

RUN npm ci && npm run build

FROM rust:1.94-bookworm AS build
WORKDIR /app

COPY Cargo.toml Cargo.lock LICENSE ./
COPY crates ./crates
COPY --from=frontend-build /app/web ./web
COPY --from=frontend-build /usr/local/bin/node /usr/local/bin/node
COPY --from=frontend-build /app/node_modules/tm-grammars ./node_modules/tm-grammars
COPY scripts/generate-third-party-notices.mjs scripts/third-party-notices.mjs scripts/third-party-license-overrides.json ./scripts/
COPY frontend/shared/highlighter-languages.js ./frontend/shared/
COPY docs/third-party ./docs/third-party

RUN cargo fetch --locked && node scripts/generate-third-party-notices.mjs && cargo build --release -p relay-broker

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /app/target/release/relay-broker /usr/local/bin/relay-broker
COPY --from=build /app/web /app/web
COPY --from=build /app/THIRD_PARTY_NOTICES.txt /app/THIRD_PARTY_NOTICES.txt

ENV BIND_HOST=0.0.0.0
ENV PORT=8788
EXPOSE 8788

CMD ["relay-broker"]
