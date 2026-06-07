/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createS3BlobStore } from "../src/node/s3-store.js";

describe("Node production S3-compatible blob store adapter", () => {
  it("puts and gets release blobs with bucket and prefix", async () => {
    const client = new FakeS3Client();
    const store = createS3BlobStore({ client, bucket: "example-releases", prefix: "prod" });

    await store.put("pockly-daemon/latest/checksums.txt", "abc");
    assert.deepEqual(client.commands[0], {
      name: "PutObjectCommand",
      input: {
        Bucket: "example-releases",
        Key: "prod/pockly-daemon/latest/checksums.txt",
        Body: "abc",
      },
    });

    const object = await store.get("pockly-daemon/latest/checksums.txt");
    assert.equal(await object.text(), "abc");
    assert.equal(Buffer.from(await object.arrayBuffer()).toString("utf8"), "abc");
    assert.deepEqual(client.commands[1], {
      name: "GetObjectCommand",
      input: {
        Bucket: "example-releases",
        Key: "prod/pockly-daemon/latest/checksums.txt",
      },
    });
  });

  it("returns null for missing objects and rejects unsafe keys", async () => {
    const store = createS3BlobStore({ client: new FakeS3Client(), bucket: "example-releases" });
    assert.equal(await store.get("missing.txt"), null);
    await assert.rejects(() => store.put("../escape", "bad"), /invalid blob key/);
  });
});

class FakeS3Client {
  constructor() {
    this.commands = [];
    this.objects = new Map();
  }

  async send(command) {
    this.commands.push({ name: command.constructor.name, input: command.input });
    if (command.constructor.name === "PutObjectCommand") {
      this.objects.set(`${command.input.Bucket}/${command.input.Key}`, command.input.Body);
      return {};
    }
    if (command.constructor.name === "GetObjectCommand") {
      const body = this.objects.get(`${command.input.Bucket}/${command.input.Key}`);
      if (body == null) {
        const error = new Error("NoSuchKey");
        error.name = "NoSuchKey";
        throw error;
      }
      return { Body: Buffer.from(body) };
    }
    throw new Error(`unexpected command ${command.constructor.name}`);
  }
}
