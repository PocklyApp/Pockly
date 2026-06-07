#!/usr/bin/env bash
# Copyright 2026 Pockly contributors
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

BIN="${POCKLY_DAEMON_BIN:-pockly-daemon}"
WRAPPER="${POCKLY_DAEMON_WRAPPER:-pockly-claude-wrapper}"
VERSION="${POCKLY_DAEMON_VERSION:-latest}"
BASE_URL="${POCKLY_DAEMON_BASE_URL:-}"
INSTALL_DIR="${POCKLY_DAEMON_INSTALL_DIR:-${INSTALL_DIR:-/usr/local/bin}}"
INSTALL_SH_URL="${POCKLY_INSTALL_SH_URL:-https://your-nexus.example/install.sh}"

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "pockly install: missing required command: $1" >&2
    exit 1
  fi
}

need curl
need tar

# install_needs_sudo: 0 (writable, no sudo) / 1 (not writable, sudo needed).
# Inspects INSTALL_DIR if it exists, otherwise walks up to find an existing
# ancestor and checks writability there (mkdir -p will use the same dir).
install_needs_sudo() {
  if [ -d "${INSTALL_DIR}" ]; then
    [ ! -w "${INSTALL_DIR}" ]
    return
  fi
  parent="$(dirname "${INSTALL_DIR}")"
  while [ ! -d "${parent}" ] && [ "${parent}" != "/" ]; do
    parent="$(dirname "${parent}")"
  done
  [ ! -w "${parent}" ]
}

ensure_sudo() {
  if ! install_needs_sudo; then
    return 0
  fi
  if sudo -n true 2>/dev/null; then
    return 0
  fi
  if [ -r /dev/tty ] && [ -w /dev/tty ]; then
    echo "pockly install: sudo is required to write to ${INSTALL_DIR}."
    echo "pockly install: prompting for your password before downloading."
    sudo -v </dev/tty
    return 0
  fi

  cat >&2 <<EOF
pockly install: this installer needs sudo to write to ${INSTALL_DIR},
but no interactive terminal is available for the password prompt.
Aborting before downloading anything.

Fix — download the installer first, then run it with a real terminal:

  curl -fsSL "${INSTALL_SH_URL}" -o /tmp/pockly-install.sh
  bash /tmp/pockly-install.sh

Alternative — pre-cache sudo credentials, then keep using the one-liner:

  sudo -v && curl -fsSL "${INSTALL_SH_URL}" | bash

Or install into a directory you own (no sudo needed):

  curl -fsSL "${INSTALL_SH_URL}" | \\
    POCKLY_DAEMON_INSTALL_DIR="\$HOME/.local/bin" bash
EOF
  exit 1
}

ensure_sudo

case "$(uname -s)" in
  Darwin) goos="darwin" ;;
  Linux) goos="linux" ;;
  *)
    echo "pockly install: unsupported OS: $(uname -s)" >&2
    echo "Use the Windows install.ps1 from your Pockly release source." >&2
    exit 1
    ;;
esac

case "$(uname -m)" in
  x86_64 | amd64) goarch="amd64" ;;
  arm64 | aarch64) goarch="arm64" ;;
  *)
    echo "pockly install: unsupported architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

tmp="$(mktemp -d)"
cleanup() {
  rm -rf "${tmp}"
}
trap cleanup EXIT

if [ -z "${BASE_URL}" ]; then
  cat >&2 <<EOF
pockly install: POCKLY_DAEMON_BASE_URL is required.

Set it to the daemon release base URL that contains latest/checksums.txt.
Deployment pipelines should inject this value when serving install.sh.
EOF
  exit 1
fi

release_url="${BASE_URL%/}/${VERSION}"
checksums_url="${release_url}/checksums.txt"

echo "pockly install: resolving ${VERSION} for ${goos}/${goarch}"
curl -fsSL "${checksums_url}" -o "${tmp}/checksums.txt"

archive="$(awk -v goos="${goos}" -v goarch="${goarch}" '$2 ~ "_" goos "_" goarch "\\.tar\\.gz$" { print $2; exit }' "${tmp}/checksums.txt")"
if [ -z "${archive}" ]; then
  echo "pockly install: no ${goos}/${goarch} archive found in ${checksums_url}" >&2
  exit 1
fi

echo "pockly install: downloading ${archive}"
curl -fsSL "${release_url}/${archive}" -o "${tmp}/${archive}"

echo "pockly install: verifying checksum"
expected="$(awk -v file="${archive}" '$2 == file { print $1 }' "${tmp}/checksums.txt")"
if [ -z "${expected}" ]; then
  echo "pockly install: checksum not found for ${archive}" >&2
  exit 1
fi
if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "${tmp}/${archive}" | awk '{ print $1 }')"
else
  actual="$(shasum -a 256 "${tmp}/${archive}" | awk '{ print $1 }')"
fi
if [ "${actual}" != "${expected}" ]; then
  echo "pockly install: checksum mismatch for ${archive}" >&2
  exit 1
fi

mkdir -p "${tmp}/extract"
tar -xzf "${tmp}/${archive}" -C "${tmp}/extract"
binary="$(find "${tmp}/extract" -type f -name "${BIN}" -perm -111 | head -n 1)"
if [ -z "${binary}" ]; then
  echo "pockly install: ${BIN} binary not found in ${archive}" >&2
  exit 1
fi

if [ ! -d "${INSTALL_DIR}" ]; then
  if mkdir -p "${INSTALL_DIR}" 2>/dev/null; then
    :
  else
    sudo mkdir -p "${INSTALL_DIR}"
  fi
fi

target="${INSTALL_DIR}/${BIN}"
if [ -w "${INSTALL_DIR}" ]; then
  install -m 0755 "${binary}" "${target}"
else
  sudo install -m 0755 "${binary}" "${target}"
fi

echo "pockly install: installed ${target}"
if command -v "${target}" >/dev/null 2>&1; then
  "${target}" --version || true
fi

# Install the Claude wrapper binary alongside the daemon. The wrapper sits inert
# until the user opts in via `pockly-daemon enable-remote-control`. Older tarballs
# may not contain it; in that case we silently skip and the daemon install still
# succeeds.
wrapper_binary="$(find "${tmp}/extract" -type f -name "${WRAPPER}" -perm -111 | head -n 1)"
if [ -n "${wrapper_binary}" ]; then
  wrapper_target="${INSTALL_DIR}/${WRAPPER}"
  if [ -w "${INSTALL_DIR}" ]; then
    install -m 0755 "${wrapper_binary}" "${wrapper_target}"
  else
    sudo install -m 0755 "${wrapper_binary}" "${wrapper_target}"
  fi
  echo "pockly install: installed ${wrapper_target} (inactive until enable-remote-control)"
fi

case ":${PATH}:" in
  *":${INSTALL_DIR}:"*) ;;
  *) echo "pockly install: add ${INSTALL_DIR} to PATH if ${BIN} is not found" ;;
esac

if [ "${POCKLY_DAEMON_NO_SETUP:-}" != "1" ]; then
  nexus_url="${POCKLY_NEXUS_URL:-${POCKLY_RELAY_URL:-http://127.0.0.1:8787}}"
  echo
  echo "pockly install: starting first-run setup"
  echo "pockly install: set POCKLY_DAEMON_NO_SETUP=1 to install without setup"
  "${target}" setup --nexus-url "${nexus_url}"
else
  echo "pockly install: setup skipped because POCKLY_DAEMON_NO_SETUP=1"
  echo "Run manually when ready: ${target} setup --nexus-url ${POCKLY_NEXUS_URL:-${POCKLY_RELAY_URL:-http://127.0.0.1:8787}}"
fi
