/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { Monitor, Moon, Sun } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useTheme, type ThemeMode } from "../../theme";
import { Button } from "../ui/button";

const modes: Array<{ mode: ThemeMode; labelKey: string; icon: typeof Monitor }> = [
  { mode: "system", labelKey: "common.system", icon: Monitor },
  { mode: "light", labelKey: "common.light", icon: Sun },
  { mode: "dark", labelKey: "common.dark", icon: Moon },
];

export function ThemeToggle() {
  const { t } = useTranslation();
  const { mode, setMode } = useTheme();
  const current = modes.findIndex((item) => item.mode === mode);
  const next = modes[(current + 1) % modes.length] ?? modes[0];
  const currentMode = modes[current] ?? modes[0];
  const Icon = currentMode.icon;
  const label = t("settings.themeWithMode", { mode: t(currentMode.labelKey) });

  return (
    <Button
      type="button"
      variant="icon"
      className="theme-toggle"
      title={label}
      aria-label={label}
      onClick={() => setMode(next.mode)}
    >
      <Icon aria-hidden="true" size={16} strokeWidth={1.8} />
    </Button>
  );
}
