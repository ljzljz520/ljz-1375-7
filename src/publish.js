'use strict';
// 静态公开站构建：仅使用后台“已批准”记录。
// 原子发布：先构建到临时目录 → 校验 → rename 成正式 release → 原子切换 current 软链。
// 任一步失败，current 保持不变，不混入半版内容；旧 release 目录保留，深链接可继续公开访问来源链。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const views = require('./views');
const { effectiveProcessCards } = require('./inheritance');

function collectApproved(db) {
  const kilns = db.prepare('SELECT * FROM kiln_sites ORDER BY id').all().map((k) => {
    const pub = { ...k };
    if (!k.coords_public) { delete pub.lat; delete pub.lng; } // 禁止公开坐标：构建期剔除
    return pub;
  });
  const glazes = db.prepare('SELECT * FROM glazes ORDER BY id').all();
  const forms = db.prepare('SELECT * FROM forms ORDER BY id').all();
  const processes = db.prepare('SELECT * FROM processes ORDER BY id').all().map((p) => ({
    ...p,
    materials: db.prepare(`
      SELECT m.id, m.name, m.status FROM process_materials pm
      JOIN materials m ON m.id = pm.material_id WHERE pm.process_id = ? ORDER BY m.id
    `).all(p.id),
  }));
  const licenses = db.prepare('SELECT * FROM licenses').all();
  const licById = new Map(licenses.map((l) => [l.id, l]));

  const exhibits = db.prepare("SELECT * FROM exhibits WHERE approval = 'approved' ORDER BY id").all()
    .map((e) => {
      const kiln = e.kiln_site_id ? kilns.find((k) => k.id === e.kiln_site_id) : null;
      const glaze = e.glaze_id ? glazes.find((g) => g.id === e.glaze_id) : null;
      const form = e.form_id ? forms.find((f) => f.id === e.form_id) : null;
      const disputes = db.prepare(
        "SELECT * FROM provenance_disputes WHERE exhibit_id = ? AND approval = 'approved' ORDER BY id"
      ).all(e.id);
      // 媒体：仅批准的；借展且协议不允许则不公开高清图/打印说明
      let media = db.prepare("SELECT * FROM media WHERE exhibit_id = ? AND approval = 'approved'").all(e.id);
      let media_note = '';
      if (e.on_loan && !e.loan_allows_hires && media.length) {
        media = [];
        media_note = '借展展品：高清图与打印说明依出借协议不公开。';
      }
      media = media.map((m) => ({ ...m, license: licById.get(m.license_id) || null }));
      const process_cards = effectiveProcessCards(db, e.id);
      // 来源链：展品关联工序所用材料的当前版本（含已撤回材料的历史存档标记）
      const material_chain = db.prepare(`
        SELECT DISTINCT m.id AS material_id, m.name, m.status AS material_status,
               (SELECT MAX(version) FROM material_versions mv WHERE mv.material_id = m.id) AS version
        FROM exhibit_processes ep
        JOIN process_materials pm ON pm.process_id = ep.process_id
        JOIN materials m ON m.id = pm.material_id
        WHERE ep.exhibit_id = ? ORDER BY m.id
      `).all(e.id);
      return { ...e, kiln, glaze, form, disputes, media, media_note, process_cards, material_chain };
    });

  const materials = db.prepare('SELECT * FROM materials ORDER BY id').all().map((m) => ({
    ...m,
    versions: db.prepare('SELECT * FROM material_versions WHERE material_id = ? ORDER BY version').all(m.id),
  }));

  const articles = db.prepare("SELECT * FROM articles WHERE approval = 'approved' ORDER BY id").all()
    .map((a) => ({
      ...a,
      citations: db.prepare(`
        SELECT ac.*, m.name AS material_name, m.status AS material_status
        FROM article_citations ac LEFT JOIN materials m
          ON ac.target_type = 'material' AND m.id = ac.target_id
        WHERE ac.article_id = ? ORDER BY ac.id
      `).all(a.id).map((c) => ({
        version: c.version,
        archived: c.material_status === 'deleted',
        label: c.target_type === 'material'
          ? `材料卡 · ${c.material_name}`
          : `${c.target_type} #${c.target_id}`,
      })),
    }));

  return { kilns, glazes, forms, processes, exhibits, materials, articles };
}

// 构建前校验：任一批准记录缺许可绑定即失败，整个发布中止
function validate(data) {
  const problems = [];
  for (const e of data.exhibits) {
    for (const m of e.media) {
      if (!m.license) problems.push(`展品 #${e.id} 的媒体 #${m.id} 缺少许可版本绑定`);
    }
  }
  if (problems.length) {
    const err = new Error(`发布校验失败：${problems.join('；')}`);
    err.status = 409;
    throw err;
  }
}

function writeFile(dir, rel, content) {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

// 返回 { slug, dir }
function publish(db, siteDir, { forceFail = false } = {}) {
  const slug = `r${new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)}-${crypto.randomBytes(2).toString('hex')}`;
  const releasesDir = path.join(siteDir, 'releases');
  const tmpDir = path.join(releasesDir, `.tmp-${slug}`);
  const finalDir = path.join(releasesDir, slug);
  const currentLink = path.join(siteDir, 'current');
  fs.mkdirSync(releasesDir, { recursive: true });

  try {
    const data = collectApproved(db);
    validate(data); // 校验在写盘前
    writeFile(tmpDir, 'index.html', views.indexPage(data.exhibits));
    writeFile(tmpDir, 'kilns.html', views.kilnIndex(data.kilns));
    writeFile(tmpDir, 'glazes.html', views.simpleIndex('釉色', data.glazes, 'g'));
    writeFile(tmpDir, 'forms.html', views.simpleIndex('器型', data.forms, 'f'));
    writeFile(tmpDir, 'processes.html', views.processIndex(data.processes));
    for (const e of data.exhibits) writeFile(tmpDir, `exhibits/${e.id}.html`, views.exhibitPage(e));
    for (const m of data.materials) writeFile(tmpDir, `materials/${m.id}.html`, views.materialPage(m));
    for (const a of data.articles) writeFile(tmpDir, `articles/${a.id}.html`, views.articlePage(a));
    writeFile(tmpDir, 'articles.html', views.layout('文章',
      `<h1>文章</h1>${data.articles.map((a) => `<div class="card"><a href="articles/${a.id}.html">${views.esc(a.title)}</a></div>`).join('')}`));
    writeFile(tmpDir, 'manifest.json', JSON.stringify({
      slug, built_at: new Date().toISOString(),
      exhibits: data.exhibits.map((e) => e.id),
      articles: data.articles.map((a) => a.id),
      materials: data.materials.map((m) => ({ id: m.id, status: m.status })),
    }, null, 2));
    if (forceFail) { const e = new Error('模拟发布失败'); e.status = 500; throw e; }
    fs.renameSync(tmpDir, finalDir); // 同文件系统原子改名
    const tmpLink = path.join(siteDir, `.current-${process.pid}`);
    fs.symlinkSync(path.relative(siteDir, finalDir), tmpLink);
    fs.renameSync(tmpLink, currentLink); // 原子切换
    db.prepare("INSERT INTO publish_releases (slug, status) VALUES (?, 'ok')").run(slug);
    return { slug, dir: finalDir };
  } catch (err) {
    fs.rmSync(tmpDir, { recursive: true, force: true }); // 清理半成品，current 不动
    db.prepare("INSERT INTO publish_releases (slug, status, error) VALUES (?, 'failed', ?)")
      .run(slug, String(err.message || err));
    throw err;
  }
}

module.exports = { publish, collectApproved };
