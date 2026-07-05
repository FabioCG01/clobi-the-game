# =============================================================================
# TUX SMASH ROYALE — Clobi's Arena
# A single optimized, self-hosted container honoring Clobi: Linux, open source,
# vim, and a militant disdain for Windows. Multi-stage so the final image holds
# nothing but two tiny static Go binaries (the server + the one-shot bbolt →
# Postgres migrator) and the web assets — no toolchain, no cgo, no bloat.
# Just the way Clobi would have wanted it.
# =============================================================================

# -----------------------------------------------------------------------------
# Stage 1 — builder: compile fully static, stripped binaries.
# -----------------------------------------------------------------------------
FROM golang:1.25-alpine AS builder

WORKDIR /src

# Pure Go, statically linked, no C toolchain needed.
ENV CGO_ENABLED=0 \
    GOOS=linux \
    GOFLAGS=-trimpath

# Dependencies are vendored (committed under ./vendor), so the build is fully
# offline and reproducible — no module proxy access needed at build time. Both
# the Postgres driver (pgx) and bbolt (read-only source for the migrator) are
# pure Go, so the binaries stay static.
COPY go.mod go.sum ./
COPY vendor ./vendor

# Copy the Go source tree and build from the vendored modules.
COPY cmd ./cmd
COPY internal ./internal

# -s -w strips the symbol table and DWARF debug info -> smaller binaries.
RUN go build -mod=vendor -ldflags="-s -w" -o /clobi ./cmd/server \
 && go build -mod=vendor -ldflags="-s -w" -o /migrate ./cmd/migrate

# -----------------------------------------------------------------------------
# Stage 2 — runtime: minimal Alpine with an unprivileged user.
# -----------------------------------------------------------------------------
FROM alpine:3.20

# Non-root user/group for the running process.
RUN addgroup -S clobi && adduser -S -G clobi clobi

WORKDIR /app

# The static server binary, the one-shot data migrator, and the browser client.
# Run the migrator once after first boot of the Postgres stack:
#   docker compose run --rm clobi /app/migrate /app/data/clobi.db
COPY --from=builder /clobi /app/clobi
COPY --from=builder /migrate /app/migrate
COPY web /app/web

# Data directory (mount point for the legacy bbolt database the migrator
# imports), owned by the app user.
RUN mkdir -p /app/data && chown -R clobi:clobi /app

# Tunables — read by cmd/server/main.go (DATABASE_URL comes from compose).
ENV PORT=1337 \
    WEB_DIR=/app/web \
    DATA_DIR=/app/data

EXPOSE 1337

USER clobi

ENTRYPOINT ["/app/clobi"]
