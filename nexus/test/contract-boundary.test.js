/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { handleRequest } from "../src/app.js";
import { nexusRuntimeCapabilities } from "../src/contract.js";
import { serveNodeNexus } from "../src/node/server.js";

const runtimeKeys = [
  "runtime",
  "realtime",
  "terminal",
  "web_push",
  "stt",
  "release_update",
  "contract_version",
];

const productEncryptionSemantics = [
  /end-to-end encryption/i,
  /end-to-end encrypted/i,
  /end to end encrypted/i,
  /E2E encryption/i,
  /E2E encrypted/i,
  /E2E session encryption/i,
  /can't decrypt/i,
  /can’t decrypt/i,
  /cannot decrypt/i,
  /can't be decrypted/i,
  /can’t be decrypted/i,
  /encrypted access/i,
  /端到端加密/,
  /无法解密/,
  /加密访问/,
];

const productDeviceSemantics = [
  /browser device/i,
  /browser-device/i,
  /recipient/i,
  /Device management/i,
  /Device authorization/i,
  /device menu/i,
  /No device/i,
  /Remove device/i,
  /Rename device/i,
  /Pockly's servers/i,
  /Pockly servers/i,
  /浏览器设备/,
  /设备管理/,
  /设备授权/,
  /设备菜单/,
  /没有设备/,
  /移除设备/,
  /重命名设备/,
  /Pockly 的服务器/,
  /Pockly 服务器/,
];

describe("Nexus public contract boundary", () => {
  it("keeps public docs provider-neutral and free of operator-specific deployment details", async () => {
    const root = repoRoot();
    for (const relativePath of publicDocumentationFiles()) {
      const text = await fs.promises.readFile(path.join(root, relativePath), "utf8");
      for (const finding of operatorDeploymentFindings(text)) {
        assert.fail(`${relativePath} leaked operator-specific deployment detail: ${finding}`);
      }
    }
  });

  it("keeps public Nexus package free of operator platform implementation", async () => {
    const root = repoRoot();
    const files = [
      ...await collectFiles(path.join(root, "nexus", "src"), new Set([".js"])),
      path.join(root, "nexus", "package.json"),
    ];
    for (const file of files) {
      const relativePath = path.relative(root, file);
      const text = await fs.promises.readFile(file, "utf8");
      for (const finding of operatorDeploymentFindings(text)) {
        assert.fail(`${relativePath} leaked operator platform implementation: ${finding}`);
      }
    }
  });

  it("keeps public repository copy and install surfaces free of operator-specific deployment details", async () => {
    const root = repoRoot();
    const files = [
      ...publicDocumentationFiles(),
      ...githubTemplateFiles(),
      "package.json",
      "package-lock.json",
      ".dockerignore",
      ".gitignore",
      "daemon/README.md",
      "daemon/scripts/install.sh",
      "daemon/scripts/install.ps1",
      "nexus/bin/pockly-nexus.js",
      "nexus/Dockerfile",
      "nexus/package.json",
      "web/package.json",
      "web/playwright.config.ts",
      "web/vite.config.ts",
      "web/src/App.tsx",
      "web/src/api.ts",
      "web/src/global.d.ts",
      "web/src/main.tsx",
      "web/src/observability.ts",
      "web/src/runtime-config.ts",
      "web/src/content/docs.ts",
      "web/src/content/site.ts",
      "web/src/landing.tsx",
      "web/src/locales/en.ts",
      "web/src/locales/zh-CN.ts",
      "web/public/pockly-runtime-config.js",
    ];
    for (const relativePath of files) {
      const text = await fs.promises.readFile(path.join(root, relativePath), "utf8");
      for (const finding of operatorDeploymentFindings(text)) {
        assert.fail(`${relativePath} leaked operator-specific deployment detail: ${finding}`);
      }
    }
  });

  it("keeps product copy aligned with server-stored history semantics", async () => {
    const root = repoRoot();
    const publicProductCopy = [
      ...publicDocumentationFiles(),
      ...githubTemplateFiles(),
      "daemon/README.md",
      "web/src/content/docs.ts",
      "web/src/content/site.ts",
      "web/src/landing.tsx",
      "web/src/locales/en.ts",
      "web/src/locales/zh-CN.ts",
    ];
    for (const relativePath of publicProductCopy) {
      const text = await fs.promises.readFile(path.join(root, relativePath), "utf8");
      for (const pattern of productEncryptionSemantics) {
        assert.doesNotMatch(text, pattern, `${relativePath} leaked removed encryption product semantics: ${pattern}`);
      }
      for (const pattern of productDeviceSemantics) {
        assert.doesNotMatch(text, pattern, `${relativePath} leaked obsolete device or storage semantics: ${pattern}`);
      }
    }
  });

  it("keeps public source and fixtures provider-neutral and free of private local identifiers", async () => {
    const root = repoRoot();
    const files = [
      ...publicDocumentationFiles().map((file) => path.join(root, file)),
      ...githubTemplateFiles().map((file) => path.join(root, file)),
      ...await collectFiles(path.join(root, "web", "src"), new Set([".ts", ".tsx", ".json"])),
      ...await collectFiles(path.join(root, "daemon"), new Set([".go", ".sh", ".ps1", ".md"])),
      ...await collectFiles(path.join(root, "nexus"), new Set([".js", ".json", ".md", ".sql"])),
    ];
    for (const file of files) {
      const relativePath = path.relative(root, file);
      if (relativePath.includes("node_modules") || relativePath.includes(`${path.sep}bin${path.sep}`)) continue;
      const text = await fs.promises.readFile(file, "utf8");
      for (const finding of publicSourceBoundaryFindings(text)) {
        assert.fail(`${relativePath} leaked non-public source detail: ${finding}`);
      }
    }
  });

  it("returns only neutral self-hosted runtime keys", async () => {
    const response = await handleRequest(new Request("https://nexus.example/api/runtime"), {
      POCKLY_NEXUS_ENVIRONMENT: "legacy-b",
      POCKLY_RELAY_ENVIRONMENT: "legacy-a",
      POCKLY_CONTROL_HUB: {},
      RELEASES: { provider: "internal-release-binding" },
      REALTIME_ENABLED: "1",
      TERMINAL_ENABLED: "1",
      RELEASE_UPDATE_ENABLED: "1",
      EDGE_PROVIDER_NAME: "internal-edge-provider",
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(Object.keys(body).sort(), [...runtimeKeys].sort());
    assert.deepEqual(body, {
      runtime: "self_hosted",
      realtime: true,
      terminal: true,
      web_push: false,
      stt: false,
      release_update: true,
      contract_version: "1",
    });
    for (const finding of operatorDeploymentFindings(JSON.stringify(body))) {
      assert.fail(`runtime contract leaked operator-specific deployment detail: ${finding}`);
    }
  });

  it("ignores legacy deployment environment names in the public runtime contract", () => {
    assert.deepEqual(nexusRuntimeCapabilities({
      POCKLY_NEXUS_RUNTIME: "self_hosted",
      POCKLY_NEXUS_ENVIRONMENT: "legacy-b",
      POCKLY_RELAY_ENVIRONMENT: "legacy-a",
      POCKLY_CONTROL_HUB: {},
      REALTIME_ENABLED: "1",
    }), {
      runtime: "self_hosted",
      realtime: true,
      terminal: false,
      web_push: false,
      stt: false,
      release_update: false,
      contract_version: "1",
    });
  });

  it("serves the same neutral runtime contract from the Node self-hosted server", async () => {
    const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pockly-nexus-contract-"));
    const server = await serveNodeNexus({
      host: "127.0.0.1",
      port: 0,
      dataDir,
      env: {
        POCKLY_NEXUS_ENVIRONMENT: "legacy-b",
      },
    });
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/api/runtime`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.deepEqual(Object.keys(body).sort(), [...runtimeKeys].sort());
      assert.equal(body.runtime, "self_hosted");
      for (const finding of operatorDeploymentFindings(JSON.stringify(body))) {
        assert.fail(`runtime contract leaked operator-specific deployment detail: ${finding}`);
      }
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await fs.promises.rm(dataDir, { recursive: true, force: true });
    }
  });
});

function repoRoot() {
  return path.resolve(import.meta.dirname, "..", "..");
}

function publicDocumentationFiles() {
  return [
    "README.md",
    "CONTRIBUTING.md",
    "SECURITY.md",
    "CODE_OF_CONDUCT.md",
    "docs/README.md",
    "docs/architecture.md",
    "docs/development.md",
    "docs/self-hosting.md",
    "docs/security-model.md",
    "docs/testing.md",
    "docs/troubleshooting.md",
    "nexus/README.md",
    "nexus/docs/deployment.md",
    "web/README.md",
    "daemon/README.md",
  ];
}

function githubTemplateFiles() {
  return [
    ".github/PULL_REQUEST_TEMPLATE.md",
    ".github/ISSUE_TEMPLATE/bug_report.yml",
    ".github/ISSUE_TEMPLATE/docs_issue.yml",
    ".github/ISSUE_TEMPLATE/feature_request.yml",
  ];
}

async function collectFiles(dir, extensions) {
  const out = [];
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...await collectFiles(file, extensions));
    } else if (extensions.has(path.extname(entry.name))) {
      out.push(file);
    }
  }
  return out;
}

function operatorDeploymentFindings(text) {
  const findings = [];
  if (/\b(?:https?:\/\/)?(?:[a-z0-9-]+\.)?pockly[a-z0-9-]*\.(?:com|cn)\b/i.test(text)) {
    findings.push("operator-specific domain");
  }
  return findings;
}

function publicSourceBoundaryFindings(text) {
  const findings = [];
  for (const match of text.matchAll(/(?:^|[^A-Z0-9_])([A-Z][A-Z0-9_]*_(?:API_KEY|AUTH_TOKEN|BASE_URL))\b/g)) {
    const name = match[1];
    if (
      name.startsWith("ANTHROPIC_") ||
      name.startsWith("CLAUDE_CODE_") ||
      name.startsWith("OPENAI_") ||
      name.startsWith("CODEX_") ||
      name.startsWith("DAEMON_RELEASE_") ||
      name.startsWith("POCKLY_") ||
      name.startsWith("VITE_") ||
      name.startsWith("VOICE_TRANSCRIPTION_")
    ) {
      continue;
    }
    findings.push("provider-specific env var");
  }
  for (const match of text.matchAll(/\b[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})\b/gi)) {
    const domain = match[1].toLowerCase();
    if (
      domain === "example.com" ||
      domain === "example.net" ||
      domain === "example.org" ||
      domain === "example.test" ||
      domain === "example.invalid" ||
      domain === "example.local" ||
      domain.endsWith(".example")
    ) {
      continue;
    }
    findings.push("non-example email");
  }
  for (const match of text.matchAll(/\/Users\/([^/\s"'`]+)/g)) {
    const user = match[1].toLowerCase();
    if (["alice", "administrator", "dev", "me", "you"].includes(user)) continue;
    findings.push("non-generic macOS home path");
  }
  for (const match of text.matchAll(/\bhttps:\/\/api\.([a-z0-9-]+)\.[a-z0-9.-]+\b/gi)) {
    findings.push("provider API host");
  }
  return findings;
}
