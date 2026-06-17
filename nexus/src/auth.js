/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { ErrorCode, errorResponse } from "./contract.js";

export const SESSION_COOKIE = "pockly_session";
export const DEVICE_TOKEN_TTL_SECONDS = 15 * 60;
export const WEB_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
export const CHALLENGE_TTL_SECONDS = 5 * 60;

export async function createOpaqueToken(prefix) {
  return `${prefix}_${base64Url(crypto.getRandomValues(new Uint8Array(32)))}`;
}

export async function sha256Base64URL(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64Url(new Uint8Array(digest));
}

export async function issueDeviceToken(store, device, audience, now = new Date()) {
  const token = await createOpaqueToken("dt");
  const expiresAt = new Date(now.getTime() + DEVICE_TOKEN_TTL_SECONDS * 1000).toISOString();
  await store.createDeviceToken({
    token_hash: await sha256Base64URL(token),
    user_id: device.user_id,
    device_id: device.device_id,
    audience,
    expires_at: expiresAt,
    created_at: now.toISOString(),
  });
  return token;
}

export async function requireWebUser(request, store) {
  const token = parseCookies(request.headers.get("cookie") ?? "")[SESSION_COOKIE];
  if (!token) throw unauthorized();
  const session = await store.getWebSession(await sha256Base64URL(token));
  if (!session || isExpired(session.expires_at)) throw unauthorized();
  const user = await store.getUserByID(session.user_id);
  if (!user) throw unauthorized();
  return { user, session };
}

export async function optionalWebUser(request, store) {
  try {
    return await requireWebUser(request, store);
  } catch {
    return null;
  }
}

export async function requireDeviceAuth(request, store, expectedType, expectedAudience, options = {}) {
  const token = bearerToken(request);
  if (!token) throw unauthorized();
  const record = await store.getDeviceToken(await sha256Base64URL(token));
  if (!record || isExpired(record.expires_at)) throw unauthorized();
  const device = await store.getDevice(record.device_id);
  if (!device || device.status === "revoked") throw unauthorized("device revoked");
  if ((expectedType === "daemon" || device.device_type === "daemon") && device.superseded_by_device_id) {
    throw unauthorized("device superseded");
  }
  if (expectedType && device.device_type !== expectedType) {
    throw forbidden(`expected ${expectedType} device token`);
  }
  if (expectedAudience && record.audience !== expectedAudience) {
    throw forbidden(`expected ${expectedAudience} device token`);
  }
  const user = record.user_id ? await store.getUserByID(record.user_id) : null;
  if (!user && !options.allowUnlinked) throw unauthorized();
  return { user, device, token: record };
}

export async function requireUserFromCookieOrDevice(request, store) {
  const token = bearerToken(request);
  if (token) return await requireDeviceAuth(request, store);
  return await requireWebUser(request, store);
}

export async function verifyDeviceSignature(device, message, signature) {
  const publicKey = fromBase64Url(device.public_key);
  const signatureBytes = fromBase64Url(signature);
  const key = await crypto.subtle.importKey(
    "raw",
    publicKey,
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  return await crypto.subtle.verify("Ed25519", key, signatureBytes, new TextEncoder().encode(message));
}

export function challengeMessage(challenge) {
  return `${challenge.challenge_id}:${challenge.device_id}:${challenge.audience}:${challenge.nonce}`;
}

export function parseCookies(cookieHeader) {
  const cookies = {};
  for (const part of cookieHeader.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (!rawName) continue;
    cookies[rawName] = decodeURIComponent(rawValue.join("=") ?? "");
  }
  return cookies;
}

export function sessionCookie(token, expiresAt) {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Expires=${expiresAt.toUTCString()}`;
}

export function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function isExpired(isoTimestamp) {
  return !isoTimestamp || Date.parse(isoTimestamp) <= Date.now();
}

export function unauthorized(error = "unauthorized") {
  return responseError(error, ErrorCode.Unauthorized, 401);
}

export function forbidden(error = "forbidden") {
  return responseError(error, ErrorCode.Forbidden, 403);
}

function responseError(error, code, status) {
  const err = new Error(error);
  err.response = errorResponse(error, code, { status });
  return err;
}

function bearerToken(request) {
  const auth = request.headers.get("authorization") ?? "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

export function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function fromBase64Url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}
