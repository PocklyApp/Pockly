/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { getWebInstrumentations, initializeFaro, faro } from "@grafana/faro-web-sdk";
import { ReactIntegration } from "@grafana/faro-react";

type RuntimeConfig = {
  faroEnabled?: string | boolean;
  faroUrl?: string;
  faroAppKey?: string;
  releaseSha?: string;
  environment?: string;
};

declare global {
  interface Window {
    POCKLY_CONFIG?: RuntimeConfig;
  }
}

let initialized = false;

export function initObservability() {
  const cfg = window.POCKLY_CONFIG ?? {};
  const enabled = cfg.faroEnabled === true || cfg.faroEnabled === "true" || cfg.faroEnabled === "1";
  if (!enabled || !cfg.faroUrl || initialized) return;
  initialized = true;

  initializeFaro({
    url: cfg.faroUrl,
    ...(cfg.faroAppKey ? { apiKey: cfg.faroAppKey } : {}),
    app: {
      name: "pockly-web",
      version: cfg.releaseSha || "dev",
      environment: cfg.environment || "production",
    },
    instrumentations: [
      ...getWebInstrumentations({
        captureConsole: false,
        enablePerformanceInstrumentation: true,
        enableContentSecurityPolicyInstrumentation: true,
      }),
      new ReactIntegration(),
    ],
    trackResources: false,
    beforeSend(item) {
      const payload = JSON.stringify(item);
      if (payload.includes("device_refresh_token") || payload.includes("device_access_token")) return null;
      if (payload.includes("password") || payload.includes("verification_code")) return null;
      return item;
    },
    pageTracking: {
      generatePageId: () => normalizePath(window.location.pathname),
    },
    ignoreUrls: [
      /\/api\/sessions\/[^/]+\/turns/,
      /\/api\/voice\/transcriptions/,
      /\/api\/device-challenge/,
      /\/api\/device-challenge\/verify/,
    ],
  });
}

export function trackEvent(name: string, attributes: Record<string, string | number | boolean | undefined> = {}) {
  if (!initialized) return;
  const safeAttributes: Record<string, string> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (value == null) continue;
    if (/token|password|prompt|text|payload|cipher|code/i.test(key)) continue;
    safeAttributes[key] = String(value);
  }
  faro.api.pushEvent(name, safeAttributes);
}

function normalizePath(path: string) {
  if (/^\/workspace\/s\/[^/]+$/.test(path)) return "/workspace/s/:session_id";
  if (/^\/s\/[^/]+$/.test(path)) return "/s/:session_id";
  if (path === "/cli/login") return "/cli/login";
  return path || "/";
}
