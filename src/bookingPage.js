'use strict';
// 工坊预约页：名额与状态全部来自服务端；提交后凭回执向服务端查询真实确认，不做本地计数。
function workshopPage() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>工坊预约 · 窑火资料站</title>
<style>
body{font-family:system-ui,"Noto Serif SC",serif;max-width:44rem;margin:0 auto;padding:1.5rem;line-height:1.7;color:#2b2320}
.card{border:1px solid #d8cfc4;border-radius:8px;padding:1rem;margin:.8rem 0}
input{width:100%;box-sizing:border-box;margin:.2rem 0;padding:.4rem}
button{padding:.45rem 1rem;cursor:pointer}
.ok{background:#eef6ee;border-left:4px solid #4a7c3a;padding:.5rem .8rem}
.wait{background:#fdf3e3;border-left:4px solid #c8842a;padding:.5rem .8rem}
.err{background:#f6eeee;border-left:4px solid #a33;padding:.5rem .8rem}
.meta{color:#6f655c;font-size:.9rem}
</style></head><body>
<h1>工坊预约</h1>
<p class="meta">本站预约不涉及任何在线支付与电商结算。名额由服务端实时占用；提交后请保存回执码，状态以服务端查询为准。</p>
<div id="list">载入中…</div>

<div class="card"><h2>回执查询 / 找回</h2>
<input id="rc" placeholder="回执码"><button onclick="queryReceipt()">查询预约状态</button>
<details><summary>回执丢失？凭联系方式找回</summary>
<input id="lc" placeholder="预约时留的联系方式"><button onclick="lookup()">找回回执</button></details>
<div id="result"></div></div>

<script>
const el=(id)=>document.getElementById(id);
const esc=(s)=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
async function load(){
  const ws=await (await fetch('/api/workshops')).json();
  el('list').innerHTML=ws.map(w=>\`<div class="card"><h2>\${esc(w.title)}</h2>
<p class="meta">\${esc(w.starts_at)} · 名额 \${w.capacity} · 已确认 \${w.confirmed} · 候补 \${w.waiting}（服务端实时数据）</p>
<input id="n\${w.id}" placeholder="姓名"><input id="c\${w.id}" placeholder="联系方式">
<button onclick="book(\${w.id})">预约</button><div id="r\${w.id}"></div></div>\`).join('');
}
async function book(id){
  const name=el('n'+id).value.trim(), contact=el('c'+id).value.trim();
  const r=await fetch('/api/workshops/'+id+'/book',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name,contact})});
  const b=await r.json();
  if(b.error){el('r'+id).innerHTML='<div class="err">'+esc(b.error)+'</div>';return}
  // 不轻信提交响应，凭回执向服务端查询真实状态
  const s=await (await fetch('/api/bookings/'+b.receipt_code)).json();
  el('r'+id).innerHTML = s.status==='confirmed'
    ? \`<div class="ok">已确认（服务端核实）。回执码：<b>\${s.receipt_code}</b>，请妥善保存。</div>\`
    : \`<div class="wait">已登记候补，第 \${s.waitlist_pos} 位（服务端核实）。回执码：<b>\${s.receipt_code}</b>。</div>\`;
  load();
}
async function queryReceipt(){
  const r=await fetch('/api/bookings/'+encodeURIComponent(el('rc').value.trim()));
  const b=await r.json();
  el('result').innerHTML = b.error ? '<div class="err">'+esc(b.error)+'</div>'
    : \`<div class="\${b.status==='confirmed'?'ok':'wait'}">场次：\${esc(b.workshop_title)}（\${esc(b.starts_at)}）<br>
状态：\${b.status==='confirmed'?'已确认':'候补中，第 '+b.waitlist_pos+' 位'} · 该场已确认 \${b.counts.confirmed}/\${b.capacity}</div>
<button onclick="cancelBooking('\${b.receipt_code}')">取消预约</button>\`;
}
async function cancelBooking(rc){
  const r=await fetch('/api/bookings/'+rc+'/cancel',{method:'POST'});
  const b=await r.json();
  el('result').innerHTML = b.error ? '<div class="err">'+esc(b.error)+'</div>'
    : '<div class="ok">已取消。'+(b.promoted?'候补队首已顺延确认。':'')+'</div>';
  load();
}
async function lookup(){
  const r=await fetch('/api/bookings/lookup',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({contact:el('lc').value.trim()})});
  const list=await r.json();
  el('result').innerHTML = list.error ? '<div class="err">'+esc(list.error)+'</div>'
    : list.length ? list.map(b=>\`<div class="ok">\${esc(b.workshop_title)}（\${esc(b.starts_at)}）· 回执码：<b>\${b.receipt_code}</b> · \${b.status==='confirmed'?'已确认':'候补第 '+b.waitlist_pos+' 位'}</div>\`).join('')
    : '<div class="err">未找到该联系方式名下的有效预约。</div>';
}
load();
</script>
</body></html>`;
}
module.exports = { workshopPage };
