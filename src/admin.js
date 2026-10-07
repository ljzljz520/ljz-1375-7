'use strict';
// 后台管理台（单页）：维护资料、批准、发布、查看待复核与预约。
function adminPage() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>窑火资料站 · 后台</title>
<style>
body{font-family:system-ui,"Noto Serif SC",serif;max-width:64rem;margin:0 auto;padding:1.5rem;line-height:1.6;color:#2b2320}
fieldset{border:1px solid #d8cfc4;border-radius:8px;margin:.8rem 0}legend{font-weight:600}
input,textarea,select{width:100%;box-sizing:border-box;margin:.2rem 0;padding:.35rem}
button{padding:.4rem .9rem;margin:.2rem 0;cursor:pointer}
pre{background:#f6f1ea;padding:.6rem;border-radius:6px;overflow:auto;font-size:.85rem}
h2{border-bottom:1px solid #e2d9ce;padding-bottom:.2rem;margin-top:2rem}
.row{display:grid;grid-template-columns:1fr 1fr;gap:.6rem}
a{color:#8a3b12}
</style></head><body>
<h1>窑火资料站 · 后台</h1>
<p><a href="/workshops">工坊预约页</a> · <a href="/site/">公开站（当前发布）</a> · <a href="/api/releases">发布记录</a></p>

<h2>基础资料</h2>
<div class="row">
<fieldset><legend>窑址（坐标默认不公开）</legend>
<input id="kname" placeholder="名称"><input id="kloc" placeholder="位置描述（公开）">
<div class="row"><input id="klat" placeholder="纬度"><input id="klng" placeholder="经度"></div>
<label><input id="kpub" type="checkbox" style="width:auto"> 允许公开坐标</label>
<button onclick="post('/api/kilns',{name:v('kname'),location_text:v('kloc'),lat:num('klat'),lng:num('klng'),coords_public:document.getElementById('kpub').checked})">保存窑址</button>
</fieldset>
<fieldset><legend>釉色 / 器型</legend>
<input id="gname" placeholder="釉色名"><button onclick="post('/api/glazes',{name:v('gname')})">保存釉色</button>
<input id="fname" placeholder="器型名"><button onclick="post('/api/forms',{name:v('fname')})">保存器型</button>
</fieldset></div>

<div class="row">
<fieldset><legend>工序（通用工艺卡）</legend>
<input id="pname" placeholder="工序名"><textarea id="pbody" placeholder="通用工艺卡正文"></textarea>
<button onclick="post('/api/processes',{name:v('pname'),card_body:v('pbody')})">保存工序</button>
<hr><input id="pid" placeholder="工序ID"><textarea id="pbody2" placeholder="更新通用卡正文（不影响展品局部例外）"></textarea>
<button onclick="post('/api/processes/'+v('pid')+'/card',{card_body:v('pbody2')})">更新通用卡</button>
</fieldset>
<fieldset><legend>材料卡（版本化）</legend>
<input id="mname" placeholder="材料名"><textarea id="mbody" placeholder="v1 内容"></textarea>
<button onclick="post('/api/materials',{name:v('mname'),body:v('mbody')})">新建材料卡</button>
<hr><input id="mid" placeholder="材料ID"><textarea id="mbody2" placeholder="新版本内容"></textarea>
<button onclick="post('/api/materials/'+v('mid')+'/versions',{body:v('mbody2')})">追加版本（引用旧版的文章将列入待复核）</button>
<button onclick="del('/api/materials/'+v('mid'))">删除材料卡（软删除，保留历史）</button>
</fieldset></div>

<h2>展品</h2>
<fieldset><legend>新建展品（年代为区间+不确定度）</legend>
<input id="etitle" placeholder="名称"><textarea id="estmt" placeholder="展品陈述"></textarea>
<div class="row"><input id="eks" placeholder="窑址ID"><input id="egl" placeholder="釉色ID"></div>
<div class="row"><input id="efo" placeholder="器型ID"><input id="eunc" placeholder="不确定度 ±年"></div>
<div class="row"><input id="eds" placeholder="年代起（年）"><input id="ede" placeholder="年代止（年）"></div>
<label><input id="eloan" type="checkbox" style="width:auto"> 借展</label>
<input id="elender" placeholder="出借方">
<button onclick="post('/api/exhibits',{title:v('etitle'),statement:v('estmt'),kiln_site_id:num('eks'),glaze_id:num('egl'),form_id:num('efo'),date_start:num('eds'),date_end:num('ede'),uncertainty_years:num('eunc')||0,on_loan:document.getElementById('eloan').checked,lender:v('elender')})">保存展品</button>
</fieldset>
<div class="row">
<fieldset><legend>展品 ↔ 工序（局部例外）</legend>
<input id="eid1" placeholder="展品ID"><input id="epid" placeholder="工序ID">
<textarea id="elocal" placeholder="展品特定说明（留空则继承通用卡）"></textarea>
<button onclick="post('/api/exhibits/'+v('eid1')+'/processes',{process_id:num('epid'),use_local:!!v('elocal'),local_note:v('elocal')})">关联</button>
<button onclick="get('/api/exhibits/'+v('eid1')+'/process-cards')">查看继承结果</button>
</fieldset>
<fieldset><legend>来源争议 / 批准 / 年代比较</legend>
<input id="eid2" placeholder="展品ID">
<input id="dclaim" placeholder="主张"><input id="dcounter" placeholder="异议"><input id="dsrc" placeholder="来源">
<button onclick="post('/api/exhibits/'+v('eid2')+'/disputes',{claim:v('dclaim'),counter_claim:v('dcounter'),source:v('dsrc'),approve:true})">登记争议（已批准）</button>
<button onclick="post('/api/exhibits/'+v('eid2')+'/approve',{})">批准展品</button>
<div class="row"><input id="cmpa" placeholder="展品A ID"><input id="cmpb" placeholder="展品B ID"></div>
<button onclick="get('/api/exhibits/'+v('cmpa')+'/chronology?with='+v('cmpb'))">比较年代（相交≠同代确证）</button>
</fieldset></div>

<h2>文章与引用</h2>
<div class="row">
<fieldset><legend>文章</legend>
<input id="atitle" placeholder="标题"><textarea id="abody" placeholder="正文"></textarea>
<button onclick="post('/api/articles',{title:v('atitle'),body:v('abody')})">保存</button>
<input id="aid" placeholder="文章ID"><input id="amid" placeholder="引用材料ID"><input id="aver" placeholder="引用版本">
<button onclick="post('/api/articles/'+v('aid')+'/citations',{target_type:'material',target_id:num('amid'),version:num('aver')})">添加引用</button>
<button onclick="post('/api/articles/'+v('aid')+'/approve',{})">批准文章</button>
</fieldset>
<fieldset><legend>待复核（材料更新沿引用图产生）</legend>
<button onclick="get('/api/review/pending')">刷新待复核列表</button>
<input id="cid" placeholder="引用ID"><input id="cver" placeholder="复核到版本">
<button onclick="post('/api/citations/'+v('cid')+'/resolve',{version:num('cver')})">人工复核通过</button>
</fieldset></div>

<h2>许可与媒体</h2>
<fieldset><legend>许可版本 / 媒体（高清图、打印说明须绑定许可版本）</legend>
<div class="row"><input id="lcode" placeholder="许可代码 如 CC-BY"><input id="lver" placeholder="版本 如 4.0"></div>
<button onclick="post('/api/licenses',{code:v('lcode'),version:v('lver')})">保存许可</button>
<div class="row"><input id="meid" placeholder="展品ID"><input id="mpath" placeholder="文件路径"></div>
<div class="row"><select id="mkind"><option value="image_hires">高清图</option><option value="print">打印说明</option></select>
<input id="mlic" placeholder="许可ID"></div>
<button onclick="post('/api/media',{exhibit_id:num('meid'),kind:v('mkind'),path:v('mpath'),license_id:num('mlic')})">保存媒体</button>
<input id="mediaid" placeholder="媒体ID"><button onclick="post('/api/media/'+v('mediaid')+'/approve',{})">批准媒体</button>
</fieldset>

<h2>工坊场次</h2>
<fieldset><legend>新场次（无电商结算，名额服务端原子占用）</legend>
<input id="wtitle" placeholder="标题"><input id="wstart" placeholder="时间 如 2026-10-20 10:00"><input id="wcap" placeholder="名额">
<button onclick="post('/api/workshops',{title:v('wtitle'),starts_at:v('wstart'),capacity:num('wcap')})">保存场次</button>
</fieldset>

<h2>发布</h2>
<fieldset><legend>静态公开站（仅含已批准记录；失败不混入半版内容）</legend>
<button onclick="post('/api/publish',{})">发布新版本</button>
<button onclick="get('/api/releases')">发布记录</button>
</fieldset>

<h2>输出</h2><pre id="out">…</pre>
<script>
const v=(id)=>document.getElementById(id).value.trim();
const num=(id)=>{const x=v(id);return x===''?null:Number(x)};
const out=(o)=>document.getElementById('out').textContent=typeof o==='string'?o:JSON.stringify(o,null,2);
async function post(url,body){const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});out(await r.json())}
async function get(url){const r=await fetch(url);out(await r.json())}
async function del(url){const r=await fetch(url,{method:'DELETE'});out(await r.json())}
</script>
</body></html>`;
}
module.exports = { adminPage };
