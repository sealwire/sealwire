FROM node:25-bookworm AS frontend-build
WORKDIR /app

COPY package.json package-lock.json vite.config.js ./
COPY frontend ./frontend

RUN npm ci && npm run build

FROM rust:1.88-bookworm AS build
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
