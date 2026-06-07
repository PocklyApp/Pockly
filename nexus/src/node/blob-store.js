/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from "node:fs";
import path from "node:path";

export function createLocalBlobStore(rootDir) {
  fs.mkdirSync(rootDir, { recursive: true });
  return new LocalBlobStore(rootDir);
}

class LocalBlobStore {
  constructor(rootDir) {
    this.rootDir = rootDir;
  }

  async get(key) {
    const file = this.pathForKey(key);
    if (!fs.existsSync(file)) return null;
    return {
      async text() {
        return fs.promises.readFile(file, "utf8");
      },
      async arrayBuffer() {
        const data = await fs.promises.readFile(file);
        return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      },
    };
  }

  async put(key, value) {
    const file = this.pathForKey(key);
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, value);
  }

  pathForKey(key) {
    return path.join(this.rootDir, normalizeBlobKey(key));
  }
}

export function normalizeBlobKey(key) {
  const normalized = String(key || "").replace(/^\/+/, "");
  if (!normalized || normalized.includes("..") || path.isAbsolute(normalized)) {
    throw new Error(`invalid blob key: ${key}`);
  }
  return normalized;
}
