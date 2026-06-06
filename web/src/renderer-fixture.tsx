/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Renderer fixture mode — dev-only entry that mounts the real R1–R10
// rendering components against synthetic SessionTurn data so Playwright
// L3 specs can assert against deterministic conversation states.
//
// Activation: visit `/test/renderer?fixture=<name>` on the vite dev
// server. main.tsx branches to `mountRendererFixture` only when
// `import.meta.env.DEV` is true, so the entire fixture module + every
// JSON it imports tree-shakes out of production bundles.
//
// What this is NOT:
//   - It does NOT exercise the wrapper / relay / daemon chain. For
//     that, use the L2 API harness (`npm run e2e`).
//   - It does NOT cover auth / browser-device handshake / SSE bridges.
//     The fixture mounts with zero network requests by design.
//
// Each JSON fixture under src/test-fixtures/ declares a synthetic
// SessionListItem + an array of SessionTurn payloads. The fixture
// page composes them through the same `visibleConversationTurns()`
// pipeline the workspace uses (sidechain nesting, tool-pair merging,
// consecutive-tool grouping) so the rendered DOM matches what the
// real session view would produce.

import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  PermissionRequestsPanel,
  TokenUsagePie,
  MessageGroupArticle,
  visibleConversationTurns,
  groupTurnsForRender,
  latestSessionUsage,
  contextWindowForAgent,
  sessionDiffs,
  SessionDiffSheet,
} from "./App";
import type { SessionListItem, SessionTurn } from "./api";
import "./i18n";
import "./styles.css";

// JSON fixture imports. Vite's JSON loader gives us typed objects
// straight from the import — no fetch needed, no public/ assets, no
// network roundtrips during a Playwright spec. Each fixture adds
// ~1KB to the renderer-fixture chunk (which itself is lazy-loaded
// only on `/test/renderer`).
import r1Gfm from "./test-fixtures/r1-gfm.json";
import r3Bash from "./test-fixtures/r3-bash.json";
import r3BashWithResult from "./test-fixtures/r3-bash-with-result.json";
import r4PlanPending from "./test-fixtures/r4-plan-pending.json";
import r4PlanResolved from "./test-fixtures/r4-plan-resolved.json";
import r5QuestionSingle from "./test-fixtures/r5-question-single.json";
import r5QuestionMulti from "./test-fixtures/r5-question-multi.json";
import r6ImageBase64 from "./test-fixtures/r6-image-base64.json";
import r7Usage65pct from "./test-fixtures/r7-usage-65pct.json";
import r7UsageCodexDanger from "./test-fixtures/r7-usage-codex-danger.json";
import r8ThreePending from "./test-fixtures/r8-three-pending.json";
import internalAttachments from "./test-fixtures/internal-attachments.json";
import r9Mix from "./test-fixtures/r9-mix.json";
import r10BlockMath from "./test-fixtures/r10-block-math.json";
import r10CurrencyOnly from "./test-fixtures/r10-currency-only.json";
import websearch from "./test-fixtures/websearch.json";
import codehl from "./test-fixtures/codehl.json";

// FixtureData uses Partial<SessionListItem> because the JSON fixtures
// only set the fields the renderer actually reads (session_id,
// device_id, agent, cwd, last_timestamp). Required workspace fields
// like `snippet` and `last_seq` get padded at hydration time below —
// keeps the JSON terse and avoids per-fixture boilerplate.
type FixtureData = {
  name: string;
  session: Partial<SessionListItem> & Pick<SessionListItem, "session_id" | "device_id" | "agent">;
  turns: SessionTurn[];
};

// Catalog: fixture key → loaded JSON. Adding a new fixture is one
// import + one entry. Keys match the JSON `name` field so a missing
// import shows up as `undefined` rather than a stale name lookup.
const FIXTURES: Record<string, FixtureData> = {
  "r1-gfm":               r1Gfm as unknown as FixtureData,
  "r3-bash":              r3Bash as unknown as FixtureData,
  "r3-bash-with-result":  r3BashWithResult as unknown as FixtureData,
  "r4-plan-pending":      r4PlanPending as unknown as FixtureData,
  "r4-plan-resolved":     r4PlanResolved as unknown as FixtureData,
  "r5-question-single":   r5QuestionSingle as unknown as FixtureData,
  "r5-question-multi":    r5QuestionMulti as unknown as FixtureData,
  "r6-image-base64":      r6ImageBase64 as unknown as FixtureData,
  "r7-usage-65pct":       r7Usage65pct as unknown as FixtureData,
  "r7-usage-codex":       r7UsageCodexDanger as unknown as FixtureData,
  "r8-three-pending":     r8ThreePending as unknown as FixtureData,
  "internal-attachments": internalAttachments as unknown as FixtureData,
  "r9-mix":               r9Mix as unknown as FixtureData,
  "r10-block-math":       r10BlockMath as unknown as FixtureData,
  "r10-currency-only":    r10CurrencyOnly as unknown as FixtureData,
  "websearch":            websearch as unknown as FixtureData,
  "codehl":               codehl as unknown as FixtureData,
};

// Pad a fixture's partial session into the full SessionListItem shape
// the renderer expects. The added defaults are renderer-irrelevant
// (cwd, snippet, last_seq) — workspace code uses them but the
// fixture-rendered components do not.
function hydrateSession(partial: FixtureData["session"]): SessionListItem {
  return {
    cwd: "/tmp",
    snippet: "",
    last_seq: 0,
    last_timestamp: "",
    ...partial,
  } as SessionListItem;
}

function FixturePage({ fixtureName }: { fixtureName: string }) {
  const fixture = FIXTURES[fixtureName];
  // turns held in state so test hooks can swap them at runtime
  // (mainly used for R8's "banner self-hides" case where the test
  // resolves a pending request without a page reload).
  const [turns, setTurns] = useState<SessionTurn[]>(fixture?.turns ?? []);

  // Expose a tiny test-only API on window so specs can manipulate
  // state without reloading the page. Mirrors the existing
  // `window.__pocklyTestHooks` pattern but scoped to the fixture
  // entry — no production code calls these.
  useEffect(() => {
    type Hooks = {
      setTurns: (next: SessionTurn[]) => void;
      getTurns: () => SessionTurn[];
      getFixtureName: () => string;
    };
    const hooks: Hooks = {
      setTurns: (next) => setTurns(next),
      getTurns: () => turns,
      getFixtureName: () => fixtureName,
    };
    (window as unknown as { __rendererFixture: Hooks }).__rendererFixture = hooks;
    return () => {
      delete (window as unknown as { __rendererFixture?: Hooks }).__rendererFixture;
    };
  }, [turns, fixtureName]);

  const session = useMemo(
    () => fixture ? hydrateSession(fixture.session) : null,
    [fixture],
  );
  const visible = useMemo(() => visibleConversationTurns(turns), [turns]);
  const diffs = useMemo(() => sessionDiffs(turns), [turns]);
  const [diffsOpen, setDiffsOpen] = useState(false);
  const usage = useMemo(
    () => session ? latestSessionUsage(turns, session.agent) : null,
    [turns, session],
  );

  if (!fixture || !session) {
    return (
      <div className="fixture-error" data-testid="fixture-error">
        Unknown fixture: <code>{fixtureName}</code>. Available:{" "}
        {Object.keys(FIXTURES).join(", ")}
      </div>
    );
  }

  // Lightweight header so the fixture renders the TokenUsagePie next
  // to a session label, matching the visual context of the real
  // workspace without dragging AgentConversationHeader's full prop
  // surface in.
  return (
    <div className="fixture-root" data-fixture={fixtureName}>
      <header className="fixture-header">
        <strong>{session.session_id}</strong>
        <span className="fixture-meta">
          agent={session.agent}
          {" · "}
          {usage ? `${usage.used.toLocaleString()} / ${usage.total.toLocaleString()} tokens` : "no usage"}
          {" · "}
          window={contextWindowForAgent(session.agent).toLocaleString()}
        </span>
        {usage ? <TokenUsagePie usage={usage} /> : null}
      </header>
      <div className="fixture-turns ws-mg-list" data-testid="fixture-turns">
        {groupTurnsForRender(visible).map((group) => (
          <MessageGroupArticle key={group.key} group={group} />
        ))}
      </div>
      <PermissionRequestsPanel turns={turns} />
      {diffs.length > 0 ? (
        <div className="composer-pills-row" style={{ padding: "12px 4px" }} data-testid="fixture-diff-pill-row">
          <button type="button" className="composer-diff-pill" aria-expanded={diffsOpen} onClick={() => setDiffsOpen(true)}>
            <span className="k">Diffs</span>
            <span className="composer-diff-badge">{diffs.length}</span>
          </button>
        </div>
      ) : null}
      <SessionDiffSheet diffs={diffs} open={diffsOpen} onClose={() => setDiffsOpen(false)} />
    </div>
  );
}

function parseFixtureName(): string {
  const params = new URLSearchParams(window.location.search);
  return params.get("fixture") || "";
}

export function mountRendererFixture(rootEl: HTMLElement) {
  // Force-set DEV-only data attribute so specs can sanity-check they
  // landed on the fixture page (not redirected to the splash by some
  // routing accident).
  document.documentElement.setAttribute("data-renderer-fixture", "1");
  const fixtureName = parseFixtureName();
  createRoot(rootEl).render(<FixturePage fixtureName={fixtureName} />);
}
