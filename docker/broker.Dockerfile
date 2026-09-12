# Match maintainer host: .node-version / rustc 1.94.0 (see rust-toolchain.toml).
FROM node:25.2.1-bookworm AS frontend-build
WORKDIR /app

COPY package.json package-lock.json vite.config.js ./
# `npm ci` runs the root package's `prepare` script, so the file it executes has
# to exist here too. It no-ops outside a Git checkout. Copied file-scoped rather
# than as the whole scripts/ dir to keep this layer's cache from busting on every
# unrelated script change.
COPY scripts/install-git-hooks.mjs ./scripts/
COPY frontend ./frontend
# frontend/shared/* re-exports from the private crate's frontend, so `frontend`
# alone is not a self-contained build tree.
COPY crates/sealwire-private/frontend ./crates/sealwire-private/frontend

RUN npm ci && npm run build

FROM rust:1.94-bookworm AS build
WORKDIR /app

COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY --from=frontend-build /app/web ./web

RUN cargo build --release -p relay-broker

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /app/target/release/relay-broker /usr/local/bin/relay-broker
COPY --from=build /app/web /app/web

ENV BIND_HOST=0.0.0.0
ENV PORT=8788
EXPOSE 8788

CMD ["relay-broker"]
