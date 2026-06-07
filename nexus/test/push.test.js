/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  base64URLFromBytes,
  buildWebPushRequest,
  decodeBase64URL,
  notifyUserPushSubscribers,
} from "../src/push.js";
import { InMemoryNexusStore } from "../src/store.js";

describe("worker-native web push sender", () => {
  it("builds a VAPID-authenticated encrypted Web Push request", async () => {
    const vapid = await generateVAPIDKeys();
    const subscriptionKeys = await generateSubscriptionKeys();
    const request = await buildWebPushRequest({
      WEB_PUSH_ENABLED: "1",
      VAPID_PUBLIC_KEY: vapid.publicKey,
      VAPID_PRIVATE_KEY: vapid.privateKey,
      VAPID_SUBJECT: "mailto:test@example.local",
      PUSH_TTL_SECONDS: "60",
    }, {
      endpoint: "https://push.example/send/abc",
      p256dh: subscriptionKeys.publicKey,
      auth: subscriptionKeys.auth,
    }, {
      title: "Pockly task finished",
      summary: "A remote agent run finished.",
      session_id: "sess_push",
      device_id: "dd_push",
      url: "/workspace/s/sess_push?device_id=dd_push",
    });

    assert.equal(request.method, "POST");
    assert.equal(request.headers.get("content-encoding"), "aes128gcm");
    assert.equal(request.headers.get("ttl"), "60");
    assert.match(request.headers.get("authorization") || "", /^vapid t=[^.]+\.[^.]+\.[^,]+, k=/);

    const token = (request.headers.get("authorization") || "").match(/^vapid t=([^,]+),/)?.[1] || "";
    const [, payload] = token.split(".");
    assert.equal(JSON.parse(new TextDecoder().decode(decodeBase64URL(payload))).aud, "https://push.example");

    const plaintext = await decryptWebPushPayload(request.body, subscriptionKeys);
    assert.deepEqual(JSON.parse(plaintext), {
      title: "Pockly task finished",
      summary: "A remote agent run finished.",
      session_id: "sess_push",
      device_id: "dd_push",
      url: "/workspace/s/sess_push?device_id=dd_push",
    });
  });

  it("sends to active subscriptions and revokes expired endpoints", async () => {
    const store = new InMemoryNexusStore();
    await store.upsertPushSubscription({
      subscription_id: "ps_ok",
      user_id: "usr_push",
      browser_device_id: "bd_push",
      endpoint: "https://push.example/ok",
      p256dh: "unused",
      auth: "unused",
      status: "active",
      created_at: "2026-06-06T01:00:00Z",
      updated_at: "2026-06-06T01:00:00Z",
    });
    await store.upsertPushSubscription({
      subscription_id: "ps_gone",
      user_id: "usr_push",
      browser_device_id: "bd_push",
      endpoint: "https://push.example/gone",
      p256dh: "unused",
      auth: "unused",
      status: "active",
      created_at: "2026-06-06T01:00:00Z",
      updated_at: "2026-06-06T01:00:00Z",
    });

    const sent = [];
    const result = await notifyUserPushSubscribers({
      WEB_PUSH_ENABLED: "1",
      VAPID_PUBLIC_KEY: "configured",
      VAPID_PRIVATE_KEY: "configured",
      POCKLY_PUSH_SENDER: async (subscription, notification) => {
        sent.push({ subscription, notification });
        return { ok: subscription.subscription_id === "ps_ok", status: subscription.subscription_id === "ps_ok" ? 201 : 410 };
      },
    }, store, "usr_push", {
      title: "Pockly needs approval",
      summary: "An agent is waiting.",
      session_id: "sess_push",
      device_id: "dd_push",
      url: "/workspace/s/sess_push?device_id=dd_push",
    });

    assert.deepEqual(result, { attempted: 2, sent: 1, failed: 1, disabled: false });
    assert.equal(sent.length, 2);
    assert.equal((await store.listActivePushSubscriptionsForUser("usr_push")).length, 1);
    assert.equal((await store.listActivePushSubscriptionsForUser("usr_push"))[0].subscription_id, "ps_ok");
  });

  it("can send through an injected push provider without a local VAPID private key", async () => {
    const store = new InMemoryNexusStore();
    await store.upsertPushSubscription({
      subscription_id: "ps_provider",
      user_id: "usr_provider",
      browser_device_id: "bd_provider",
      endpoint: "https://push.example/provider",
      p256dh: "unused",
      auth: "unused",
      status: "active",
      created_at: "2026-06-06T01:00:00Z",
      updated_at: "2026-06-06T01:00:00Z",
    });

    const sent = [];
    const result = await notifyUserPushSubscribers({
      WEB_PUSH_ENABLED: "1",
      POCKLY_PUSH_PROVIDER: {
        publicKey: "provider-public-key",
        send: async (subscription, notification) => {
          sent.push({ subscription, notification });
          return { ok: true, status: 201 };
        },
      },
    }, store, "usr_provider", {
      title: "Provider push",
      summary: "Sent by injected provider.",
      session_id: "sess_provider",
      device_id: "dd_provider",
      url: "/workspace/s/sess_provider?device_id=dd_provider",
    });

    assert.deepEqual(result, { attempted: 1, sent: 1, failed: 0, disabled: false });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].subscription.subscription_id, "ps_provider");
    assert.equal(sent[0].notification.title, "Provider push");
  });
});

async function generateVAPIDKeys() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const publicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const privateJWK = await crypto.subtle.exportKey("jwk", pair.privateKey);
  return {
    publicKey: base64URLFromBytes(publicRaw),
    privateKey: privateJWK.d,
  };
}

async function generateSubscriptionKeys() {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const publicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return {
    publicKey: base64URLFromBytes(publicRaw),
    auth: base64URLFromBytes(auth),
    authBytes: auth,
    privateKey: pair.privateKey,
  };
}

async function decryptWebPushPayload(body, subscriptionKeys) {
  const bytes = body instanceof Uint8Array ? body : new Uint8Array(await new Response(body).arrayBuffer());
  const salt = bytes.slice(0, 16);
  const idlen = bytes[20];
  const asPublic = bytes.slice(21, 21 + idlen);
  const ciphertext = bytes.slice(21 + idlen);
  const asKey = await crypto.subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const uaPublic = decodeBase64URL(subscriptionKeys.publicKey);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: asKey }, subscriptionKeys.privateKey, 256));
  const keyInfo = concatBytes(utf8("WebPush: info"), new Uint8Array([0]), uaPublic, asPublic);
  const prkKey = await hmacSHA256(subscriptionKeys.authBytes, ecdhSecret);
  const ikm = await hmacSHA256(prkKey, concatBytes(keyInfo, new Uint8Array([1])));
  const prk = await hmacSHA256(salt, ikm);
  const cek = (await hmacSHA256(prk, concatBytes(utf8("Content-Encoding: aes128gcm"), new Uint8Array([0, 1])))).slice(0, 16);
  const nonce = (await hmacSHA256(prk, concatBytes(utf8("Content-Encoding: nonce"), new Uint8Array([0, 1])))).slice(0, 12);
  const key = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["decrypt"]);
  const plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, key, ciphertext));
  assert.equal(plaintext[plaintext.length - 1], 0x02);
  return new TextDecoder().decode(plaintext.slice(0, -1));
}

async function hmacSHA256(keyBytes, data) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, data));
}

function concatBytes(...parts) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
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
