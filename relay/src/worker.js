/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { handleRequest } from "./app.js";
import { UserRuntimeDO } from "./durable-objects/user-runtime.js";

export { UserRuntimeDO };

export default {
  fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  },
};
