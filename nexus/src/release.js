/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

const defaultReleaseCacheSeconds = 60 * 60;
const daemonAssetVersionRE = /\bpockly-daemon_(v\d+\.\d+\.\d+)[^\s]*\.(?:tar\.gz|zip)\b/g;
const snapshotCache = new Map();

export async function daemonReleaseSnapshot(env = {}) {
  const configured = Boolean(env.RELEASES || env.DAEMON_RELEASE_BASE_URL || env.POCKLY_DAEMON_RELEASE_BASE_URL);
  if (!configured) return {};
  const now = Date.now();
  const cacheKey = releaseCacheKey(env);
  const ttlMs = releaseCacheSeconds(env) * 1000;
  const cached = snapshotCache.get(cacheKey);
  if (cached && now - cached.fetchedAt < ttlMs) return cached.snapshot;

  const checkedAt = new Date(now).toISOString();
  try {
    const body = await fetchReleaseChecksums(env);
    const latest = parseDaemonLatestVersion(body);
    if (!latest) throw new Error("checksums.txt: no pockly-daemon release assets");
    const snapshot = { latest, checked_at: checkedAt, source: releaseSource(env) };
    snapshotCache.set(cacheKey, { fetchedAt: now, snapshot });
    return snapshot;
  } catch (error) {
    const previous = cached?.snapshot?.latest ? cached.snapshot : {};
    const snapshot = {
      ...previous,
      checked_at: checkedAt,
      source: releaseSource(env),
      error: error instanceof Error ? error.message : String(error),
    };
    snapshotCache.set(cacheKey, { fetchedAt: now, snapshot });
    return snapshot;
  }
}

export function withDaemonReleaseInfo(record, snapshot) {
  if (!snapshot?.latest && !snapshot?.error) return record;
  const next = { ...record };
  if (snapshot.latest) {
    next.daemon_latest_version = snapshot.latest;
    next.daemon_update_available = isDaemonVersionOlder(record.app_version || "", snapshot.latest);
  }
  next.daemon_update_checked_at = snapshot.checked_at || "";
  next.daemon_update_source = snapshot.source || "cdn_latest";
  if (snapshot.error) next.daemon_update_error = snapshot.error;
  return next;
}

export function parseDaemonLatestVersion(body) {
  let latest = "";
  for (const match of String(body || "").matchAll(daemonAssetVersionRE)) {
    const version = match[1] || "";
    if (compareDaemonVersions(version, latest) > 0) latest = version;
  }
  return latest;
}

export function isDaemonVersionOlder(current, latest) {
  if (!parseDaemonVersionParts(current) || !parseDaemonVersionParts(latest)) return false;
  return compareDaemonVersions(current, latest) < 0;
}

export function compareDaemonVersions(a, b) {
  const left = parseDaemonVersionParts(a);
  const right = parseDaemonVersionParts(b);
  if (!left && !right) return 0;
  if (!left) return -1;
  if (!right) return 1;
  for (let i = 0; i < 3; i += 1) {
    if (left[i] < right[i]) return -1;
    if (left[i] > right[i]) return 1;
  }
  return 0;
}

function parseDaemonVersionParts(label) {
  const trimmed = String(label || "").trim().replace(/^v/, "").split(/[\s+-]/, 1)[0];
  const parts = trimmed.split(".");
  if (parts.length !== 3) return null;
  const nums = parts.map((part) => Number.parseInt(part, 10));
  if (nums.some((num) => Number.isNaN(num) || num < 0)) return null;
  return nums;
}

async function fetchReleaseChecksums(env) {
  if (env.RELEASES) {
    const prefix = String(env.DAEMON_RELEASE_BLOB_PREFIX ?? env.POCKLY_DAEMON_RELEASE_BLOB_PREFIX ?? "pockly-daemon").replace(/^\/+|\/+$/g, "");
    const key = `${prefix ? `${prefix}/` : ""}latest/checksums.txt`;
    const object = await env.RELEASES.get(key);
    if (!object) throw new Error(`release object not found: ${key}`);
    return await object.text();
  }
  const baseURL = String(env.DAEMON_RELEASE_BASE_URL || env.POCKLY_DAEMON_RELEASE_BASE_URL || "").replace(/\/+$/g, "");
  if (!baseURL) throw new Error("daemon release source is not configured");
  const response = await fetch(`${baseURL}/latest/checksums.txt`, {
    headers: { "user-agent": "pockly-worker-release-checker" },
  });
  if (!response.ok) throw new Error(`checksums.txt: ${response.status} ${response.statusText}`.trim());
  return await response.text();
}

function releaseCacheKey(env) {
  return [
    env.RELEASES ? "blob" : "http",
    env.DAEMON_RELEASE_BLOB_PREFIX || env.POCKLY_DAEMON_RELEASE_BLOB_PREFIX || "pockly-daemon",
    env.DAEMON_RELEASE_BASE_URL || env.POCKLY_DAEMON_RELEASE_BASE_URL || "",
  ].join("\x00");
}

function releaseCacheSeconds(env) {
  const parsed = Number(env.DAEMON_RELEASE_CACHE_SECONDS ?? env.POCKLY_DAEMON_RELEASE_CACHE_SECONDS ?? defaultReleaseCacheSeconds);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : defaultReleaseCacheSeconds;
}

function releaseSource(env) {
  if (env.RELEASES) return "release_latest";
  return "cdn_latest";
}
