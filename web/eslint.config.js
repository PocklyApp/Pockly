/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "node_modules", ".local", "test-results"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["public/sw.js"],
    languageOptions: {
      ecmaVersion: 2022,
      globals: {
        URL: "readonly",
        clients: "readonly",
        self: "readonly",
      },
    },
    rules: {
      "no-useless-assignment": "off",
    },
  },
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      globals: {
        AbortController: "readonly",
        Blob: "readonly",
        CryptoKey: "readonly",
        Document: "readonly",
        Event: "readonly",
        HTMLElement: "readonly",
        HTMLPreElement: "readonly",
        KeyboardEvent: "readonly",
        MediaQueryListEvent: "readonly",
        Notification: "readonly",
        PushSubscription: "readonly",
        RequestInit: "readonly",
        Response: "readonly",
        ServiceWorkerRegistration: "readonly",
        TextDecoder: "readonly",
        TextEncoder: "readonly",
        URL: "readonly",
        WebSocket: "readonly",
        Window: "readonly",
        crypto: "readonly",
        document: "readonly",
        localStorage: "readonly",
        navigator: "readonly",
        queueMicrotask: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        window: "readonly",
      },
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": "off",
      "react-hooks/exhaustive-deps": "off",
      "react-hooks/set-state-in-effect": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["error", { "argsIgnorePattern": "^_", "varsIgnorePattern": "^_" }],
      "no-useless-assignment": "off",
    },
  },
);
