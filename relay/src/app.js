/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ErrorCode,
  errorResponse,
  jsonResponse,
  managedRuntimeCapabilities,
} from "./contract.js";

export async function handleRequest(request, env = {}, ctx = {}) {
  const url = new URL(request.url);
  const path = normalizePath(url.pathname);

  if (path === "/healthz") {
    if (request.method !== "GET") {
      return methodNotAllowed("GET");
    }
    return jsonResponse({ ok: true, service: "pockly-managed-runtime" });
  }

  if (path === "/api/runtime") {
    if (request.method !== "GET") {
      return methodNotAllowed("GET");
    }
    return jsonResponse(managedRuntimeCapabilities(env));
  }

  if (path.startsWith("/api/")) {
    return errorResponse("not found", ErrorCode.NotFound, { status: 404 });
  }

  return errorResponse("not found", ErrorCode.NotFound, { status: 404 });
}

function normalizePath(pathname) {
  if (!pathname || pathname === "/") {
    return "/";
  }
  return pathname.replace(/\/+$/, "") || "/";
}

function methodNotAllowed(allow) {
  return errorResponse("method not allowed", ErrorCode.MethodNotAllowed, {
    status: 405,
    headers: { allow },
  });
}
