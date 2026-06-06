/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

export const CONTRACT_VERSION = "1";

export const Runtime = Object.freeze({
  Managed: "managed",
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

export function managedRuntimeCapabilities(env = {}) {
  return {
    runtime: Runtime.Managed,
    realtime: envFlag(env.REALTIME_ENABLED),
    terminal: envFlag(env.TERMINAL_ENABLED),
    web_push: envFlag(env.WEB_PUSH_ENABLED),
    stt: env.STT_ENABLED === "1" || env.STT_ENABLED === "true",
    release_update: envFlag(env.RELEASE_UPDATE_ENABLED),
    contract_version: CONTRACT_VERSION,
  };
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
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), {
    ...init,
    headers,
  });
}
