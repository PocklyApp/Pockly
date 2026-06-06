/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import test from "node:test";
import assert from "node:assert/strict";

import { shouldClaimLocalSetup } from "./App";

// Device binding (/local-setup → /api/daemon/local-claim) must require a fresh
// password re-auth performed on the page, even when a session already exists.
// The bug was: an existing login silently completed the claim.

test("local-setup claim does NOT fire on an existing session alone", () => {
  assert.equal(
    shouldClaimLocalSetup({ authStatus: "authenticated", routeView: "localSetup", setupReauthed: false, phase: "idle" }),
    false,
  );
});

test("local-setup claim fires only after a fresh re-auth", () => {
  assert.equal(
    shouldClaimLocalSetup({ authStatus: "authenticated", routeView: "localSetup", setupReauthed: true, phase: "idle" }),
    true,
  );
});

test("local-setup claim never double-fires while claiming or after done", () => {
  assert.equal(
    shouldClaimLocalSetup({ authStatus: "authenticated", routeView: "localSetup", setupReauthed: true, phase: "claiming" }),
    false,
  );
  assert.equal(
    shouldClaimLocalSetup({ authStatus: "authenticated", routeView: "localSetup", setupReauthed: true, phase: "done" }),
    false,
  );
});

test("local-setup claim requires the localSetup route and an authenticated user", () => {
  assert.equal(
    shouldClaimLocalSetup({ authStatus: "anonymous", routeView: "localSetup", setupReauthed: true, phase: "idle" }),
    false,
  );
  assert.equal(
    shouldClaimLocalSetup({ authStatus: "authenticated", routeView: "workspaceSessions", setupReauthed: true, phase: "idle" }),
    false,
  );
});
