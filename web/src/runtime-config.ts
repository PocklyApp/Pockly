/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

type PocklyRuntimeConfig = {
  nexusUrl?: string;
  relayUrl?: string;
  installShUrl?: string;
  installPs1Url?: string;
  installUnixCommand?: string;
  installWindowsCommand?: string;
  authHostLabel?: string;
  telemetryEnabled?: string | boolean;
  telemetryDebug?: string | boolean;
};

export function getRuntimeConfig(): PocklyRuntimeConfig {
  if (typeof window === "undefined") return {};
  return window.__POCKLY_RUNTIME_CONFIG__ || window.POCKLY_CONFIG || {};
}

export function configuredNexusURL(): string {
  const cfg = getRuntimeConfig();
  return cfg.nexusUrl || cfg.relayUrl || "";
}

export function configuredInstallUnixCommand(): string {
  const cfg = getRuntimeConfig();
  if (cfg.installUnixCommand) return cfg.installUnixCommand;
  const installURL = import.meta.env?.VITE_POCKLY_INSTALL_SH_URL || cfg.installShUrl || "";
  if (installURL) return `curl -fsSL ${installURL} | bash`;
  return "curl -fsSL https://your-nexus.example/install.sh | bash";
}

export function configuredInstallWindowsCommand(): string {
  const cfg = getRuntimeConfig();
  if (cfg.installWindowsCommand) return cfg.installWindowsCommand;
  const installURL = import.meta.env?.VITE_POCKLY_INSTALL_PS1_URL || cfg.installPs1Url || "";
  if (installURL) return `irm ${installURL} | iex`;
  return "irm https://your-nexus.example/install.ps1 | iex";
}

export function configuredAuthHostLabel(): string {
  const cfg = getRuntimeConfig();
  if (cfg.authHostLabel) return cfg.authHostLabel;
  const base = configuredNexusURL() || import.meta.env?.VITE_POCKLY_NEXUS_URL || import.meta.env?.VITE_POCKLY_RELAY_URL || "";
  try {
    if (base) return new URL(base).host;
  } catch {
    // Fall through to the neutral label.
  }
  return "Pockly Nexus";
}
