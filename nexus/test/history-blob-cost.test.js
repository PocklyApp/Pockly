import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

describe("history blob cost estimator", () => {
  it("shows batch objects reducing object-storage write operations for large histories", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pockly-history-cost-"));
    const file = join(dir, "rollout-test.jsonl");
    const largeLine = JSON.stringify({ type: "turn", text: "large payload ".repeat(128) });
    const smallLine = JSON.stringify({ type: "turn", text: "small" });
    await writeFile(file, [
      largeLine,
      largeLine.replace("large payload", "large output"),
      largeLine.replace("large payload", "large result"),
      smallLine,
    ].join("\n"));

    const { stdout } = await execFileAsync("node", [
      "scripts/estimate-history-blob-cost.mjs",
      "--threshold-bytes",
      "256",
      "--batch-raw-bytes",
      "8192",
      file,
    ], { cwd: new URL("..", import.meta.url).pathname });

    const estimate = JSON.parse(stdout);
    assert.equal(estimate.externalized_lines, 3);
    assert.equal(estimate.single_blob.objects, 3);
    assert.equal(estimate.batch_blob.objects, 1);
    assert.equal(estimate.savings.objects, 2);
    assert.ok(estimate.savings.class_a_usd > 0);
  });
});
