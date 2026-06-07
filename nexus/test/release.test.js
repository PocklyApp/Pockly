/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  daemonReleaseSnapshot,
  isDaemonVersionOlder,
  parseDaemonLatestVersion,
  withDaemonReleaseInfo,
} from "../src/release.js";

describe("daemon release metadata", () => {
  it("parses the highest daemon version from checksums.txt", () => {
    const body = [
      "0".repeat(64) + "  pockly-daemon_v0.4.36_darwin_arm64.tar.gz",
      "1".repeat(64) + "  pockly-daemon_v0.4.38_windows_amd64.zip",
      "2".repeat(64) + "  pockly-daemon_v0.4.37_linux_amd64.tar.gz",
      "3".repeat(64) + "  unrelated_v9.9.9_linux_amd64.tar.gz",
    ].join("\n");
    assert.equal(parseDaemonLatestVersion(body), "v0.4.38");
  });

  it("compares daemon semver labels conservatively", () => {
    assert.equal(isDaemonVersionOlder("v0.4.36", "v0.4.37"), true);
    assert.equal(isDaemonVersionOlder("v0.4.37", "v0.4.37"), false);
    assert.equal(isDaemonVersionOlder("v0.0.0-dev", "v0.4.37"), true);
    assert.equal(isDaemonVersionOlder("pockly-daemon v0.4.36", "v0.4.37"), false);
  });

  it("loads release metadata from object storage and attaches daemon update fields", async () => {
    const snapshot = await daemonReleaseSnapshot({
      RELEASES: new FakeObjectStore({
        "pockly-daemon/latest/checksums.txt": "0".repeat(64) + "  pockly-daemon_v0.4.37_linux_amd64.tar.gz\n",
      }),
      DAEMON_RELEASE_CACHE_SECONDS: "0",
    });
    assert.equal(snapshot.latest, "v0.4.37");
    assert.equal(snapshot.source, "release_latest");

    const row = withDaemonReleaseInfo({ app_version: "v0.4.36" }, snapshot);
    assert.equal(row.daemon_latest_version, "v0.4.37");
    assert.equal(row.daemon_update_available, true);
    assert.equal(row.daemon_update_source, "release_latest");
  });

  it("keeps release source and errors provider-neutral on object-store failures", async () => {
    const snapshot = await daemonReleaseSnapshot({
      RELEASES: new FakeObjectStore({}),
      DAEMON_RELEASE_CACHE_SECONDS: "0",
    });
    assert.equal(snapshot.source, "release_latest");
    assert.match(snapshot.error, /release object not found/);
  });
});

class FakeObjectStore {
  constructor(objects) {
    this.objects = objects;
  }

  async get(key) {
    const value = this.objects[key];
    if (value == null) return null;
    return { text: async () => value };
  }
}
