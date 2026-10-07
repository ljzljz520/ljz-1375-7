'use strict';
// 持久层：SQLite（WAL）。所有写操作经 better-sqlite3 同步事务，保证服务端原子性。
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS kiln_sites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  location_text TEXT NOT NULL DEFAULT '',
  lat REAL, lng REAL,
  coords_public INTEGER NOT NULL DEFAULT 0,   -- 窑址坐标默认禁止公开
  period_start INTEGER, period_end INTEGER,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS glazes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS forms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT ''
);

-- 通用工艺卡
CREATE TABLE IF NOT EXISTS processes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  summary TEXT NOT NULL DEFAULT '',
  card_body TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 材料卡：卡片本身只有状态，内容全部在版本表，历史版本永不改写
CREATE TABLE IF NOT EXISTS materials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','deleted')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS material_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  material_id INTEGER NOT NULL REFERENCES materials(id),
  version INTEGER NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (material_id, version)
);

CREATE TABLE IF NOT EXISTS process_materials (
  process_id INTEGER NOT NULL REFERENCES processes(id),
  material_id INTEGER NOT NULL REFERENCES materials(id),
  PRIMARY KEY (process_id, material_id)
);

CREATE TABLE IF NOT EXISTS exhibits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  kiln_site_id INTEGER REFERENCES kiln_sites(id),
  glaze_id INTEGER REFERENCES glazes(id),
  form_id INTEGER REFERENCES forms(id),
  statement TEXT NOT NULL DEFAULT '',          -- 展品陈述
  date_start INTEGER, date_end INTEGER,        -- 年代区间（年，公元前为负）
  uncertainty_years INTEGER NOT NULL DEFAULT 0,-- 不确定度 ±年
  era_note TEXT NOT NULL DEFAULT '',
  on_loan INTEGER NOT NULL DEFAULT 0,          -- 借展
  lender TEXT NOT NULL DEFAULT '',
  loan_note TEXT NOT NULL DEFAULT '',
  loan_allows_hires INTEGER NOT NULL DEFAULT 0,-- 出借协议是否允许公开高清图/打印说明
  approval TEXT NOT NULL DEFAULT 'draft' CHECK (approval IN ('draft','approved')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 展品特定说明：对通用工艺卡的局部例外，全局更新不得覆盖
CREATE TABLE IF NOT EXISTS exhibit_processes (
  exhibit_id INTEGER NOT NULL REFERENCES exhibits(id),
  process_id INTEGER NOT NULL REFERENCES processes(id),
  use_local INTEGER NOT NULL DEFAULT 0,
  local_note TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (exhibit_id, process_id)
);

-- 来源争议
CREATE TABLE IF NOT EXISTS provenance_disputes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  exhibit_id INTEGER NOT NULL REFERENCES exhibits(id),
  claim TEXT NOT NULL DEFAULT '',
  counter_claim TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  approval TEXT NOT NULL DEFAULT 'draft' CHECK (approval IN ('draft','approved')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  approval TEXT NOT NULL DEFAULT 'draft' CHECK (approval IN ('draft','approved')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 引用图：文章引用材料卡/工序/展品（材料记录所引版本）
CREATE TABLE IF NOT EXISTS article_citations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id INTEGER NOT NULL REFERENCES articles(id),
  target_type TEXT NOT NULL CHECK (target_type IN ('material','process','exhibit')),
  target_id INTEGER NOT NULL,
  version INTEGER,                              -- 材料卡引用的版本号
  review_status TEXT NOT NULL DEFAULT 'ok' CHECK (review_status IN ('ok','needs_review'))
);

CREATE TABLE IF NOT EXISTS licenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,                           -- 如 CC-BY
  version TEXT NOT NULL,                        -- 许可版本 如 4.0
  text TEXT NOT NULL DEFAULT '',
  UNIQUE (code, version)
);

-- 高清图 / 打印说明，均绑定许可版本
CREATE TABLE IF NOT EXISTS media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  exhibit_id INTEGER NOT NULL REFERENCES exhibits(id),
  kind TEXT NOT NULL CHECK (kind IN ('image_hires','print')),
  path TEXT NOT NULL,
  license_id INTEGER NOT NULL REFERENCES licenses(id),
  approval TEXT NOT NULL DEFAULT 'draft' CHECK (approval IN ('draft','approved'))
);

CREATE TABLE IF NOT EXISTS workshops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  capacity INTEGER NOT NULL CHECK (capacity >= 0),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workshop_id INTEGER NOT NULL REFERENCES workshops(id),
  name TEXT NOT NULL,
  contact TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('confirmed','waitlist','cancelled')),
  waitlist_pos INTEGER,
  receipt_code TEXT NOT NULL UNIQUE,            -- 确认回执
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_bookings_ws ON bookings(workshop_id, status, waitlist_pos);
CREATE INDEX IF NOT EXISTS idx_bookings_contact ON bookings(contact);

-- 候补/取消/转正的事件时序
CREATE TABLE IF NOT EXISTS booking_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER NOT NULL REFERENCES bookings(id),
  workshop_id INTEGER NOT NULL,
  event TEXT NOT NULL,                          -- created_confirmed/created_waitlist/cancelled/promoted
  at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS publish_releases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('ok','failed')),
  error TEXT NOT NULL DEFAULT '',
  built_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

function openDb(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

module.exports = { openDb };
