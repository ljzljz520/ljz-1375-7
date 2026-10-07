'use strict';
// 材料卡：版本化。更新 = 追加新版本，历史版本永不改写；
// 更新后沿引用图把引用旧版本的文章标记为“待复核”，由人工显式复核，不自动改历史记载。

function currentVersion(db, materialId) {
  const row = db.prepare(
    'SELECT MAX(version) AS v FROM material_versions WHERE material_id = ?'
  ).get(materialId);
  return row.v || 0;
}

function getVersion(db, materialId, version) {
  return db.prepare(
    'SELECT * FROM material_versions WHERE material_id = ? AND version = ?'
  ).get(materialId, version);
}

function createMaterial(db, name, body, note = '') {
  const tx = db.transaction(() => {
    const id = db.prepare('INSERT INTO materials (name) VALUES (?)').run(name).lastInsertRowid;
    db.prepare('INSERT INTO material_versions (material_id, version, body, note) VALUES (?,?,?,?)')
      .run(id, 1, body, note);
    return id;
  });
  return tx();
}

// 追加新版本；返回新版本号与被标记待复核的文章列表
function addMaterialVersion(db, materialId, body, note = '') {
  const tx = db.transaction(() => {
    const m = db.prepare('SELECT * FROM materials WHERE id = ?').get(materialId);
    if (!m) { const e = new Error('材料卡不存在'); e.status = 404; throw e; }
    if (m.status === 'deleted') { const e = new Error('材料卡已删除，不能新增版本'); e.status = 409; throw e; }
    const v = currentVersion(db, materialId) + 1;
    db.prepare('INSERT INTO material_versions (material_id, version, body, note) VALUES (?,?,?,?)')
      .run(materialId, v, body, note);
    // 沿引用图：凡引用该材料旧版本的文章 → 待复核（只打标，不改文章正文与所引版本）
    db.prepare(`
      UPDATE article_citations SET review_status = 'needs_review'
      WHERE target_type = 'material' AND target_id = ? AND (version IS NULL OR version < ?)
    `).run(materialId, v);
    const pending = pendingReviewArticles(db).filter((a) => a.material_id === materialId);
    return { version: v, pending };
  });
  return tx();
}

// 删除 = 软删除。历史版本与引用保留；引用它的文章进入待复核。
function deleteMaterial(db, materialId) {
  const tx = db.transaction(() => {
    const r = db.prepare("UPDATE materials SET status = 'deleted' WHERE id = ? AND status = 'active'").run(materialId);
    if (r.changes === 0) { const e = new Error('材料卡不存在或已删除'); e.status = 404; throw e; }
    db.prepare(`
      UPDATE article_citations SET review_status = 'needs_review'
      WHERE target_type = 'material' AND target_id = ?
    `).run(materialId);
    return pendingReviewArticles(db).filter((a) => a.material_id === materialId);
  });
  return tx();
}

// 待复核文章列表（沿引用图）
function pendingReviewArticles(db) {
  return db.prepare(`
    SELECT ac.id AS citation_id, ac.review_status, ac.version AS cited_version,
           a.id AS article_id, a.title, a.approval,
           m.id AS material_id, m.name AS material_name, m.status AS material_status,
           (SELECT MAX(version) FROM material_versions mv WHERE mv.material_id = m.id) AS latest_version
    FROM article_citations ac
    JOIN articles a ON a.id = ac.article_id
    JOIN materials m ON m.id = ac.target_id
    WHERE ac.target_type = 'material' AND ac.review_status = 'needs_review'
    ORDER BY a.id
  `).all();
}

// 人工复核：显式把引用推进到指定版本并清除标记。这是编辑动作，不是自动改写。
function resolveCitation(db, citationId, newVersion) {
  const tx = db.transaction(() => {
    const c = db.prepare('SELECT * FROM article_citations WHERE id = ?').get(citationId);
    if (!c) { const e = new Error('引用不存在'); e.status = 404; throw e; }
    if (c.target_type === 'material' && newVersion != null) {
      const mv = getVersion(db, c.target_id, newVersion);
      if (!mv) { const e = new Error(`材料版本 v${newVersion} 不存在`); e.status = 400; throw e; }
    }
    db.prepare("UPDATE article_citations SET review_status = 'ok', version = COALESCE(?, version) WHERE id = ?")
      .run(newVersion ?? null, citationId);
    return db.prepare('SELECT * FROM article_citations WHERE id = ?').get(citationId);
  });
  return tx();
}

module.exports = {
  currentVersion, getVersion, createMaterial, addMaterialVersion,
  deleteMaterial, pendingReviewArticles, resolveCitation,
};
