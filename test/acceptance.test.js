'use strict';
// 验收测试：借展 / 禁公开坐标 / 材料卡删除 / 最后名额竞争 / 回执丢失 /
// 年代区间不确定度 / 工艺卡继承 / 引用图待复核 / 原子发布与旧深链接来源链。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../src/server');

let server, base, tmpDir, siteDir;

test.before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-test-'));
  siteDir = path.join(tmpDir, 'site');
  server = createApp({ dbPath: ':memory:', siteDir });
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => new Promise((r) => server.close(r)));

const api = async (method, p, body) => {
  const r = await fetch(base + p, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null), text: async () => await r.text() };
};
const get = (p) => api('GET', p);
const post = (p, b) => api('POST', p, b);
const getText = async (p) => (await fetch(base + p)).text();

// ---------- 数据准备 ----------
let ids = {};
test('准备：窑址（禁公开坐标）/釉色/器型/工序/材料/展品/文章/许可/场次', async () => {
  ids.kiln = (await post('/api/kilns', { name: '湖田窑', location_text: '景德镇湖田村', lat: 29.2731, lng: 117.2384, coords_public: false })).body.id;
  ids.glaze = (await post('/api/glazes', { name: '影青' })).body.id;
  ids.form = (await post('/api/forms', { name: '梅瓶' })).body.id;
  ids.procThrow = (await post('/api/processes', { name: '拉坯', card_body: '通用卡v1：陶车拉坯。' })).body.id;
  ids.procGlaze = (await post('/api/processes', { name: '施釉', card_body: '通用卡：蘸釉一遍。' })).body.id;
  ids.material = (await post('/api/materials', { name: '草木灰釉料', body: 'v1：灰配瓷石。' })).body.id;
  await post(`/api/processes/${ids.procGlaze}/materials`, { material_id: ids.material });

  ids.exA = (await post('/api/exhibits', {
    title: '影青梅瓶', kiln_site_id: ids.kiln, glaze_id: ids.glaze, form_id: ids.form,
    statement: '青白釉梅瓶。', date_start: 1127, date_end: 1279, uncertainty_years: 30,
  })).body.id;
  ids.exB = (await post('/api/exhibits', {
    title: '青白瓷盏', date_start: 1200, date_end: 1300, uncertainty_years: 40, statement: '芒口盏。',
  })).body.id;
  ids.exC = (await post('/api/exhibits', {
    title: '明代青花罐', date_start: 1400, date_end: 1500, uncertainty_years: 10, statement: '青花。',
  })).body.id;
  ids.exLoan = (await post('/api/exhibits', {
    title: '借展瓷枕', date_start: 1100, date_end: 1200, uncertainty_years: 20,
    on_loan: true, lender: '某私人收藏', loan_note: '借展期内高清图不公开', statement: '借展品。',
  })).body.id;

  await post(`/api/exhibits/${ids.exA}/processes`, { process_id: ids.procThrow });
  await post(`/api/exhibits/${ids.exA}/processes`, { process_id: ids.procGlaze, use_local: true, local_note: '本展品特定说明：器内荡釉两遍。' });
  await post(`/api/exhibits/${ids.exB}/processes`, { process_id: ids.procGlaze });
  await post(`/api/exhibits/${ids.exA}/disputes`, { claim: '著录称湖田窑。', counter_claim: '成分有偏差。', source: '《窑口丛考》', approve: true });

  ids.license = (await post('/api/licenses', { code: 'CC-BY', version: '4.0' })).body.id;
  ids.mediaA = (await post('/api/media', { exhibit_id: ids.exA, kind: 'image_hires', path: '/media/a.tif', license_id: ids.license })).body.id;
  ids.mediaPrint = (await post('/api/media', { exhibit_id: ids.exA, kind: 'print', path: '/media/a-print.pdf', license_id: ids.license })).body.id;
  ids.mediaLoan = (await post('/api/media', { exhibit_id: ids.exLoan, kind: 'image_hires', path: '/media/loan.tif', license_id: ids.license })).body.id;

  ids.article = (await post('/api/articles', { title: '釉料小考', body: '正文引用草木灰釉料 v1。' })).body.id;
  await post(`/api/articles/${ids.article}/citations`, { target_type: 'material', target_id: ids.material, version: 1 });

  ids.wsRace = (await post('/api/workshops', { title: '最后名额场', starts_at: '2026-11-01 10:00', capacity: 1 })).body.id;
  ids.wsFifo = (await post('/api/workshops', { title: '候补顺序场', starts_at: '2026-11-02 10:00', capacity: 1 })).body.id;
  assert.ok(ids.exA && ids.wsRace);
});

// ---------- 1. 年代区间 + 不确定度 ----------
test('年代：区间相交不表示同代确证；不相交则如实报告', async () => {
  const r1 = (await get(`/api/exhibits/${ids.exA}/chronology?with=${ids.exB}`)).body;
  assert.equal(r1.overlap, true);               // 1127-1279±30 与 1200-1300±40 相交
  assert.equal(r1.same_era_confirmed, false);   // 但不得确证同代
  assert.match(r1.explanation, /不表示同代确证/);
  const r2 = (await get(`/api/exhibits/${ids.exA}/chronology?with=${ids.exC}`)).body;
  assert.equal(r2.overlap, false);
  assert.equal(r2.same_era_confirmed, false);
});

// ---------- 2. 工艺卡继承 ----------
test('继承：通用卡更新不覆盖展品特定说明，无局部例外者继承新通用卡', async () => {
  let cards = (await get(`/api/exhibits/${ids.exA}/process-cards`)).body;
  const glazeCard = cards.find((c) => c.process_id === ids.procGlaze);
  assert.equal(glazeCard.source, 'exhibit');
  assert.match(glazeCard.effective_body, /荡釉两遍/);

  await post(`/api/processes/${ids.procGlaze}/card`, { card_body: '通用卡v2：蘸釉与喷釉并用。' });

  cards = (await get(`/api/exhibits/${ids.exA}/process-cards`)).body;
  const local = cards.find((c) => c.process_id === ids.procGlaze);
  assert.equal(local.source, 'exhibit');
  assert.match(local.effective_body, /荡釉两遍/);       // 局部例外保留
  assert.match(local.generic.card_body, /v2/);          // 通用卡已更新但未被采用

  const cardsB = (await get(`/api/exhibits/${ids.exB}/process-cards`)).body;
  const inh = cardsB.find((c) => c.process_id === ids.procGlaze);
  assert.equal(inh.source, 'generic');
  assert.match(inh.effective_body, /v2/);               // 无局部例外 → 继承新通用卡
});

// ---------- 3. 材料更新 → 引用图待复核，历史不改 ----------
test('材料卡：追加版本后引用旧版的文章列入待复核，文章正文与所引版本不被自动改写', async () => {
  const r = (await post(`/api/materials/${ids.material}/versions`, { body: 'v2：灰配瓷石加草木灰二次淘洗。' })).body;
  assert.equal(r.version, 2);
  assert.deepEqual(r.pending.map((p) => p.article_id), [ids.article]);

  const pending = (await get('/api/review/pending')).body;
  assert.equal(pending.length, 1);
  assert.equal(pending[0].cited_version, 1);            // 仍引用 v1
  assert.equal(pending[0].latest_version, 2);

  const art = (await get('/api/articles')).body.find((a) => a.id === ids.article);
  assert.match(art.body, /v1/);                          // 正文未被自动改写

  const v1 = (await get(`/api/materials/${ids.material}/versions`)).body.find((v) => v.version === 1);
  assert.match(v1.body, /灰配瓷石/);                     // 历史版本原样保留

  await post(`/api/citations/${pending[0].citation_id}/resolve`, { version: 2 }); // 人工复核
  assert.equal((await get('/api/review/pending')).body.length, 0);
});

// ---------- 4. 材料卡被删除 ----------
test('材料卡删除：软删除，历史版本仍可查，引用文章重新进入待复核', async () => {
  const r = await api('DELETE', `/api/materials/${ids.material}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.pending.length, 1);                // 引用文章再次待复核
  const versions = (await get(`/api/materials/${ids.material}/versions`)).body;
  assert.equal(versions.length, 2);                      // 历史版本保留
  const again = await api('DELETE', `/api/materials/${ids.material}`);
  assert.equal(again.status, 404);
});

// ---------- 5. 发布：仅批准记录、坐标脱敏、借展媒体、许可绑定 ----------
let release1;
test('发布v1：仅含批准记录；禁公开坐标不出现；借展高清图不公开；媒体绑定许可版本', async () => {
  await post(`/api/exhibits/${ids.exA}/approve`, {});
  await post(`/api/exhibits/${ids.exB}/approve`, {});
  await post(`/api/exhibits/${ids.exLoan}/approve`, {});
  await post(`/api/media/${ids.mediaA}/approve`, {});
  await post(`/api/media/${ids.mediaPrint}/approve`, {});
  await post(`/api/media/${ids.mediaLoan}/approve`, {});
  await post(`/api/articles/${ids.article}/approve`, {});
  // 未批准的展品不应进入公开站
  const draft = (await post('/api/exhibits', { title: '未批准草稿瓶', statement: '草稿。' })).body.id;
  ids.draft = draft;

  const pub = (await post('/api/publish', {})).body;
  release1 = pub.slug;
  assert.ok(release1);

  const html = await getText('/site/index.html');
  assert.match(html, /影青梅瓶/);
  assert.doesNotMatch(html, /未批准草稿瓶/);

  const kilns = await getText('/site/kilns.html');
  assert.match(kilns, /湖田窑/);
  assert.doesNotMatch(kilns, /29\.2731|117\.2384/);      // 坐标禁止公开
  assert.match(kilns, /不公开/);

  const exA = await getText(`/site/exhibits/${ids.exA}.html`);
  assert.match(exA, /±30 年/);                           // 不确定度展示
  assert.match(exA, /来源争议/);
  assert.match(exA, /本展品特定说明/);
  assert.match(exA, /CC-BY 4\.0/);                       // 高清图与打印说明绑定许可版本
  assert.match(exA, /来源链/);

  const loan = await getText(`/site/exhibits/${ids.exLoan}.html`);
  assert.match(loan, /借展/);
  assert.match(loan, /某私人收藏/);
  assert.doesNotMatch(loan, /loan\.tif/);                // 借展协议不允许 → 高清图不公开
  assert.match(loan, /依出借协议不公开/);

  // 材料卡已删除：公开站显示撤回存档而非消失
  const mat = await getText(`/site/materials/${ids.material}.html`);
  assert.match(mat, /已撤回/);
  assert.match(mat, /v1/);
});

// ---------- 6. 发布失败不混入半版内容 ----------
test('发布失败：current 保持不变，不产生半成品 release', async () => {
  const before = await getText('/site/index.html');
  const r = await post('/api/publish', { force_fail: true });
  assert.equal(r.status, 500);
  const after = await getText('/site/index.html');
  assert.equal(after, before);                           // 当前版本未被污染
  const releases = (await get('/api/releases')).body;
  assert.ok(releases.some((x) => x.status === 'failed'));
  const dirs = fs.readdirSync(path.join(siteDir, 'releases')).filter((d) => !d.startsWith('.'));
  assert.equal(dirs.length, 1);                          // 只有 v1，无半成品目录
});

// ---------- 7. 旧深链接保留可公开的来源链 ----------
test('旧深链接：材料更新+再发布后，旧 release 快照仍可访问且来源链完整', async () => {
  // 材料卡已删状态下再发一版
  const pub2 = (await post('/api/publish', {})).body;
  assert.ok(pub2.slug && pub2.slug !== release1);
  const oldPage = await getText(`/releases/${release1}/exhibits/${ids.exA}.html`);
  assert.match(oldPage, /影青梅瓶/);
  assert.match(oldPage, /来源链/);
  assert.match(oldPage, /草木灰釉料/);                   // 旧快照保留当时来源链
  const newPage = await getText(`/site/exhibits/${ids.exA}.html`);
  assert.match(newPage, /其后已撤回/);                   // 新版标注材料已撤回
});

// ---------- 8. 最后名额竞争（服务端原子占用） ----------
test('最后名额竞争：并发 10 人抢 1 个名额，恰好 1 人确认、9 人候补且位次唯一', async () => {
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) =>
    post(`/api/workshops/${ids.wsRace}/book`, { name: `客${i}`, contact: `1390000${String(i).padStart(4, '0')}` })));
  const confirmed = results.filter((r) => r.body.status === 'confirmed');
  const waiting = results.filter((r) => r.body.status === 'waitlist');
  assert.equal(confirmed.length, 1);
  assert.equal(waiting.length, 9);
  const positions = waiting.map((r) => r.body.waitlist_pos).sort((a, b) => a - b);
  assert.deepEqual(positions, [1, 2, 3, 4, 5, 6, 7, 8, 9]); // 候补位次连续无重复
  // 页面计数来自服务端
  const ws = (await get(`/api/workshops/${ids.wsRace}`)).body;
  assert.deepEqual({ confirmed: ws.confirmed, waiting: ws.waiting }, { confirmed: 1, waiting: 9 });
});

// ---------- 9. 取消释放与候补转正时序 ----------
test('取消释放名额：候补队首原子转正，事件时序完整可查', async () => {
  const b1 = (await post(`/api/workshops/${ids.wsFifo}/book`, { name: '甲', contact: '13700000001' })).body;
  const b2 = (await post(`/api/workshops/${ids.wsFifo}/book`, { name: '乙', contact: '13700000002' })).body;
  const b3 = (await post(`/api/workshops/${ids.wsFifo}/book`, { name: '丙', contact: '13700000003' })).body;
  assert.equal(b1.status, 'confirmed');
  assert.deepEqual([b2.waitlist_pos, b3.waitlist_pos], [1, 2]);

  const c = (await post(`/api/bookings/${b1.receipt_code}/cancel`)).body;
  assert.equal(c.promoted.receipt_code, b2.receipt_code); // 队首转正
  const b3after = (await get(`/api/bookings/${b3.receipt_code}`)).body;
  assert.equal(b3after.waitlist_pos, 1);                  // 位次前移

  const events = (await get(`/api/workshops/${ids.wsFifo}/events`)).body.map((e) => e.event);
  assert.deepEqual(events, ['created_confirmed', 'created_waitlist', 'created_waitlist', 'cancelled', 'promoted']);

  const again = (await post(`/api/bookings/${b1.receipt_code}/cancel`));
  assert.equal(again.status, 409);                        // 重复取消被拒绝
});

// ---------- 10. 回执丢失找回 + 服务端真实确认 ----------
test('回执丢失：凭联系方式找回回执，凭回执查到服务端真实状态', async () => {
  const b = (await post(`/api/workshops/${ids.wsFifo}/book`, { name: '丁', contact: '13600000999' })).body;
  assert.equal(b.status, 'waitlist');
  const lost = b.receipt_code;                            // 模拟丢失：不再使用该变量查询
  assert.ok(lost);
  const found = (await post('/api/bookings/lookup', { contact: '13600000999' })).body;
  assert.equal(found.length, 1);
  const receipt = found[0].receipt_code;
  const s = (await get(`/api/bookings/${receipt}`)).body; // 用找回的回执查真实状态
  assert.equal(s.status, 'waitlist');
  assert.equal(s.workshop_title, '候补顺序场');
  assert.equal(typeof s.counts.confirmed, 'number');      // 计数来自服务端
  const bad = await get('/api/bookings/不存在的回执');
  assert.equal(bad.status, 404);
});

// ---------- 11. 预约不做电商结算 ----------
test('预约接口不含任何价格/支付字段（无电商结算）', async () => {
  const ws = (await get(`/api/workshops/${ids.wsRace}`)).body;
  for (const k of Object.keys(ws)) assert.doesNotMatch(k, /price|pay|order|amount|checkout/i);
});
