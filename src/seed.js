'use strict';
// 演示数据：窑址（含禁公开坐标）、釉色、器型、工序、材料卡、展品（含借展）、文章引用、工坊场次。
const path = require('path');
const { openDb } = require('./db');
const mats = require('./materials');

const dbPath = process.env.KILN_DB || path.join(__dirname, '..', 'var', 'kiln.db');
const db = openDb(dbPath);

const tx = db.transaction(() => {
  const kiln = db.prepare(`INSERT INTO kiln_sites (name, location_text, lat, lng, coords_public, period_start, period_end, description)
    VALUES ('湖田窑', '江西景德镇竟成镇湖田村', 29.2731, 117.2384, 0, 960, 1368, '宋元影青瓷重要窑场。')`).run().lastInsertRowid;
  const glaze = db.prepare(`INSERT INTO glazes (name, description) VALUES ('影青', '青白釉，釉色青中泛白。')`).run().lastInsertRowid;
  const form = db.prepare(`INSERT INTO forms (name, description) VALUES ('梅瓶', '小口短颈丰肩，宋元典型器。')`).run().lastInsertRowid;
  const p1 = db.prepare(`INSERT INTO processes (name, summary, card_body) VALUES ('拉坯', '成型', '通用工艺卡：陶车拉坯成型，湿坯修足。')`).run().lastInsertRowid;
  const p2 = db.prepare(`INSERT INTO processes (name, summary, card_body) VALUES ('施釉', '上釉', '通用工艺卡：蘸釉与荡釉并用，釉层均匀。')`).run().lastInsertRowid;
  const m1 = mats.createMaterial(db, '草木灰釉料', 'v1：草木灰配瓷石，淘洗陈腐。', '初始记录');
  db.prepare('INSERT INTO process_materials (process_id, material_id) VALUES (?,?)').run(p2, m1);

  const e1 = db.prepare(`INSERT INTO exhibits (title, kiln_site_id, glaze_id, form_id, statement,
    date_start, date_end, uncertainty_years, era_note, approval)
    VALUES ('影青梅瓶', ?, ?, ?, '肩腹饱满，釉色青白。', 1127, 1279, 30, '南宋', 'approved')`)
    .run(kiln, glaze, form).lastInsertRowid;
  db.prepare('INSERT INTO exhibit_processes (exhibit_id, process_id, use_local, local_note) VALUES (?,?,0,?)').run(e1, p1, '');
  db.prepare('INSERT INTO exhibit_processes (exhibit_id, process_id, use_local, local_note) VALUES (?,?,1,?)')
    .run(e1, p2, '本展品特定说明：器内荡釉两遍，器底刮釉露胎。');
  db.prepare(`INSERT INTO provenance_disputes (exhibit_id, claim, counter_claim, source, approval)
    VALUES (?, '传世著录称出自湖田窑。', '胎釉成分与窑口标本存在偏差，或为他窑仿烧。', '《窑口丛考》卷三', 'approved')`).run(e1);

  const e2 = db.prepare(`INSERT INTO exhibits (title, kiln_site_id, glaze_id, form_id, statement,
    date_start, date_end, uncertainty_years, on_loan, lender, loan_note, approval)
    VALUES ('借展青白瓷盏', ?, ?, NULL, '芒口，圈足。', 1200, 1280, 40, 1, '某私人收藏', '借展期至 2027 年，高清图不公开。', 'approved')`)
    .run(kiln, glaze).lastInsertRowid;

  const lic = db.prepare(`INSERT INTO licenses (code, version, text) VALUES ('CC-BY', '4.0', '署名 4.0 国际')`).run().lastInsertRowid;
  db.prepare(`INSERT INTO media (exhibit_id, kind, path, license_id, approval) VALUES (?,?,?,?,'approved')`)
    .run(e1, 'image_hires', '/media/e1-hires.tif', lic);
  db.prepare(`INSERT INTO media (exhibit_id, kind, path, license_id, approval) VALUES (?,?,?,?,'approved')`)
    .run(e2, 'image_hires', '/media/e2-hires.tif', lic); // 借展：发布时不公开

  const art = db.prepare(`INSERT INTO articles (title, body, approval) VALUES ('湖田窑釉料小考', '……', 'approved')`).run().lastInsertRowid;
  db.prepare(`INSERT INTO article_citations (article_id, target_type, target_id, version) VALUES (?, 'material', ?, 1)`).run(art, m1);

  db.prepare(`INSERT INTO workshops (title, starts_at, capacity) VALUES ('拉坯体验（上午场）', '2026-10-20 10:00', 2)`).run();
  db.prepare(`INSERT INTO workshops (title, starts_at, capacity) VALUES ('釉下彩绘制', '2026-10-21 14:00', 1)`).run();
});
tx();
console.log('seeded ->', dbPath);
