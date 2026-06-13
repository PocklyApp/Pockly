#!/usr/bin/env node

import { createReadStream } from "node:fs";
import { basename } from "node:path";
import { createInterface } from "node:readline";
import { gzipSync } from "node:zlib";

const defaults = Object.freeze({
  thresholdBytes: 32 * 1024,
  batchRawBytes: 1024 * 1024,
  r2ClassAPerMillionUSD: 4.50,
  r2StorageGBMonthUSD: 0.015,
});

async function main() {
  const { files, options } = parseArgs(process.argv.slice(2));
  if (!files.length || options.help) {
    printUsage(options.help ? 0 : 1);
    return;
  }

  const estimates = [];
  for (const file of files) {
    estimates.push(await estimateFile(file, options));
  }
  const total = estimates.reduce((acc, estimate) => combineEstimates(acc, estimate), emptyEstimate("total"));

  for (const estimate of estimates) printEstimate(estimate, options);
  if (estimates.length > 1) printEstimate(total, options);
}

function parseArgs(args) {
  const options = { ...defaults };
  const files = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--threshold-bytes") {
      options.thresholdBytes = positiveInteger(args[++index], "--threshold-bytes");
    } else if (arg === "--batch-raw-bytes") {
      options.batchRawBytes = positiveInteger(args[++index], "--batch-raw-bytes");
    } else if (arg === "--r2-class-a-per-million-usd") {
      options.r2ClassAPerMillionUSD = positiveNumber(args[++index], "--r2-class-a-per-million-usd");
    } else if (arg === "--r2-storage-gb-month-usd") {
      options.r2StorageGBMonthUSD = positiveNumber(args[++index], "--r2-storage-gb-month-usd");
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown option: ${arg}`);
    } else {
      files.push(arg);
    }
  }
  return { files, options };
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function positiveNumber(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative number`);
  return parsed;
}

async function estimateFile(file, options) {
  const estimate = emptyEstimate(file);
  const batch = [];
  let batchBytes = 0;

  const flushBatch = () => {
    if (!batch.length) return;
    if (batch.length === 1) {
      estimate.batchObjects += 1;
      estimate.batchEncodedBytes += batch[0].gzipBytes;
    } else {
      const manifest = JSON.stringify({
        pockly_payload_batch: "turn_payloads",
        version: 1,
        items: batch.map((item, index) => ({
          seq: index + 1,
          bytes: item.bytes,
          payload: item.payload,
        })),
      });
      estimate.batchObjects += 1;
      estimate.batchEncodedBytes += gzipSync(manifest).byteLength;
    }
    batch.length = 0;
    batchBytes = 0;
  };

  const lines = createInterface({
    input: createReadStream(file, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    estimate.lines += 1;
    const bytes = Buffer.byteLength(line);
    estimate.rawBytes += bytes;
    if (bytes < options.thresholdBytes) continue;
    const gzipBytes = gzipSync(line).byteLength;
    estimate.externalizedLines += 1;
    estimate.externalizedRawBytes += bytes;
    estimate.singleObjects += 1;
    estimate.singleEncodedBytes += gzipBytes;

    if (batch.length > 0 && batchBytes + bytes > options.batchRawBytes) flushBatch();
    batch.push({ bytes, gzipBytes, payload: line });
    batchBytes += bytes;
  }
  flushBatch();
  return estimate;
}

function emptyEstimate(file) {
  return {
    file,
    lines: 0,
    rawBytes: 0,
    externalizedLines: 0,
    externalizedRawBytes: 0,
    singleObjects: 0,
    singleEncodedBytes: 0,
    batchObjects: 0,
    batchEncodedBytes: 0,
  };
}

function combineEstimates(left, right) {
  return {
    ...left,
    lines: left.lines + right.lines,
    rawBytes: left.rawBytes + right.rawBytes,
    externalizedLines: left.externalizedLines + right.externalizedLines,
    externalizedRawBytes: left.externalizedRawBytes + right.externalizedRawBytes,
    singleObjects: left.singleObjects + right.singleObjects,
    singleEncodedBytes: left.singleEncodedBytes + right.singleEncodedBytes,
    batchObjects: left.batchObjects + right.batchObjects,
    batchEncodedBytes: left.batchEncodedBytes + right.batchEncodedBytes,
  };
}

function printEstimate(estimate, options) {
  const singleClassA = estimate.singleObjects / 1_000_000 * options.r2ClassAPerMillionUSD;
  const batchClassA = estimate.batchObjects / 1_000_000 * options.r2ClassAPerMillionUSD;
  const singleStorage = bytesToGiB(estimate.singleEncodedBytes) * options.r2StorageGBMonthUSD;
  const batchStorage = bytesToGiB(estimate.batchEncodedBytes) * options.r2StorageGBMonthUSD;
  const savedObjects = estimate.singleObjects - estimate.batchObjects;
  const savedClassA = singleClassA - batchClassA;

  console.log(JSON.stringify({
    file: estimate.file === "total" ? "total" : basename(estimate.file),
    threshold_bytes: options.thresholdBytes,
    batch_raw_bytes: options.batchRawBytes,
    lines: estimate.lines,
    raw_bytes: estimate.rawBytes,
    externalized_lines: estimate.externalizedLines,
    externalized_raw_bytes: estimate.externalizedRawBytes,
    single_blob: {
      objects: estimate.singleObjects,
      encoded_bytes: estimate.singleEncodedBytes,
      class_a_usd: roundUSD(singleClassA),
      storage_usd_per_month: roundUSD(singleStorage),
    },
    batch_blob: {
      objects: estimate.batchObjects,
      encoded_bytes: estimate.batchEncodedBytes,
      class_a_usd: roundUSD(batchClassA),
      storage_usd_per_month: roundUSD(batchStorage),
    },
    savings: {
      objects: savedObjects,
      class_a_usd: roundUSD(savedClassA),
      class_a_percent: estimate.singleObjects > 0 ? Number((savedObjects / estimate.singleObjects * 100).toFixed(2)) : 0,
      storage_usd_per_month: roundUSD(singleStorage - batchStorage),
    },
  }, null, 2));
}

function bytesToGiB(bytes) {
  return bytes / 1024 / 1024 / 1024;
}

function roundUSD(value) {
  return Number(value.toFixed(8));
}

function printUsage(exitCode) {
  const script = basename(process.argv[1] || "estimate-history-blob-cost.mjs");
  const out = exitCode === 0 ? console.log : console.error;
  out(`Usage: ${script} [options] <rollout-or-jsonl>...

Estimate large history payload storage cost by comparing one R2 object per
oversized JSONL line with Pockly's batched history blob layout.

Options:
  --threshold-bytes <n>              Payload externalization threshold. Default: ${defaults.thresholdBytes}
  --batch-raw-bytes <n>              Max raw bytes per batch object. Default: ${defaults.batchRawBytes}
  --r2-class-a-per-million-usd <n>   Class A operation price. Default: ${defaults.r2ClassAPerMillionUSD}
  --r2-storage-gb-month-usd <n>      Storage price. Default: ${defaults.r2StorageGBMonthUSD}
`);
  process.exitCode = exitCode;
}

main().catch((error) => {
  console.error(error?.stack || String(error));
  process.exitCode = 1;
});
