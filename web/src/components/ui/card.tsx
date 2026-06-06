/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type { HTMLAttributes } from "react";
import { cn } from "../../lib/cn";

export function Card({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return <section className={cn("ui-card", className)} {...props} />;
}

export function Badge({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn("ui-badge", className)} {...props} />;
}

export function Notice({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("ui-notice", className)} {...props} />;
}
