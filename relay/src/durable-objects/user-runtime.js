/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { jsonResponse } from "../contract.js";

export class UserRuntimeDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/healthz") {
      return jsonResponse({ ok: true, service: "pockly-user-runtime-do" });
    }
    return jsonResponse({ error: "not found", code: "not_found" }, { status: 404 });
  }
}
