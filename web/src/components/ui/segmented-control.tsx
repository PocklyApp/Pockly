/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ReactNode } from "react";
import { cn } from "../../lib/cn";
import { Button } from "./button";

export type SegmentedOption = {
  value: string;
  label: ReactNode;
};

export function SegmentedControl({
  value,
  options,
  onValueChange,
  className,
}: {
  value: string;
  options: SegmentedOption[];
  onValueChange: (value: string) => void;
  className?: string;
}) {
  return (
    <div className={cn("ui-segmented", className)}>
      {options.map((option) => (
        <Button
          key={option.value}
          type="button"
          variant="ghost"
          className={option.value === value ? "is-active" : ""}
          aria-pressed={option.value === value}
          onClick={() => onValueChange(option.value)}
        >
          {option.label}
        </Button>
      ))}
    </div>
  );
}
