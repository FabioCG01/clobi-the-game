# =============================================================================
# TUX SMASH ROYALE — Clobi's Arena
# A single optimized, self-hosted container honoring Clobi: Linux, open source,
# vim, and a militant disdain for Windows. Multi-stage so the final image holds
# nothing but a tiny static Go binary and the web assets — no toolchain, no cgo,
# no bloat. Just the way Clobi would have wanted it.
# =============================================================================

# -----------------------------------------------------------------------------
# Stage 1 — builder: compile a fully static, stripped binary.
# -----------------------------------------------------------------------------
FROM golang:1.22-alpine AS builder

WORKDIR /src

# Pure Go, statically linked, no C toolchain needed.
ENV CGO_ENABLED=0 \
    GOOS=linux \
    GOFLAGS=-trimpath

# Dependencies are vendored (committed under ./vendor), so the build is fully
# offline and reproducible — no module proxy access needed at build time. The
# embedded DB driver (go.etcd.io/bbolt) is pure Go, so the binary stays static.
COPY go.mod go.sum ./
COPY vendor ./vendor

# Copy the Go source tree and build the server from the vendored modules.
COPY cmd ./cmd
COPY internal ./internal

# -s -w strips the symbol table and DWARF debug info -> smaller binary.
RUN go build -mod=vendor -ldflags="-s -w" -o /clobi ./cmd/server

# -----------------------------------------------------------------------------
# Stage 2 — runtime: minimal Alpine with an unprivileged user.
# -----------------------------------------------------------------------------
FROM alpine:3.20

# Non-root user/group for the running process.
RUN addgroup -S clobi && adduser -S -G clobi clobi

WORKDIR /app

# The static binary and the browser client.
COPY --from=builder /clobi /app/clobi
COPY web /app/web

# Writable data directory (the bbolt database lives here), owned by the app user.
RUN mkdir -p /app/data && chown -R clobi:clobi /app

# Tunables — all read by cmd/server/main.go.
ENV PORT=1337 \
    WEB_DIR=/app/web \
    DATA_DIR=/app/data

EXPOSE 1337

USER clobi

ENTRYPOINT ["/app/clobi"]
