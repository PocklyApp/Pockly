/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import test from "node:test";
import assert from "node:assert/strict";

import { buildNewTaskRequestBody } from "./api";

test("new task request body carries codex effort and permission settings", () => {
  assert.deepEqual(
    buildNewTaskRequestBody({
      daemonDeviceId: "dd_test",
      agent: "codex",
      cwd: "/tmp/project",
      text: "hello",
      model: "gpt-5.1-codex",
      permissionMode: "auto",
      effort: "minimal",
    }),
    {
      daemon_device_id: "dd_test",
      agent: "codex",
      cwd: "/tmp/project",
      text: "hello",
      model: "gpt-5.1-codex",
      permission_mode: "auto",
      effort: "minimal",
    },
  );
});
