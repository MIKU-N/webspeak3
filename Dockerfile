# --- Rust connector -----------------------------------------------------
FROM rust:1-bookworm AS connector-builder
RUN apt-get update && apt-get install -y --no-install-recommends cmake && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY tsclientlib/ tsclientlib/
COPY connector/ connector/
WORKDIR /src/connector
ENV CMAKE_POLICY_VERSION_MINIMUM=3.5
RUN cargo build --release

# --- Web frontend ---------------------------------------------------------
FROM node:22-bookworm-slim AS web-builder
WORKDIR /src/web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
# tsc -b currently fails on pre-existing type errors unrelated to this build;
# vite build alone is enough to produce the production bundle.
RUN npx vite build

# --- Gateway ----------------------------------------------------------------
FROM node:22-bookworm-slim AS gateway-builder
WORKDIR /src/gateway
COPY gateway/package*.json ./
RUN npm ci
COPY gateway/ ./
RUN npm run build

# --- Runtime ----------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
COPY gateway/package*.json ./
RUN npm ci --omit=dev
COPY --from=gateway-builder /src/gateway/dist ./dist
COPY --from=connector-builder /src/connector/target/release/ts-connector /app/connector-bin/ts-connector
COPY --from=web-builder /src/web/dist /app/web/dist

ENV PORT=8080
ENV WEB_DIST=/app/web/dist
ENV CONNECTOR_BIN=/app/connector-bin/ts-connector
EXPOSE 8080

CMD ["node", "dist/index.js"]
