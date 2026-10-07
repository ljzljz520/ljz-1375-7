'use strict';
// 公开静态站 HTML 渲染。所有输出转义；坐标脱敏在数据收集阶段完成。
const { formatRange } = require('./chronology');

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function layout(title, body) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · 窑火资料站</title>
<style>
body{font-family:system-ui,"Noto Serif SC",serif;max-width:56rem;margin:0 auto;padding:1.5rem;line-height:1.7;color:#2b2320}
a{color:#8a3b12}nav a{margin-right:1rem}
.card{border:1px solid #d8cfc4;border-radius:8px;padding:1rem;margin:.8rem 0}
.tag{display:inline-block;background:#f0e6da;border-radius:4px;padding:.1rem .5rem;margin:.15rem;font-size:.85rem}
.warn{background:#fdf3e3;border-left:4px solid #c8842a;padding:.5rem .8rem}
.tomb{background:#f6eeee;border-left:4px solid #a33;padding:.5rem .8rem}
.meta{color:#6f655c;font-size:.9rem}h1,h2{line-height:1.3}
footer{margin-top:3rem;color:#8a7f74;font-size:.85rem;border-top:1px solid #e2d9ce;padding-top:.8rem}
</style></head><body>
<nav><a href="INDEX">首页</a><a href="KILNS">窑址</a><a href="GLAZES">釉色</a><a href="FORMS">器型</a><a href="PROCESSES">工序</a><a href="ARTICLES">文章</a></nav>
${body}
<footer>本页由后台批准记录静态构建 · 内容以发布时点为准，历史版本见各发布快照。</footer>
</body></html>`.replace(/INDEX|KILNS|GLAZES|FORMS|PROCESSES|ARTICLES/g, (m) => ({
    INDEX: 'index.html', KILNS: 'kilns.html', GLAZES: 'glazes.html',
    FORMS: 'forms.html', PROCESSES: 'processes.html', ARTICLES: 'articles.html',
  }[m]));
}

// 展品详情：陈述、年代（区间+不确定度）、关联窑址/釉色/器型/工序、来源争议、媒体（许可版本）、来源链
function exhibitPage(e) {
  const rel = (p) => `../${p}`;
  const parts = [];
  parts.push(`<h1>${esc(e.title)}</h1>`);
  if (e.on_loan) {
    parts.push(`<div class="warn">借展展品 · 出借方：${esc(e.lender)}${e.loan_note ? ` · ${esc(e.loan_note)}` : ''}</div>`);
  }
  parts.push(`<p class="meta">年代：${esc(formatRange(e))}${e.era_note ? `（${esc(e.era_note)}）` : ''}</p>`);
  parts.push(`<div class="card"><h2>展品陈述</h2><p>${esc(e.statement)}</p></div>`);
  parts.push(`<p>${e.kiln ? `<a class="tag" href="${rel('kilns.html')}#k${e.kiln.id}">窑址 · ${esc(e.kiln.name)}</a>` : ''}
${e.glaze ? `<a class="tag" href="${rel('glazes.html')}#g${e.glaze.id}">釉色 · ${esc(e.glaze.name)}</a>` : ''}
${e.form ? `<a class="tag" href="${rel('forms.html')}#f${e.form.id}">器型 · ${esc(e.form.name)}</a>` : ''}</p>`);
  if (e.process_cards.length) {
    parts.push('<div class="card"><h2>工序</h2>');
    for (const pc of e.process_cards) {
      parts.push(`<h3><a href="${rel('processes.html')}#p${pc.process_id}">${esc(pc.name)}</a>
<span class="tag">${pc.source === 'exhibit' ? '本展品特定说明' : '通用工艺卡'}</span></h3>
<p>${esc(pc.effective_body)}</p>`);
    }
    parts.push('</div>');
  }
  if (e.disputes.length) {
    parts.push('<div class="card"><h2>来源争议</h2>');
    for (const d of e.disputes) {
      parts.push(`<p><strong>主张：</strong>${esc(d.claim)}<br><strong>异议：</strong>${esc(d.counter_claim)}
<br><span class="meta">来源：${esc(d.source)} · 状态：${d.status === 'open' ? '未决' : '已厘清'}</span></p>`);
    }
    parts.push('</div>');
  }
  if (e.media_note) parts.push(`<div class="warn">${esc(e.media_note)}</div>`);
  if (e.media.length) {
    parts.push('<div class="card"><h2>高清图与打印说明</h2><ul>');
    for (const m of e.media) {
      parts.push(`<li>${m.kind === 'image_hires' ? '高清图' : '打印说明'}：<a href="${esc(m.path)}">${esc(m.path)}</a>
 · 许可：${esc(m.license.code)} ${esc(m.license.version)}</li>`);
    }
    parts.push('</ul></div>');
  }
  // 来源链：陈述→争议→材料版本→许可版本，供深链接长期引用
  parts.push('<div class="card"><h2>来源链</h2><ul>');
  parts.push(`<li>展品陈述（发布时点存档）</li>`);
  for (const d of e.disputes) parts.push(`<li>来源争议记录 #${d.id}（${esc(d.source)}）</li>`);
  for (const mv of e.material_chain) {
    parts.push(`<li>材料卡 <a href="${rel(`materials/${mv.material_id}.html`)}">${esc(mv.name)}</a> v${mv.version}${mv.material_status === 'deleted' ? '（该材料卡其后已撤回，此为历史存档）' : ''}</li>`);
  }
  for (const m of e.media) parts.push(`<li>媒体许可 ${esc(m.license.code)} ${esc(m.license.version)}</li>`);
  parts.push('</ul></div>');
  return layout(e.title, parts.join('\n'));
}

function kilnIndex(kilns) {
  const items = kilns.map((k) => `<div class="card" id="k${k.id}"><h2>${esc(k.name)}</h2>
<p class="meta">${esc(k.location_text)}${k.coords_public ? '' : ' · 精确坐标依保护要求不公开'}</p>
<p>${esc(k.description)}</p></div>`);
  return layout('窑址', `<h1>窑址</h1>${items.join('\n')}`);
}

function simpleIndex(title, items, prefix, extra = () => '') {
  const body = items.map((it) => `<div class="card" id="${prefix}${it.id}"><h2>${esc(it.name)}</h2>
<p>${esc(it.description || it.summary || '')}</p>${extra(it)}</div>`);
  return layout(title, `<h1>${esc(title)}</h1>${body.join('\n')}`);
}

function processIndex(processes) {
  return simpleIndex('工序', processes, 'p', (p) => `
<p>${esc(p.card_body)}</p>
${p.materials.length ? `<p class="meta">用料：${p.materials.map((m) =>
    `<a href="materials/${m.id}.html">${esc(m.name)}</a>${m.status === 'deleted' ? '（已撤回）' : ''}`).join('、')}</p>` : ''}`);
}

function materialPage(m) {
  const parts = [`<h1>材料卡 · ${esc(m.name)}</h1>`];
  if (m.status === 'deleted') {
    parts.push('<div class="tomb">该材料卡已撤回。下列内容为历史版本存档，仅供溯源，不再维护。</div>');
  }
  for (const v of m.versions) {
    parts.push(`<div class="card"><h2>v${v.version} <span class="meta">${esc(v.created_at)}</span></h2>
<p>${esc(v.body)}</p>${v.note ? `<p class="meta">备注：${esc(v.note)}</p>` : ''}</div>`);
  }
  return layout(`材料卡 · ${m.name}`, parts.join('\n'));
}

function articlePage(a) {
  const cites = a.citations.map((c) => `<li>${esc(c.label)}${c.version ? ` v${c.version}` : ''}${c.archived ? '（历史存档）' : ''}</li>`).join('');
  return layout(a.title, `<h1>${esc(a.title)}</h1><p>${esc(a.body)}</p>
${cites ? `<div class="card"><h2>引用</h2><ul>${cites}</ul></div>` : ''}`);
}

function indexPage(exhibits) {
  const items = exhibits.map((e) => `<div class="card"><h2><a href="exhibits/${e.id}.html">${esc(e.title)}</a></h2>
<p class="meta">${esc(formatRange(e))}${e.on_loan ? ' · 借展' : ''}</p>
<p>${esc(e.statement.slice(0, 120))}</p></div>`);
  return layout('首页', `<h1>窑火资料站</h1><p>收录经后台批准的展品、窑址、釉色、器型与工序资料。</p>${items.join('\n')}`);
}

module.exports = { esc, layout, exhibitPage, kilnIndex, simpleIndex, processIndex, materialPage, articlePage, indexPage };
