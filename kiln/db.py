"""数据库层：SQLite 持久化、事务、版本快照。

设计要点：
- 所有写操作走 tx()（BEGIN IMMEDIATE），保证"名额原子占用"等临界区在
  服务端串行执行，杜绝超卖。
- 业务表保存当前草稿；entity_versions 保存每一次变更的完整快照，
  历史记载永不丢失、永不被自动改写。
- approvals 记录"哪个版本被批准"，公开静态站只从批准版本构建。
"""
import json
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime, timezone

SCHEMA = """
CREATE TABLE IF NOT EXISTS kiln_sites(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  lat REAL, lng REAL,
  coord_visibility TEXT NOT NULL DEFAULT 'private'
    CHECK(coord_visibility IN('public','private')),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS glazes(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS vessel_forms(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS process_cards(          -- 通用工艺卡
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS materials(              -- 材料卡（软删除）
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  deleted_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS process_material_refs(  -- 工序-材料 引用图
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  process_id INTEGER NOT NULL REFERENCES process_cards(id),
  material_id INTEGER NOT NULL REFERENCES materials(id),
  note TEXT NOT NULL DEFAULT '',
  UNIQUE(process_id, material_id)
);
CREATE TABLE IF NOT EXISTS exhibits(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  statement TEXT NOT NULL DEFAULT '',              -- 展品陈述
  kiln_site_id INTEGER REFERENCES kiln_sites(id),
  glaze_id INTEGER REFERENCES glazes(id),
  vessel_form_id INTEGER REFERENCES vessel_forms(id),
  era_start INTEGER,                               -- 年代区间（公元年，负数为公元前）
  era_end INTEGER,
  era_uncertainty INTEGER NOT NULL DEFAULT 0,      -- 不确定度 ±年
  is_loan INTEGER NOT NULL DEFAULT 0,              -- 借展
  lender_name TEXT NOT NULL DEFAULT '',
  loan_note TEXT NOT NULL DEFAULT '',
  provenance_dispute TEXT NOT NULL DEFAULT '',     -- 来源争议
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS exhibit_processes(      -- 展品关联的工序
  exhibit_id INTEGER NOT NULL REFERENCES exhibits(id),
  process_id INTEGER NOT NULL REFERENCES process_cards(id),
  PRIMARY KEY(exhibit_id, process_id)
);
CREATE TABLE IF NOT EXISTS exhibit_process_overrides( -- 展品特定说明（局部例外）
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  exhibit_id INTEGER NOT NULL REFERENCES exhibits(id),
  process_id INTEGER NOT NULL REFERENCES process_cards(id),
  body TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  UNIQUE(exhibit_id, process_id)
);
CREATE TABLE IF NOT EXISTS media_assets(           -- 高分辨率图 / 打印说明，绑定许可版本
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  exhibit_id INTEGER NOT NULL REFERENCES exhibits(id),
  kind TEXT NOT NULL CHECK(kind IN('hires_image','print_note')),
  title TEXT NOT NULL DEFAULT '',
  file_path TEXT NOT NULL DEFAULT '',
  license_name TEXT NOT NULL DEFAULT '',
  license_version TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS entity_versions(        -- 全量历史快照
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  version INTEGER NOT NULL,
  data_json TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE(entity_type, entity_id, version)
);
CREATE TABLE IF NOT EXISTS approvals(              -- 每个实体最新批准版本
  entity_type TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  version INTEGER NOT NULL,
  approved_by TEXT NOT NULL DEFAULT '',
  approved_at TEXT NOT NULL,
  PRIMARY KEY(entity_type, entity_id)
);
CREATE TABLE IF NOT EXISTS review_tasks(           -- 材料变更沿引用图产生的待复核文章
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK(kind IN('material_updated','material_deleted')),
  material_id INTEGER NOT NULL,
  entity_type TEXT NOT NULL,                       -- process_card / exhibit
  entity_id INTEGER NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN('pending','resolved')),
  created_at TEXT NOT NULL, resolved_at TEXT
);
CREATE TABLE IF NOT EXISTS workshop_sessions(      -- 工坊场次
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  starts_at TEXT NOT NULL DEFAULT '',
  ends_at TEXT NOT NULL DEFAULT '',
  capacity INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reservations(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES workshop_sessions(id),
  visitor_name TEXT NOT NULL,
  contact TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN('confirmed','waitlisted','cancelled')),
  waitlist_position INTEGER,
  created_at TEXT NOT NULL,
  confirmed_at TEXT, cancelled_at TEXT, promoted_at TEXT
);
CREATE TABLE IF NOT EXISTS reservation_events(     -- 候补/取消/递补 明确时序
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reservation_id INTEGER NOT NULL REFERENCES reservations(id),
  event TEXT NOT NULL,
  at TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS receipts(               -- 预约确认回执（可补发）
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reservation_id INTEGER NOT NULL REFERENCES reservations(id),
  code TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN('active','superseded','void')),
  issued_at TEXT NOT NULL,
  reissue_of INTEGER REFERENCES receipts(id)
);
CREATE TABLE IF NOT EXISTS redirects(              -- 旧深链接 → 新地址
  old_path TEXT PRIMARY KEY,
  new_path TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS publish_runs(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL CHECK(status IN('building','success','failed')),
  build_dir TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT ''
);
"""

# 实体类型 → 表名（用于版本快照 / 审批 / 发布的通用处理）
ENTITY_TABLES = {
    'kiln_site': 'kiln_sites',
    'glaze': 'glazes',
    'vessel_form': 'vessel_forms',
    'process_card': 'process_cards',
    'material': 'materials',
    'exhibit': 'exhibits',
    'media': 'media_assets',
    'session': 'workshop_sessions',
}


def utcnow():
    return datetime.now(timezone.utc).isoformat(timespec='microseconds')


class DB:
    """单连接 + 可重入锁：所有读写经 tx/q 串行化，事务即临界区。"""

    def __init__(self, path=':memory:'):
        self.path = path
        self.conn = sqlite3.connect(path, timeout=30, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute('PRAGMA foreign_keys=ON')
        if path != ':memory:':
            self.conn.execute('PRAGMA journal_mode=WAL')
        self._lock = threading.RLock()
        with self._lock:
            self.conn.executescript(SCHEMA)

    @contextmanager
    def tx(self):
        """写事务：BEGIN IMMEDIATE，提交前持写锁，异常回滚。"""
        with self._lock:
            self.conn.execute('BEGIN IMMEDIATE')
            try:
                yield self.conn
                self.conn.commit()
            except Exception:
                self.conn.rollback()
                raise

    def q(self, sql, args=()):
        with self._lock:
            return self.conn.execute(sql, args).fetchall()

    def one(self, sql, args=()):
        rows = self.q(sql, args)
        return rows[0] if rows else None

    def close(self):
        with self._lock:
            self.conn.close()


def snapshot(conn, entity_type, entity_id, version, data, note=''):
    """把某版本的完整数据存入历史快照（历史记载永不改写）。"""
    conn.execute(
        'INSERT INTO entity_versions(entity_type,entity_id,version,data_json,note,created_at)'
        ' VALUES(?,?,?,?,?,?)',
        (entity_type, entity_id, version, json.dumps(data, ensure_ascii=False), note, utcnow()))


def row_dict(row):
    return {k: row[k] for k in row.keys()} if row is not None else None
