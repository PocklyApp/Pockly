#!/usr/bin/env bash
# Copyright 2026 Pockly contributors
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

BIN="${BIN:-pockly-daemon}"
WRAPPER="${WRAPPER:-pockly-claude-wrapper}"
VERSION="${VERSION:-$(git describe --tags --always --dirty 2>/dev/null || echo dev)}"
PKG="github.com/PocklyApp/Pockly/daemon"
VERS_PKG="${PKG}/internal/version"
COMMIT="${COMMIT:-$(git rev-parse --short HEAD 2>/dev/null || echo dev)}"
DATE="${DATE:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
LDFLAGS="-s -w -X ${VERS_PKG}.Version=${VERSION#v} -X ${VERS_PKG}.Commit=${COMMIT} -X ${VERS_PKG}.Date=${DATE}"

rm -rf dist
mkdir -p dist

build_one() {
  local goos="$1"
  local goarch="$2"
  local ext=""
  local archive_ext="tar.gz"
  if [ "${goos}" = "windows" ]; then
    ext=".exe"
    archive_ext="zip"
  fi

  local name="${BIN}_${VERSION}_${goos}_${goarch}"
  local workdir="dist/${name}"
  mkdir -p "${workdir}"

  env GOOS="${goos}" GOARCH="${goarch}" go build -trimpath -ldflags "${LDFLAGS}" -o "${workdir}/${BIN}${ext}"     "./cmd/${BIN}"
  env GOOS="${goos}" GOARCH="${goarch}" go build -trimpath -ldflags "${LDFLAGS}" -o "${workdir}/${WRAPPER}${ext}" "./cmd/${WRAPPER}"
  cp README.md "${workdir}/README.md"

  if [ "${archive_ext}" = "zip" ]; then
    (cd dist && zip -qr "${name}.zip" "${name}")
  else
    tar -C dist -czf "dist/${name}.tar.gz" "${name}"
  fi

  rm -rf "${workdir}"
}

build_one darwin amd64
build_one darwin arm64
build_one linux amd64
build_one linux arm64
build_one windows amd64
build_one windows arm64

(cd dist && shasum -a 256 *.tar.gz *.zip > checksums.txt)
