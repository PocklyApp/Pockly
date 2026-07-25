/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Public-boundary tests.
 *
 * This repository is public. Two classes of mistake are easy to make and hard to
 * notice in review:
 *
 *   1. Deployment-specific detail (a real domain, account ID, bucket, or
 *      credential) leaks into tracked files.
 *   2. Documentation drifts away from the code, so a published claim stops being
 *      true.
 *
 * These tests fail the build for both. They read the repository from disk rather
 * than importing it, so they cover Markdown, shell, and Go files as well as the
 * JavaScript runtime.
 *
 * When a documented fact legitimately changes, update the documentation and the
 * expectation here in the same commit.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { nexusRuntimeCapabilities } from "../src/contract.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Tracked files only. Anything git ignores (node_modules, dist, .wrangler,
 * .local) cannot leak by definition, and scanning it would be slow and noisy.
 */
function trackedFiles() {
  const out = execFileSync("git", ["-C", repoRoot, "ls-files", "-z"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split("\0").filter(Boolean);
}

function readTracked(relativePath) {
  return readFileSync(join(repoRoot, relativePath), "utf8");
}

const binaryOrGenerated = /\.(png|jpg|jpeg|gif|webp|ico|svg|woff2?|ttf|eot|pdf|zip|gz|wasm)$/i;
const lockFiles = /(^|\/)(package-lock\.json|go\.sum)$/;

function scannableFiles() {
  return trackedFiles().filter((path) => !binaryOrGenerated.test(path) && !lockFiles.test(path));
}

const scannable = scannableFiles();

/** Every scannable file, read once and shared across the leak checks. */
const corpus = scannable.map((path) => ({ path, text: readTracked(path) }));

function findMatches(pattern, { allow = () => false } = {}) {
  const hits = [];
  for (const { path, text } of corpus) {
    const lines = text.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const matches = line.match(pattern);
      if (!matches) continue;
      for (const match of matches) {
        if (allow({ path, line, match })) continue;
        hits.push(`${path}:${index + 1}: ${match}`);
      }
    }
  }
  return hits;
}

describe("public boundary: no deployment-specific detail in tracked files", () => {
  it("has a non-trivial corpus to scan", () => {
    // Guards against the scan silently passing because the file list broke.
    assert.ok(scannable.length > 100, `expected to scan >100 tracked files, got ${scannable.length}`);
    assert.ok(corpus.some(({ path }) => path === "README.md"));
  });

  it("does not reference operator-owned domains", () => {
    // Documentation and code must use RFC 2606 reserved names (example.com,
    // .example, .invalid, .test, .local) or loopback addresses. A real
    // deployment hostname in a public repo tells readers to point at
    // infrastructure that is not theirs, and pins the project to one operator.
    const hits = findMatches(/\b(?:[a-z0-9-]+\.)*pockly[a-z0-9-]*\.(?:com|cn|net|io|dev|app|ai)\b/gi, {
      allow: ({ match }) => /\.(?:example|invalid|test|local)$/i.test(match),
    });
    assert.deepEqual(hits, [], `operator domain reference:\n${hits.join("\n")}`);
  });

  it("does not reference workers.dev or other per-account edge hostnames", () => {
    const hits = findMatches(/\b[a-z0-9-]+\.workers\.dev\b/gi);
    assert.deepEqual(hits, [], `per-account edge hostname:\n${hits.join("\n")}`);
  });

  it("does not contain cloud resource identifiers", () => {
    // Cloudflare account/zone IDs are 32 hex; D1/KV/R2 namespace IDs are UUIDs.
    // Test fixtures legitimately use repeated-digit UUIDs and hex, so allow
    // obviously synthetic values and reject anything that looks real.
    const syntheticHex = /^(?:([0-9a-f])\1{31}|0123456789abcdef0123456789abcdef)$/i;
    const hits = findMatches(
      /\b(?:account_id|accountId|zone_id|zoneId|database_id|databaseId|namespace_id|namespaceId)\b\s*[:=]\s*["']?([0-9a-f-]{32,36})["']?/gi,
      { allow: ({ match }) => syntheticHex.test(match.replace(/.*[:=]\s*["']?/, "").replace(/["'].*/, "").replace(/-/g, "")) },
    );
    assert.deepEqual(hits, [], `cloud resource identifier:\n${hits.join("\n")}`);
  });

  it("does not contain credential material", () => {
    const patterns = [
      { name: "Anthropic key", pattern: /\bsk-ant-[A-Za-z0-9_-]{8,}/g },
      { name: "OpenAI-style key", pattern: /\bsk-(?:proj-)?[A-Za-z0-9]{20,}/g },
      { name: "GitHub token", pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}/g },
      { name: "GitHub fine-grained token", pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/g },
      { name: "AWS access key ID", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
      { name: "Google API key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
      { name: "Slack token", pattern: /\bxox[abprs]-[0-9A-Za-z-]{10,}/g },
      { name: "private key block", pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g },
      { name: "JWT", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./g },
    ];
    for (const { name, pattern } of patterns) {
      const hits = findMatches(pattern);
      assert.deepEqual(hits, [], `${name} in tracked file:\n${hits.join("\n")}`);
    }
  });

  it("does not contain contributor home directory paths", () => {
    // Absolute paths are fine in fixtures, but they must use generic personas so
    // they do not publish a contributor's account name.
    const allowedUsers = new Set([
      "me", "you", "dev", "test", "tester", "alice", "bob", "example", "user",
      "administrator", "runner", "ci",
    ]);
    const hits = findMatches(/(?:\/Users|\/home)\/[A-Za-z0-9_.-]+/g, {
      allow: ({ line, match }) => {
        const user = match.split("/").at(-1).toLowerCase();
        if (allowedUsers.has(user) || user.startsWith("{") || user.startsWith("$")) return true;
        // Single-letter segments are illustrative path fragments in prose, not
        // real accounts (e.g. a comment showing "/home/u/repo" -> "repo").
        if (user.length <= 2) return true;
        // Comment prose may cite a path as an example.
        return /^\s*(?:\/\/|#|\*)/.test(line);
      },
    });
    assert.deepEqual(hits, [], `contributor home path:\n${hits.join("\n")}`);
  });

  it("does not contain personal email addresses", () => {
    // Reserved and placeholder domains only. Real addresses belong in git
    // metadata and CONTRIBUTING, not in source or fixtures.
    const hits = findMatches(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, {
      allow: ({ match }) => /@(?:[a-z0-9-]+\.)*(?:example\.(?:com|org|net)|example|invalid|test|local|localhost)$/i.test(match)
        || /@(?:noreply\.)?(?:github\.com|anthropic\.com)$/i.test(match)
        || /@pockly(?:app)?\.example$/i.test(match),
    });
    assert.deepEqual(hits, [], `personal email address:\n${hits.join("\n")}`);
  });

  it("does not contain routable IP addresses", () => {
    // Loopback and unspecified addresses only. A routable literal is either a
    // real deployment target or an accident.
    const hits = findMatches(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, {
      allow: ({ path, line, match }) => {
        const octets = match.split(".").map(Number);
        if (octets.some((octet) => octet > 255)) return true; // version string, not an address
        const [a, b] = octets;
        if (a === 127 || match === "0.0.0.0" || match === "255.255.255.255") return true;
        if (a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)) return true;
        if (a === 169 && b === 254) return true; // link-local
        if (a === 192 && b === 0) return true; // 192.0.2.0/24 documentation range
        if (a === 198 && (b === 51 || b === 18 || b === 19)) return true; // documentation / benchmark
        if (a === 203 && b === 0) return true; // 203.0.113.0/24 documentation range
        if (a >= 224) return true; // multicast / reserved
        // Leading-zero octets are not how addresses are written; this is
        // coordinate or version data.
        if (octets.some((octet, index) => index > 0 && /^0\d/.test(match.split(".")[index]))) return true;
        // SVG path data is dense runs of dot-separated numbers.
        if (/\.(?:svg|css)$/.test(path)) return true;
        return /\sd="[Mm]|path fill|viewBox/.test(line);
      },
    });
    assert.deepEqual(hits, [], `routable IP address:\n${hits.join("\n")}`);
  });

  it("keeps secret-bearing files out of version control", () => {
    const forbidden = [
      /(^|\/)\.env(\..+)?$/,
      /(^|\/)\.dev\.vars$/,
      /(^|\/)wrangler\.toml$/,
      /(^|\/)wrangler\.generated\.toml$/,
      /\.(?:pem|key|p12|pfx|keystore|jks)$/,
      /(^|\/)id_(?:rsa|dsa|ecdsa|ed25519)$/,
      /(^|\/)\.npmrc$/,
      /(^|\/)\.netrc$/,
      /(^|\/)credentials(\.json|\.yaml|\.yml)?$/,
      /(^|\/)secrets?\.(?:json|ya?ml|toml)$/,
      /\.(?:sqlite|sqlite3|db)$/,
    ];
    const hits = trackedFiles().filter((path) => forbidden.some((pattern) => pattern.test(path)));
    assert.deepEqual(hits, [], `secret-bearing file is tracked:\n${hits.join("\n")}`);
  });
});

describe("public boundary: documentation matches the code", () => {
  it("documents every runtime capability key that /api/runtime returns", () => {
    // nexus/README.md and nexus/docs/deployment.md enumerate this response.
    // If a capability is added without updating both, self-hosters cannot tell
    // what their deployment exposes.
    const actual = Object.keys(nexusRuntimeCapabilities({}, {})).sort();
    for (const doc of ["nexus/README.md", "nexus/docs/deployment.md"]) {
      const text = readTracked(doc);
      const missing = actual.filter((key) => !new RegExp(`\\b${key}\\b`).test(text));
      assert.deepEqual(missing, [], `${doc} does not document runtime keys: ${missing.join(", ")}`);
    }
  });

  it("documents every environment variable the Nexus CLI reads", () => {
    const cli = readTracked("nexus/bin/pockly-nexus.js");
    const declared = [...cli.matchAll(/\bPOCKLY_NEXUS_[A-Z0-9_]+\b/g)].map((match) => match[0]);
    const documented = `${readTracked("docs/self-hosting.md")}\n${readTracked("nexus/README.md")}`;
    const missing = [...new Set(declared)].filter((name) => !documented.includes(name)).sort();
    assert.deepEqual(missing, [], `undocumented Nexus env vars: ${missing.join(", ")}`);
  });

  it("documents the security-relevant daemon overrides", () => {
    // These weaken a security control, so they must never be discoverable only
    // by reading source.
    const documented = `${readTracked("daemon/README.md")}\n${readTracked("docs/security-model.md")}\n${readTracked("docs/self-hosting.md")}`;
    for (const name of ["POCKLY_AUTO_CONFIRM_PAIR", "POCKLY_ALLOW_PLAINTEXT_KEY"]) {
      assert.ok(documented.includes(name), `${name} weakens a security control and must be documented`);
    }
  });

  it("keeps the dev login route disabled by default and documented as such", () => {
    const app = readTracked("nexus/src/app.js");
    assert.match(
      app,
      /POCKLY_NEXUS_DEV_LOGIN_ENABLED/,
      "the dev login route must stay behind POCKLY_NEXUS_DEV_LOGIN_ENABLED",
    );
    const selfHosting = readTracked("docs/self-hosting.md");
    assert.ok(
      selfHosting.includes("POCKLY_NEXUS_DEV_LOGIN_ENABLED"),
      "docs/self-hosting.md must document the dev login flag",
    );
  });

  it("keeps every relative Markdown link resolvable", () => {
    const tracked = new Set(trackedFiles());
    const broken = [];
    for (const { path, text } of corpus) {
      if (!path.endsWith(".md")) continue;
      for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
        const target = match[1].trim();
        if (/^(?:https?:|mailto:|#)/.test(target)) continue;
        const [filePart] = target.split("#");
        if (!filePart) continue;
        const resolved = resolve(dirname(join(repoRoot, path)), filePart).slice(repoRoot.length + 1);
        if (!tracked.has(resolved) && !tracked.has(`${resolved}/README.md`)) {
          broken.push(`${path} -> ${target}`);
        }
      }
    }
    assert.deepEqual(broken, [], `broken relative Markdown link:\n${broken.join("\n")}`);
  });

  it("does not claim guarantees the diagnostics code cannot make", () => {
    // The daemon and web clients redact diagnostics with allowlists and
    // normalization, which is a best-effort control. Documentation must not
    // upgrade that into an absolute guarantee.
    const securityModel = readTracked("docs/security-model.md");
    assert.ok(
      !/Diagnostic\s+events\s+must\s+not\s+include/i.test(securityModel),
      "docs/security-model.md states an absolute diagnostics guarantee; describe the actual redaction mechanism instead",
    );
  });
});
