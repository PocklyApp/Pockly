/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { en } from "./locales/en";
import { zhCN } from "./locales/zh-CN";

export const languageStorageKey = "pockly-language";
export const defaultLanguage = "en";
export const supportedLanguages = ["en", "zh-CN"] as const;
export type SupportedLanguage = (typeof supportedLanguages)[number];

export function isSupportedLanguage(value: string | null | undefined): value is SupportedLanguage {
  return value === "en" || value === "zh-CN";
}

export function detectInitialLanguage(): SupportedLanguage {
  if (typeof window === "undefined") return defaultLanguage;
  const stored = window.localStorage.getItem(languageStorageKey);
  if (isSupportedLanguage(stored)) return stored;
  const browserLanguage = window.navigator.language || "";
  return browserLanguage.toLowerCase().startsWith("zh") ? "zh-CN" : defaultLanguage;
}

export function setDocumentLanguage(language: string) {
  if (typeof document === "undefined") return;
  document.documentElement.lang = isSupportedLanguage(language) ? language : defaultLanguage;
}

void i18n
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      "zh-CN": { translation: zhCN },
    },
    lng: detectInitialLanguage(),
    fallbackLng: defaultLanguage,
    interpolation: {
      escapeValue: false,
    },
    returnNull: false,
  });

setDocumentLanguage(i18n.language);

i18n.on("languageChanged", (language) => {
  const next = isSupportedLanguage(language) ? language : defaultLanguage;
  if (typeof window !== "undefined") {
    window.localStorage.setItem(languageStorageKey, next);
  }
  setDocumentLanguage(next);
});

export { i18n };
