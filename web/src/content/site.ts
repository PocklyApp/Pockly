/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TFunction } from "i18next";

export type LandingFeature = {
  eyebrow: string;
  title: string;
  body: string;
};

export type ChangelogEntry = {
  version: string;
  date: string;
  title: string;
  summary: string;
  tags: string[];
};

export function getSiteContent(t: TFunction) {
  const landingFeatures: LandingFeature[] = [
    {
      eyebrow: t("site.features.mobile.eyebrow"),
      title: t("site.features.mobile.title"),
      body: t("site.features.mobile.body"),
    },
    {
      eyebrow: t("site.features.bridge.eyebrow"),
      title: t("site.features.bridge.title"),
      body: t("site.features.bridge.body"),
    },
    {
      eyebrow: t("site.features.trust.eyebrow"),
      title: t("site.features.trust.title"),
      body: t("site.features.trust.body"),
    },
    {
      eyebrow: t("site.features.offline.eyebrow"),
      title: t("site.features.offline.title"),
      body: t("site.features.offline.body"),
    },
  ];

  // Docs content now lives in ./content/docs.ts (block-based, bilingual) and is
  // rendered directly by DocsPage. The old single-paragraph docsSections were
  // removed here.

  // Pockly is pre-1.0 and ships continuously, so the changelog is a single
  // entry describing the current release rather than a phase-by-phase trail.
  const changelogEntries: ChangelogEntry[] = [
    {
      version: "v0.6",
      date: "2026-06-03",
      title: t("site.changelog.current.title"),
      summary: t("site.changelog.current.summary"),
      tags: [t("site.tags.daemon"), t("site.tags.web"), t("site.tags.security")],
    },
  ];

  return { landingFeatures, changelogEntries };
}
