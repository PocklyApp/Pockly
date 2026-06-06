/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

export function AppShell({ children, className }: { children: ReactNode; className?: string }) {
  return <main className={cn("app-shell", className)}>{children}</main>;
}

export function Workspace({ view, children }: { view: string; children: ReactNode }) {
  const workspaceView = view.startsWith("workspace")
    ? view.slice("workspace".length).replace(/^[A-Z]/, (value) => value.toLowerCase())
    : view;
  return <section className={cn("workspace", `workspace-${workspaceView}`)}>{children}</section>;
}
