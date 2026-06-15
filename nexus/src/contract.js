/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

export const CONTRACT_VERSION = "1";

export const Runtime = Object.freeze({
  SelfHosted: "self_hosted",
});

export const ErrorCode = Object.freeze({
  BadRequest: "bad_request",
  Unauthorized: "unauthorized",
  Forbidden: "forbidden",
  NotFound: "not_found",
  Conflict: "conflict",
  DaemonOffline: "daemon_offline",
  MethodNotAllowed: "method_not_allowed",
  Internal: "internal_error",
  ServiceUnavailable: "service_unavailable",
  UnsupportedRuntime: "unsupported_runtime",
  InvalidRuntimeState: "invalid_runtime_state",
});

export function nexusRuntimeCapabilities(env = {}, defaults = {}) {
  const runtime = normalizeRuntime(env.POCKLY_NEXUS_RUNTIME || env.NEXUS_RUNTIME || defaults.runtime || Runtime.SelfHosted);
  const hasControlRuntime = Boolean(env.POCKLY_CONTROL_HUB || env.POCKLY_CONTROL_HUB_FACTORY);
  const hasWebPushKey = Boolean(
    (env.VAPID_PUBLIC_KEY || env.POCKLY_VAPID_PUBLIC_KEY || env.POCKLY_PUSH_PROVIDER?.publicKey) &&
    (env.VAPID_PRIVATE_KEY || env.POCKLY_VAPID_PRIVATE_KEY || env.POCKLY_PUSH_SENDER || env.POCKLY_PUSH_PROVIDER?.send),
  );
  const hasSTTProvider = Boolean(env.VOICE_TRANSCRIPTION_ENDPOINT || env.POCKLY_VOICE_TRANSCRIPTION_ENDPOINT || env.POCKLY_STT_PROVIDER);
  const hasReleaseSource = Boolean(env.RELEASES || env.DAEMON_RELEASE_BASE_URL || env.POCKLY_DAEMON_RELEASE_BASE_URL);
  return {
    runtime,
    realtime: hasControlRuntime && envFlag(env.REALTIME_ENABLED),
    browser_realtime: hasControlRuntime && envFlag(env.BROWSER_REALTIME_ENABLED ?? env.REALTIME_ENABLED),
    browser_realtime_control: hasControlRuntime && envFlag(env.BROWSER_REALTIME_ENABLED ?? env.REALTIME_ENABLED) && envFlag(env.BROWSER_REALTIME_CONTROL_ENABLED),
    control_streaming: envFlag(env.CONTROL_STREAMING_ENABLED ?? "1"),
    terminal: hasControlRuntime && envFlag(env.TERMINAL_ENABLED),
    terminal_streaming: hasControlRuntime && envFlag(env.TERMINAL_STREAMING_ENABLED ?? env.TERMINAL_ENABLED),
    web_push: hasWebPushKey && envFlag(env.WEB_PUSH_ENABLED),
    stt: hasSTTProvider && envFlag(env.STT_ENABLED),
    release_update: hasReleaseSource && envFlag(env.RELEASE_UPDATE_ENABLED),
    contract_version: CONTRACT_VERSION,
  };
}

function normalizeRuntime() {
  return Runtime.SelfHosted;
}

function envFlag(value) {
  return value === "1" || value === "true";
}

export function errorResponse(error, code, init = {}) {
  return jsonResponse(
    {
      error,
      ...(code ? { code } : {}),
    },
    init,
  );
}

export function jsonResponse(body, init = {}) {
  const headers = new Headers(init.headers);
  const text = JSON.stringify(body);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set("content-length", String(new TextEncoder().encode(text).byteLength));
  return new Response(text, {
    ...init,
    headers,
  });
}
