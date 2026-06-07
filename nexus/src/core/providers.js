/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Nexus core receives platform capabilities through this provider bundle. The
// bundle is intentionally plain JavaScript: platform adapters may be Node
// services, Postgres/S3/Redis clients, or in-memory test doubles, but core code
// should only depend on these neutral provider slots.

export function createNexusProviderBundle(input = {}) {
  return Object.freeze({
    store: input.store ?? null,
    controlHub: input.controlHub ?? null,
    blobStore: input.blobStore ?? null,
    emailProvider: input.emailProvider ?? null,
    sttProvider: input.sttProvider ?? null,
    pushProvider: input.pushProvider ?? null,
    telemetryProvider: input.telemetryProvider ?? null,
    clock: input.clock ?? systemClock,
    ids: input.ids ?? cryptoIDProvider,
    crypto: input.crypto ?? globalThis.crypto ?? null,
  });
}

export function requireNexusProvider(bundle, name) {
  const provider = bundle?.[name];
  if (!provider) throw new Error(`nexus provider required: ${name}`);
  return provider;
}

export const systemClock = Object.freeze({
  now: () => new Date(),
  isoNow: () => new Date().toISOString(),
});

export const cryptoIDProvider = Object.freeze({
  randomBase64URL(prefix = "id", bytes = 16) {
    if (!globalThis.crypto?.getRandomValues) throw new Error("crypto.getRandomValues unavailable");
    const raw = globalThis.crypto.getRandomValues(new Uint8Array(bytes));
    let binary = "";
    for (const byte of raw) binary += String.fromCharCode(byte);
    return `${prefix}_${btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")}`;
  },
});
