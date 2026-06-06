# Copyright 2026 Pockly contributors
# SPDX-License-Identifier: Apache-2.0

.PHONY: build run cross _cross_pair package clean lint version regression

BIN     := pockly-daemon
WRAPPER := pockly-claude-wrapper
PKG     := github.com/PocklyApp/Pockly/daemon
VERS_PKG := $(PKG)/internal/version

# Pull build identity from git (works even on a freshly init-ed repo).
COMMIT := $(shell git rev-parse --short HEAD 2>/dev/null || echo dev)
DATE   := $(shell date -u +%Y-%m-%dT%H:%M:%SZ)
LDFLAGS := -s -w \
	-X $(VERS_PKG).Commit=$(COMMIT) \
	-X $(VERS_PKG).Date=$(DATE)

# Local build for the host platform (both daemon and wrapper).
build:
	go build -trimpath -ldflags "$(LDFLAGS)" -o bin/$(BIN) ./cmd/$(BIN)
	go build -trimpath -ldflags "$(LDFLAGS)" -o bin/$(WRAPPER) ./cmd/$(WRAPPER)

run: build
	./bin/$(BIN) --version

# Cross-compile both daemon and wrapper for every ship target.
cross:
	@mkdir -p bin
	$(MAKE) _cross_pair GOOS=darwin  GOARCH=arm64 EXT=
	$(MAKE) _cross_pair GOOS=darwin  GOARCH=amd64 EXT=
	$(MAKE) _cross_pair GOOS=linux   GOARCH=arm64 EXT=
	$(MAKE) _cross_pair GOOS=linux   GOARCH=amd64 EXT=
	$(MAKE) _cross_pair GOOS=windows GOARCH=amd64 EXT=.exe
	$(MAKE) _cross_pair GOOS=windows GOARCH=arm64 EXT=.exe

_cross_pair:
	GOOS=$(GOOS) GOARCH=$(GOARCH) go build -trimpath -ldflags "$(LDFLAGS)" -o bin/$(BIN)-$(GOOS)-$(GOARCH)$(EXT)     ./cmd/$(BIN)
	GOOS=$(GOOS) GOARCH=$(GOARCH) go build -trimpath -ldflags "$(LDFLAGS)" -o bin/$(WRAPPER)-$(GOOS)-$(GOARCH)$(EXT) ./cmd/$(WRAPPER)

package:
	./scripts/package-release.sh

clean:
	rm -rf bin dist

lint:
	go vet ./...
	@command -v golangci-lint >/dev/null 2>&1 \
		&& golangci-lint run \
		|| echo "golangci-lint not installed (skip)"

version: build
	./bin/$(BIN) --version

# Live regression sweep against the running daemon. Runs the three
# v0.1.43+/v0.2.0 scenarios in order and prints a summary line. Needs
# a wrapped `claude` somewhere on the host so a live terminal_session
# is registered. Exits non-zero if any scenario fails. Total ~10s.
regression: build
	@echo "=== permission-card ==="
	@./bin/$(BIN) test-scenario permission-card | tail -3
	@echo "=== web-permission-card ==="
	@./bin/$(BIN) test-scenario web-permission-card | tail -3
	@echo "=== permission-interactive ==="
	@./bin/$(BIN) test-scenario permission-interactive | tail -3
	@echo "=== regression sweep done ==="
