import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { describe, it } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

describe("edge runtime cost estimator", () => {
  it("keeps the typical local-first profile near one cent per user month", async () => {
    const estimate = await runCostEstimator("typical");
    assert.ok(estimate.typical.usage.edge_requests <= 20_000, "typical profile must not hide high-frequency browser polling");
    assert.ok(estimate.typical.usage.coordination_requests <= 10_000, "typical profile must not reintroduce per-session coordination lookups");
    assert.ok(estimate.typical.marginal_usd_per_month.total <= 0.01);
  });

  it("models large sessions as local-first hot windows, not archive writes", async () => {
    const estimate = await runCostEstimator("large_local_first");
    assert.equal(estimate.large_local_first.usage.object_writes, 0);
    assert.ok(estimate.large_local_first.usage.sql_write_rows < 5_000);
    assert.ok(estimate.large_local_first.usage.edge_requests <= 16_500);
    assert.ok(estimate.large_local_first.usage.coordination_requests <= 6_500);
    assert.ok(estimate.large_local_first.marginal_usd_per_month.total <= 0.011);
  });

  it("models a hidden tab as paused after the background grace window", async () => {
    const estimate = await runCostEstimator("background_hanging_tab");
    assert.equal(estimate.background_hanging_tab.usage.edge_requests, 10);
    assert.equal(estimate.background_hanging_tab.usage.coordination_requests, 10);
    assert.ok(estimate.background_hanging_tab.marginal_usd_per_month.total <= 0.0001);
  });

  it("models multiple visible tabs as one network leader plus local followers", async () => {
    const estimate = await runCostEstimator("multi_tab_visible");
    assert.equal(estimate.multi_tab_visible.assumptions.visibleTabs, 3);
    assert.equal(estimate.multi_tab_visible.assumptions.followerLocalBroadcastOnly, true);
    assert.ok(estimate.multi_tab_visible.usage.edge_requests <= 15_000);
    assert.ok(estimate.multi_tab_visible.usage.coordination_requests <= 4_500);
    assert.ok(estimate.multi_tab_visible.marginal_usd_per_month.total <= 0.01);
  });

  it("accepts dashed pricing overrides", async () => {
    const estimate = await runCostEstimator("typical", [
      "--edge-request-usd-per-million",
      "0",
      "--coordination-request-usd-per-million",
      "0",
      "--sql-write-usd-per-million",
      "0",
    ]);
    assert.equal(estimate.typical.marginal_usd_per_month.edge_requests, 0);
    assert.equal(estimate.typical.marginal_usd_per_month.coordination_requests, 0);
    assert.equal(estimate.typical.marginal_usd_per_month.sql_writes, 0);
  });
});

async function runCostEstimator(profile, args = []) {
  const { stdout } = await execFileAsync("node", [
    "scripts/estimate-edge-runtime-cost.mjs",
    ...args,
    profile,
  ], { cwd: new URL("..", import.meta.url).pathname });
  return JSON.parse(stdout);
}
