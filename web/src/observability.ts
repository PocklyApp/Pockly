/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { getRuntimeConfig } from "./runtime-config";

let localDebugEnabled = false;

export function initObservability() {
  const cfg = getRuntimeConfig();
  localDebugEnabled = flagEnabled(cfg.telemetryDebug);
}

export function telemetryNetworkEnabled() {
  const cfg = getRuntimeConfig();
  return flagEnabled(cfg.telemetryEnabled);
}

export function trackEvent(name: string, attributes: Record<string, string | number | boolean | undefined> = {}) {
  if (!localDebugEnabled) return;
  console.debug("[pockly:event]", name, sanitizeAttributes(attributes));
}

function sanitizeAttributes(attributes: Record<string, string | number | boolean | undefined>) {
  const safeAttributes: Record<string, string> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (value == null) continue;
    if (/token|password|prompt|text|payload|cipher|code/i.test(key)) continue;
    safeAttributes[key] = String(value);
  }
  return safeAttributes;
}

function flagEnabled(value: unknown) {
  return value === true || value === "true" || value === "1" || value === "on" || value === "enabled";
}
