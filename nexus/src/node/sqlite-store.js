/*
 * Copyright 2026 Pockly contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import { SQLNexusStore } from "../store.js";
import { readMigrationSQLFiles } from "./migrations.js";

export function createSQLiteNexusStore(options = {}) {
  const databasePath = options.databasePath || path.join(options.dataDir || defaultNexusDataDir(), "nexus.sqlite");
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new Database(databasePath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  for (const sql of readMigrationSQLFiles()) db.exec(sql);
  const store = new SQLNexusStore(new SQLiteStatementAdapter(db));
  store.databasePath = databasePath;
  store.close = () => db.close();
  return store;
}

export function defaultNexusDataDir() {
  return process.env.POCKLY_NEXUS_DATA_DIR || path.join(process.env.HOME || process.cwd(), ".pockly", "nexus");
}

class SQLiteStatementAdapter {
  constructor(db) {
    this.db = db;
  }

  prepare(sql) {
    return new SQLiteStatement(this.db.prepare(translateSQLiteSQL(sql)));
  }
}

function translateSQLiteSQL(sql) {
  return sql.replace(/\bIS\s+DISTINCT\s+FROM\b/gi, "IS NOT");
}

class SQLiteStatement {
  constructor(statement, values = []) {
    this.statement = statement;
    this.values = values;
  }

  bind(...values) {
    return new SQLiteStatement(this.statement, values);
  }

  async run() {
    const result = this.statement.run(...this.values);
    return {
      success: true,
      meta: {
        changes: result.changes,
        last_row_id: result.lastInsertRowid,
      },
    };
  }

  async first() {
    return this.statement.get(...this.values) ?? null;
  }

  async all() {
    return {
      results: this.statement.all(...this.values),
      success: true,
    };
  }
}
