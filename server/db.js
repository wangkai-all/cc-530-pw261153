'use strict';
// 数据库层：schema 定义 + 种子数据
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS datasets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  owner TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS dataset_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dataset_id INTEGER NOT NULL REFERENCES datasets(id),
  version INTEGER NOT NULL,
  row_count INTEGER NOT NULL,
  null_rate REAL NOT NULL,
  schema_json TEXT NOT NULL,          -- ["col1","col2",...]
  data_hash TEXT NOT NULL,            -- 内容指纹，冻结快照时记录
  created_at TEXT NOT NULL,
  UNIQUE(dataset_id, version)
);

CREATE TABLE IF NOT EXISTS metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  definition TEXT NOT NULL,
  dataset_id INTEGER NOT NULL REFERENCES datasets(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS quality_gates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  dataset_id INTEGER NOT NULL REFERENCES datasets(id),
  rules_json TEXT NOT NULL,           -- {max_null_rate, min_row_count, required_columns[]}
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  owner TEXT NOT NULL,
  current_version_id INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS product_datasets (
  product_id INTEGER NOT NULL REFERENCES products(id),
  dataset_id INTEGER NOT NULL REFERENCES datasets(id),
  PRIMARY KEY (product_id, dataset_id)
);

CREATE TABLE IF NOT EXISTS product_metrics (
  product_id INTEGER NOT NULL REFERENCES products(id),
  metric_id INTEGER NOT NULL REFERENCES metrics(id),
  PRIMARY KEY (product_id, metric_id)
);

CREATE TABLE IF NOT EXISTS product_gates (
  product_id INTEGER NOT NULL REFERENCES products(id),
  gate_id INTEGER NOT NULL REFERENCES quality_gates(id),
  PRIMARY KEY (product_id, gate_id)
);

-- 产品间依赖：product_id 依赖 depends_on_product_id（上游产品必须先有已发布版本）
CREATE TABLE IF NOT EXISTS product_dependencies (
  product_id INTEGER NOT NULL REFERENCES products(id),
  depends_on_product_id INTEGER NOT NULL REFERENCES products(id),
  PRIMARY KEY (product_id, depends_on_product_id)
);

CREATE TABLE IF NOT EXISTS product_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id),
  version TEXT NOT NULL,
  status TEXT NOT NULL,               -- PUBLISHING / PUBLISHED / FAILED / DEPRECATED / ROLLED_BACK
  snapshot_json TEXT,                 -- 冻结的输入快照
  idempotency_key TEXT UNIQUE,
  fail_stage TEXT,
  fail_reason TEXT,
  created_at TEXT NOT NULL,
  published_at TEXT,
  UNIQUE(product_id, version)
);

CREATE TABLE IF NOT EXISTS publish_stages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id INTEGER NOT NULL REFERENCES product_versions(id),
  seq INTEGER NOT NULL,
  stage TEXT NOT NULL,                -- VALIDATE/FREEZE_SNAPSHOT/QUALITY_GATE/DEPENDENCY_CHECK/PUBLISH/NOTIFY
  status TEXT NOT NULL,               -- OK / FAILED / SKIPPED
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS subscribers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  product_id INTEGER NOT NULL REFERENCES products(id),
  status TEXT NOT NULL DEFAULT 'ACTIVE',   -- ACTIVE / PENDING(待处理)
  permissions_json TEXT NOT NULL DEFAULT '[]', -- 可消费的指标名列表
  pinned_version_id INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS subscriber_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscriber_id INTEGER NOT NULL REFERENCES subscribers(id),
  version_id INTEGER,
  type TEXT NOT NULL,                 -- VERSION_PUBLISHED / VERSION_DEPRECATED / ROLLBACK / PERMISSION_NARROWED
  diff_json TEXT NOT NULL,            -- 差异内容
  status TEXT NOT NULL DEFAULT 'PENDING',  -- PENDING / ACKED
  created_at TEXT NOT NULL,
  acked_at TEXT
);

CREATE TABLE IF NOT EXISTS rollback_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id),
  from_version_id INTEGER NOT NULL,
  to_version_id INTEGER NOT NULL,
  reason TEXT NOT NULL,
  operator TEXT NOT NULL,
  affected_subscribers INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
`;

function now() {
  return new Date().toISOString();
}

function createDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  return db;
}

module.exports = { createDb, now };
