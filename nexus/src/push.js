/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

const defaultTTLSeconds = 3600;
const maxPayloadBytes = 3600;
const webPushRecordSize = 4096;
const p256PublicKeyBytes = 65;

export async function notifyUserPushSubscribers(env, store, userID, notification) {
  if (!isWebPushConfigured(env)) return { attempted: 0, sent: 0, failed: 0, disabled: true };
  if (!store?.listActivePushSubscriptionsForUser) return { attempted: 0, sent: 0, failed: 0, disabled: true };
  const subscriptions = await store.listActivePushSubscriptionsForUser(userID);
  let sent = 0;
  let failed = 0;
  for (const subscription of subscriptions) {
    const result = await sendPushToSubscription(env, subscription, notification);
    if (result.ok) {
      sent += 1;
      continue;
    }
    failed += 1;
    if ((result.status === 404 || result.status === 410) && store.revokePushSubscription) {
      await store.revokePushSubscription(userID, subscription.subscription_id, new Date().toISOString());
    }
  }
  return { attempted: subscriptions.length, sent, failed, disabled: false };
}

export async function sendPushToSubscription(env, subscription, notification) {
  if (env.POCKLY_PUSH_PROVIDER?.send) {
    return await env.POCKLY_PUSH_PROVIDER.send(subscription, normalizePushNotification(notification), env);
  }
  if (env.POCKLY_PUSH_SENDER) {
    return await env.POCKLY_PUSH_SENDER(subscription, normalizePushNotification(notification), env);
  }
  const request = await buildWebPushRequest(env, subscription, notification);
  const response = await fetch(subscription.endpoint, request);
  return { ok: response.ok, status: response.status };
}

export async function buildWebPushRequest(env, subscription, notification) {
  const publicKey = webPushPublicKey(env);
  const privateKey = env.VAPID_PRIVATE_KEY || env.POCKLY_VAPID_PRIVATE_KEY || "";
  if (!publicKey || !privateKey) throw new Error("web push VAPID keys are not configured");
  const payload = normalizePushNotification(notification);
  const endpoint = requiredString(subscription.endpoint, "subscription.endpoint");
  const body = await encryptWebPushPayload(JSON.stringify(payload), {
    userPublicKey: requiredString(subscription.p256dh, "subscription.p256dh"),
    userAuthSecret: requiredString(subscription.auth, "subscription.auth"),
  });
  const token = await createVAPIDToken({
    endpoint,
    publicKey,
    privateKey,
    subject: env.VAPID_SUBJECT || env.POCKLY_VAPID_SUBJECT || "mailto:admin@example.invalid",
  });
  const ttl = positiveInteger(env.PUSH_TTL_SECONDS || env.POCKLY_PUSH_TTL_SECONDS, defaultTTLSeconds);
  return {
    method: "POST",
    headers: new Headers({
      Authorization: `vapid t=${token}, k=${publicKey}`,
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: String(ttl),
      Urgency: "normal",
    }),
    body,
  };
}

export async function encryptWebPushPayload(plaintext, { userPublicKey, userAuthSecret }) {
  const uaPublic = decodeBase64URL(userPublicKey);
  const authSecret = decodeBase64URL(userAuthSecret);
  if (uaPublic.length !== p256PublicKeyBytes || uaPublic[0] !== 0x04) throw new Error("subscription p256dh must be an uncompressed P-256 public key");
  if (authSecret.length < 16) throw new Error("subscription auth secret must be at least 16 bytes");
  const asKeyPair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", asKeyPair.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, asKeyPair.privateKey, 256));
  const keyInfo = concatBytes(utf8("WebPush: info"), new Uint8Array([0]), uaPublic, asPublic);
  const prkKey = await hmacSHA256(authSecret, ecdhSecret);
  const ikm = await hmacSHA256(prkKey, concatBytes(keyInfo, new Uint8Array([1])));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmacSHA256(salt, ikm);
  const cek = (await hmacSHA256(prk, concatBytes(utf8("Content-Encoding: aes128gcm"), new Uint8Array([0, 1])))).slice(0, 16);
  const nonce = (await hmacSHA256(prk, concatBytes(utf8("Content-Encoding: nonce"), new Uint8Array([0, 1])))).slice(0, 12);
  const plaintextBytes = utf8(plaintext);
  if (plaintextBytes.length > maxPayloadBytes) throw new Error("web push payload is too large");
  const recordPlaintext = concatBytes(plaintextBytes, new Uint8Array([0x02]));
  const key = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, key, recordPlaintext));
  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  const view = new DataView(header.buffer);
  view.setUint32(16, webPushRecordSize, false);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concatBytes(header, ciphertext);
}

export async function createVAPIDToken({ endpoint, publicKey, privateKey, subject }) {
  const publicBytes = decodeBase64URL(publicKey);
  const privateBytes = decodeBase64URL(privateKey);
  if (publicBytes.length !== p256PublicKeyBytes || publicBytes[0] !== 0x04) throw new Error("VAPID public key must be an uncompressed P-256 public key");
  if (privateBytes.length !== 32) throw new Error("VAPID private key must be a 32-byte P-256 scalar");
  const aud = new URL(endpoint).origin;
  const header = base64URLFromString(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const payload = {
    aud,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    ...(subject ? { sub: subject } : {}),
  };
  const body = base64URLFromString(JSON.stringify(payload));
  const signingInput = `${header}.${body}`;
  const key = await crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      x: base64URLFromBytes(publicBytes.slice(1, 33)),
      y: base64URLFromBytes(publicBytes.slice(33, 65)),
      d: base64URLFromBytes(privateBytes),
    },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, utf8(signingInput)));
  return `${signingInput}.${base64URLFromBytes(signature)}`;
}

export function normalizePushNotification(notification) {
  const payload = {
    title: truncateString(notification?.title || "Pockly update", 96),
    summary: truncateString(notification?.summary || "Open Pockly to view the latest status.", 220),
    session_id: truncateString(notification?.session_id || "", 160),
    device_id: truncateString(notification?.device_id || "", 160),
    url: sameOriginPath(notification?.url || "/workspace/sessions"),
  };
  while (utf8(JSON.stringify(payload)).length > maxPayloadBytes && payload.summary.length > 32) {
    payload.summary = `${payload.summary.slice(0, Math.max(32, payload.summary.length - 64)).trim()}...`;
  }
  return payload;
}

export function isWebPushConfigured(env = {}) {
  const enabled = env.WEB_PUSH_ENABLED === "1" || env.WEB_PUSH_ENABLED === "true";
  const publicKey = webPushPublicKey(env);
  const privateKey = env.VAPID_PRIVATE_KEY || env.POCKLY_VAPID_PRIVATE_KEY;
  const sender = env.POCKLY_PUSH_SENDER || env.POCKLY_PUSH_PROVIDER?.send;
  return Boolean(enabled && publicKey && (privateKey || sender));
}

export function webPushPublicKey(env = {}) {
  return env.VAPID_PUBLIC_KEY || env.POCKLY_VAPID_PUBLIC_KEY || env.POCKLY_PUSH_PROVIDER?.publicKey || "";
}

function sameOriginPath(value) {
  const raw = String(value || "/workspace/sessions");
  if (!raw.startsWith("/")) return "/workspace/sessions";
  if (raw.startsWith("//")) return "/workspace/sessions";
  return raw;
}

async function hmacSHA256(keyBytes, data) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, data));
}

function requiredString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} required`);
  return value.trim();
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function truncateString(value, maxLength) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3).trim()}...`;
}

function concatBytes(...parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function utf8(value) {
  return new TextEncoder().encode(value);
}

function base64URLFromString(value) {
  return base64URLFromBytes(utf8(value));
}

export function base64URLFromBytes(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function decodeBase64URL(value) {
  const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}
