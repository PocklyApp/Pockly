/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

import { normalizeBlobKey } from "./blob-store.js";

export function createS3BlobStore(options = {}) {
  const bucket = options.bucket || process.env.POCKLY_NEXUS_S3_BUCKET || process.env.S3_BUCKET;
  if (!bucket) throw new Error("S3 bucket required");
  const client = options.client || new S3Client({
    region: options.region || process.env.POCKLY_NEXUS_S3_REGION || process.env.AWS_REGION || "auto",
    endpoint: options.endpoint || process.env.POCKLY_NEXUS_S3_ENDPOINT || process.env.S3_ENDPOINT,
    forcePathStyle: boolOption(options.forcePathStyle, envBool(process.env.POCKLY_NEXUS_S3_FORCE_PATH_STYLE || process.env.S3_FORCE_PATH_STYLE)),
    credentials: options.credentials || credentialsFromEnv(),
  });
  return new S3BlobStore({ client, bucket, prefix: options.prefix ?? process.env.POCKLY_NEXUS_S3_PREFIX ?? "" });
}

class S3BlobStore {
  constructor({ client, bucket, prefix = "" }) {
    this.client = client;
    this.bucket = bucket;
    this.prefix = String(prefix || "").replace(/^\/+|\/+$/g, "");
  }

  async get(key) {
    const s3Key = this.s3Key(key);
    try {
      const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: s3Key }));
      const data = await bodyToBuffer(result.Body);
      return {
        async text() {
          return data.toString("utf8");
        },
        async arrayBuffer() {
          return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
        },
      };
    } catch (error) {
      if (isMissingObjectError(error)) return null;
      throw error;
    }
  }

  async put(key, value) {
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: this.s3Key(key),
      Body: value,
    }));
  }

  s3Key(key) {
    const normalized = normalizeBlobKey(key);
    return this.prefix ? `${this.prefix}/${normalized}` : normalized;
  }
}

async function bodyToBuffer(body) {
  if (!body) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (typeof body.transformToByteArray === "function") return Buffer.from(await body.transformToByteArray());
  if (typeof body.arrayBuffer === "function") return Buffer.from(await body.arrayBuffer());
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function isMissingObjectError(error) {
  return error?.name === "NoSuchKey" || error?.$metadata?.httpStatusCode === 404;
}

function credentialsFromEnv() {
  const accessKeyId = process.env.POCKLY_NEXUS_S3_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.POCKLY_NEXUS_S3_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) return undefined;
  return {
    accessKeyId,
    secretAccessKey,
    sessionToken: process.env.POCKLY_NEXUS_S3_SESSION_TOKEN || process.env.AWS_SESSION_TOKEN,
  };
}

function envBool(value) {
  return value === "1" || value === "true";
}

function boolOption(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  return value === true || value === "1" || value === "true";
}
