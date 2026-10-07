'use strict';
// HTTP 服务：后台管理 API + 工坊预约（动态）+ 静态公开站（/site/ 当前发布，/releases/<slug>/ 历史快照）
const http = require('http');
const fs = require('fs');
const path = require('path');
const { openDb } = require('./db');
const chronology = require('./chronology');
const inheritance = require('./inheritance');
const materials = require('./materials');
const booking = require('./booking');
const { publish } = require('./publish');
const { adminPage } = require('./admin');
const { workshopPage } = require('./bookingPage');

const MIME = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8', '.pdf': 'application/pdf' };

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { reject(Object.assign(new Error('JSON 解析失败'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function serveDir(res, root, rel) {
  const p = path.normalize(path.join(root, rel));
  if (!p.startsWith(path.normalize(root))) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(p, (err, buf) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('未找到（该发布快照不存在或已清理）'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream' });
    res.end(buf);
  });
}

function createApp({ dbPath = path.join(__dirname, '..', 'var', 'kiln.db'),
                     siteDir = path.join(__dirname, '..', 'var', 'site') } = {}) {
  const db = openDb(dbPath);

  const routes = [];
  const route = (method, pattern, handler) => {
    const keys = [];
    const rx = new RegExp('^' + pattern.replace(/:([a-z_]+)/gi, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, rx, keys, handler });
  };
  const J = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
  const H = (res, code, html) => { res.writeHead(code, { 'content-type': 'text/html; charset=utf-8' }); res.end(html); };

  // ---------- 基础资料 ----------
  route('GET', '/api/kilns', (q, r) => J(r, 200, db.prepare('SELECT * FROM kiln_sites').all()));
  route('POST', '/api/kilns', async (q, r, req) => {
    const b = await readBody(req);
    const id = db.prepare('INSERT INTO kiln_sites (name, location_text, lat, lng, coords_public, period_start, period_end, description) VALUES (?,?,?,?,?,?,?,?)')
      .run(b.name, b.location_text || '', b.lat ?? null, b.lng ?? null, b.coords_public ? 1 : 0, b.period_start ?? null, b.period_end ?? null, b.description || '').lastInsertRowid;
    J(r, 201, db.prepare('SELECT * FROM kiln_sites WHERE id=?').get(id));
  });
  for (const [table, api] of [['glazes', 'glazes'], ['forms', 'forms']]) {
    route('GET', `/api/${api}`, (q, r) => J(r, 200, db.prepare(`SELECT * FROM ${table}`).all()));
    route('POST', `/api/${api}`, async (q, r, req) => {
      const b = await readBody(req);
      const id = db.prepare(`INSERT INTO ${table} (name, description) VALUES (?,?)`).run(b.name, b.description || '').lastInsertRowid;
      J(r, 201, db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id));
    });
  }
  route('GET', '/api/processes', (q, r) => J(r, 200, db.prepare('SELECT * FROM processes').all()));
  route('POST', '/api/processes', async (q, r, req) => {
    const b = await readBody(req);
    const id = db.prepare('INSERT INTO processes (name, summary, card_body) VALUES (?,?,?)').run(b.name, b.summary || '', b.card_body || '').lastInsertRowid;
    J(r, 201, db.prepare('SELECT * FROM processes WHERE id=?').get(id));
  });
  // 更新通用工艺卡：不影响展品局部例外
  route('POST', '/api/processes/:id/card', async (q, r, req) => {
    const b = await readBody(req);
    const row = inheritance.updateGenericCard(db, Number(q.id), b);
    if (!row) return J(r, 404, { error: '工序不存在' });
    J(r, 200, row);
  });
  route('POST', '/api/processes/:id/materials', async (q, r, req) => {
    const b = await readBody(req);
    db.prepare('INSERT OR IGNORE INTO process_materials (process_id, material_id) VALUES (?,?)').run(Number(q.id), b.material_id);
    J(r, 201, { ok: true });
  });

  // ---------- 材料卡（版本化） ----------
  route('GET', '/api/materials', (q, r) => J(r, 200, db.prepare('SELECT * FROM materials').all().map((m) => ({
    ...m, current_version: materials.currentVersion(db, m.id),
  }))));
  route('POST', '/api/materials', async (q, r, req) => {
    const b = await readBody(req);
    J(r, 201, { id: materials.createMaterial(db, b.name, b.body || '', b.note || '') });
  });
  route('GET', '/api/materials/:id/versions', (q, r) =>
    J(r, 200, db.prepare('SELECT * FROM material_versions WHERE material_id=? ORDER BY version').all(Number(q.id))));
  route('POST', '/api/materials/:id/versions', async (q, r, req) => {
    const b = await readBody(req);
    J(r, 201, materials.addMaterialVersion(db, Number(q.id), b.body || '', b.note || ''));
  });
  route('DELETE', '/api/materials/:id', (q, r) => J(r, 200, { pending: materials.deleteMaterial(db, Number(q.id)) }));
  route('GET', '/api/review/pending', (q, r) => J(r, 200, materials.pendingReviewArticles(db)));
  route('POST', '/api/citations/:id/resolve', async (q, r, req) => {
    const b = await readBody(req);
    J(r, 200, materials.resolveCitation(db, Number(q.id), b.version ?? null));
  });

  // ---------- 展品 / 争议 / 工序关联 ----------
  route('GET', '/api/exhibits', (q, r) => J(r, 200, db.prepare('SELECT * FROM exhibits ORDER BY id').all()));
  route('POST', '/api/exhibits', async (q, r, req) => {
    const b = await readBody(req);
    const id = db.prepare(`INSERT INTO exhibits (title, kiln_site_id, glaze_id, form_id, statement,
      date_start, date_end, uncertainty_years, era_note, on_loan, lender, loan_note, loan_allows_hires)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(b.title, b.kiln_site_id ?? null, b.glaze_id ?? null, b.form_id ?? null, b.statement || '',
        b.date_start ?? null, b.date_end ?? null, b.uncertainty_years ?? 0, b.era_note || '',
        b.on_loan ? 1 : 0, b.lender || '', b.loan_note || '', b.loan_allows_hires ? 1 : 0).lastInsertRowid;
    J(r, 201, db.prepare('SELECT * FROM exhibits WHERE id=?').get(id));
  });
  route('POST', '/api/exhibits/:id/approve', (q, r) => {
    db.prepare("UPDATE exhibits SET approval='approved' WHERE id=?").run(Number(q.id));
    J(r, 200, { ok: true });
  });
  route('POST', '/api/exhibits/:id/disputes', async (q, r, req) => {
    const b = await readBody(req);
    const id = db.prepare('INSERT INTO provenance_disputes (exhibit_id, claim, counter_claim, source, approval) VALUES (?,?,?,?,?)')
      .run(Number(q.id), b.claim || '', b.counter_claim || '', b.source || '', b.approve ? 'approved' : 'draft').lastInsertRowid;
    J(r, 201, db.prepare('SELECT * FROM provenance_disputes WHERE id=?').get(id));
  });
  route('POST', '/api/exhibits/:id/processes', async (q, r, req) => {
    const b = await readBody(req);
    db.prepare(`INSERT INTO exhibit_processes (exhibit_id, process_id, use_local, local_note) VALUES (?,?,?,?)
      ON CONFLICT (exhibit_id, process_id) DO UPDATE SET use_local=excluded.use_local, local_note=excluded.local_note`)
      .run(Number(q.id), b.process_id, b.use_local ? 1 : 0, b.local_note || '');
    J(r, 201, { ok: true });
  });
  // 继承视图：通用卡 vs 展品特定说明
  route('GET', '/api/exhibits/:id/process-cards', (q, r) =>
    J(r, 200, inheritance.effectiveProcessCards(db, Number(q.id))));
  // 年代比较：区间相交不表示同代确证
  route('GET', '/api/exhibits/:id/chronology', (q, r, req, url) => {
    const a = db.prepare('SELECT * FROM exhibits WHERE id=?').get(Number(q.id));
    if (!a) return J(r, 404, { error: '展品不存在' });
    const withId = Number(url.searchParams.get('with'));
    const b = db.prepare('SELECT * FROM exhibits WHERE id=?').get(withId);
    if (!b) return J(r, 400, { error: '请用 ?with=<id> 指定比较对象' });
    J(r, 200, chronology.compareChronology(a, b));
  });

  // ---------- 文章 / 引用 ----------
  route('GET', '/api/articles', (q, r) => J(r, 200, db.prepare('SELECT * FROM articles').all()));
  route('POST', '/api/articles', async (q, r, req) => {
    const b = await readBody(req);
    const id = db.prepare('INSERT INTO articles (title, body) VALUES (?,?)').run(b.title, b.body || '').lastInsertRowid;
    J(r, 201, { id });
  });
  route('POST', '/api/articles/:id/approve', (q, r) => {
    db.prepare("UPDATE articles SET approval='approved' WHERE id=?").run(Number(q.id));
    J(r, 200, { ok: true });
  });
  route('POST', '/api/articles/:id/citations', async (q, r, req) => {
    const b = await readBody(req);
    const id = db.prepare('INSERT INTO article_citations (article_id, target_type, target_id, version) VALUES (?,?,?,?)')
      .run(Number(q.id), b.target_type, b.target_id, b.version ?? null).lastInsertRowid;
    J(r, 201, { id });
  });

  // ---------- 许可与媒体 ----------
  route('POST', '/api/licenses', async (q, r, req) => {
    const b = await readBody(req);
    const id = db.prepare('INSERT INTO licenses (code, version, text) VALUES (?,?,?)').run(b.code, b.version, b.text || '').lastInsertRowid;
    J(r, 201, { id });
  });
  route('POST', '/api/media', async (q, r, req) => {
    const b = await readBody(req);
    const id = db.prepare('INSERT INTO media (exhibit_id, kind, path, license_id) VALUES (?,?,?,?)')
      .run(b.exhibit_id, b.kind, b.path, b.license_id).lastInsertRowid;
    J(r, 201, { id });
  });
  route('POST', '/api/media/:id/approve', (q, r) => {
    db.prepare("UPDATE media SET approval='approved' WHERE id=?").run(Number(q.id));
    J(r, 200, { ok: true });
  });

  // ---------- 工坊预约（无电商结算） ----------
  route('GET', '/api/workshops', (q, r) => J(r, 200,
    db.prepare('SELECT * FROM workshops ORDER BY starts_at').all().map((w) => ({
      ...w, ...booking.workshopCounts(db, w.id),
    }))));
  route('POST', '/api/workshops', async (q, r, req) => {
    const b = await readBody(req);
    const id = db.prepare('INSERT INTO workshops (title, starts_at, capacity) VALUES (?,?,?)')
      .run(b.title, b.starts_at, b.capacity).lastInsertRowid;
    J(r, 201, { id });
  });
  route('GET', '/api/workshops/:id', (q, r) => {
    const w = db.prepare('SELECT * FROM workshops WHERE id=?').get(Number(q.id));
    if (!w) return J(r, 404, { error: '场次不存在' });
    J(r, 200, { ...w, ...booking.workshopCounts(db, w.id) });
  });
  route('POST', '/api/workshops/:id/book', async (q, r, req) => {
    const b = await readBody(req);
    J(r, 201, booking.book(db, Number(q.id), b.name, b.contact));
  });
  route('GET', '/api/bookings/:receipt', (q, r) => {
    const b = booking.getByReceipt(db, q.receipt);
    if (!b) return J(r, 404, { error: '回执无效或预约不存在' });
    J(r, 200, b);
  });
  route('POST', '/api/bookings/:receipt/cancel', (q, r) => J(r, 200, booking.cancel(db, q.receipt)));
  // 回执丢失：凭联系方式找回
  route('POST', '/api/bookings/lookup', async (q, r, req) => {
    const b = await readBody(req);
    if (!b.contact) return J(r, 400, { error: '请提供联系方式' });
    J(r, 200, booking.lookupByContact(db, b.contact, b.workshop_id ?? null));
  });
  route('GET', '/api/workshops/:id/events', (q, r) => J(r, 200, booking.eventLog(db, Number(q.id))));

  // ---------- 发布 ----------
  route('POST', '/api/publish', async (q, r, req) => {
    const b = await readBody(req);
    J(r, 201, publish(db, siteDir, { forceFail: !!b.force_fail }));
  });
  route('GET', '/api/releases', (q, r) =>
    J(r, 200, db.prepare('SELECT * FROM publish_releases ORDER BY id DESC').all()));

  // ---------- 页面 ----------
  route('GET', '/', (q, r) => H(r, 200, adminPage()));
  route('GET', '/workshops', (q, r) => H(r, 200, workshopPage()));

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      const p = url.pathname.replace(/\/+$/, '') || '/';
      if (req.method === 'GET' && p.startsWith('/releases/')) {
        return serveDir(res, path.join(siteDir, 'releases'), p.slice('/releases/'.length));
      }
      if (req.method === 'GET' && (p === '/site' || p.startsWith('/site/'))) {
        return serveDir(res, path.join(siteDir, 'current'), p.slice(5).replace(/^\//, '') || 'index.html');
      }
      for (const rt of routes) {
        if (rt.method !== req.method) continue;
        const m = rt.rx.exec(p);
        if (!m) continue;
        const params = {};
        rt.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
        return await rt.handler(params, res, req, url);
      }
      J(res, 404, { error: 'not found' });
    } catch (err) {
      J(res, err.status || 500, { error: String(err.message || err) });
    }
  });
  server.db = db;
  server.siteDir = siteDir;
  return server;
}

if (require.main === module) {
  const port = Number(process.env.PORT || 8080);
  const app = createApp();
  app.listen(port, () => console.log(`窑火资料站后台 http://localhost:${port} （预约页 /workshops ，公开站 /site/）`));
}

module.exports = { createApp };
