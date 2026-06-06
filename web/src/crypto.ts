/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { ed25519 } from "@noble/curves/ed25519";

const browserStateKey = "pockly.browser_device";
const nobleEd25519Prefix = "noble-ed25519:";

// E2E session encryption was removed: session content is stored in plaintext on
// the relay and protected in transit by TLS. The only key the browser keeps is
// the Ed25519 SIGNING key — it is NOT payload encryption; it authenticates this
// browser device to the relay via the device-challenge/verify handshake.
export type BrowserDeviceState = {
  deviceId?: string;
  devicePublicKey: string;
  devicePrivateKeyPkcs8: string;
  accessToken?: string;
  refreshToken?: string;
};

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function fromBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function saveState(state: BrowserDeviceState) {
  localStorage.setItem(browserStateKey, JSON.stringify(state));
}

export function loadBrowserDeviceState(): BrowserDeviceState | null {
  const raw = localStorage.getItem(browserStateKey);
  if (!raw) return null;
  return JSON.parse(raw) as BrowserDeviceState;
}

export async function clearBrowserDeviceState() {
  localStorage.removeItem(browserStateKey);
}

export async function ensureBrowserDeviceState(): Promise<BrowserDeviceState> {
  const existing = loadBrowserDeviceState();
  if (existing?.devicePublicKey && existing?.devicePrivateKeyPkcs8) {
    // Existing device (incl. ones that still carry a now-unused e2ePublicKey in
    // localStorage from before E2E removal) — keep the Ed25519 signing key so
    // the device stays paired; no re-registration needed.
    return existing;
  }

  const keyPair = await generateBrowserSigningKey();
  const state: BrowserDeviceState = {
    ...existing,
    devicePublicKey: keyPair.publicKey,
    devicePrivateKeyPkcs8: keyPair.privateKey,
  };
  saveState(state);
  return state;
}

export function persistBrowserTokens(payload: {
  browserDeviceId: string;
  accessToken?: string;
  refreshToken?: string;
}) {
  const current = loadBrowserDeviceState();
  if (!current) {
    throw new Error("browser device state missing");
  }
  const next: BrowserDeviceState = {
    ...current,
    deviceId: payload.browserDeviceId,
    ...((payload.accessToken ?? current.accessToken) ? { accessToken: payload.accessToken ?? current.accessToken } : {}),
    ...((payload.refreshToken ?? current.refreshToken) ? { refreshToken: payload.refreshToken ?? current.refreshToken } : {}),
  };
  saveState(next);
}

export async function signBrowserChallenge(message: string): Promise<string> {
  const state = await ensureBrowserDeviceState();
  if (state.devicePrivateKeyPkcs8.startsWith(nobleEd25519Prefix)) {
    const privateKey = fromBase64Url(state.devicePrivateKeyPkcs8.slice(nobleEd25519Prefix.length));
    return toBase64Url(ed25519.sign(new TextEncoder().encode(message), privateKey));
  }
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    fromBase64Url(state.devicePrivateKeyPkcs8),
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("Ed25519", privateKey, new TextEncoder().encode(message));
  return toBase64Url(new Uint8Array(signature));
}

async function generateBrowserSigningKey(): Promise<{ publicKey: string; privateKey: string }> {
  try {
    const keyPair = (await crypto.subtle.generateKey(
      { name: "Ed25519" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const pub = await crypto.subtle.exportKey("raw", keyPair.publicKey);
    const priv = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
    return {
      publicKey: toBase64Url(new Uint8Array(pub)),
      privateKey: toBase64Url(new Uint8Array(priv)),
    };
  } catch {
    const privateKey = ed25519.utils.randomPrivateKey();
    const publicKey = ed25519.getPublicKey(privateKey);
    return {
      publicKey: toBase64Url(publicKey),
      privateKey: `${nobleEd25519Prefix}${toBase64Url(privateKey)}`,
    };
  }
}
