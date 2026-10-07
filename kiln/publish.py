"""静态公开站构建与原子发布。

铁律：
1. 只从"后台批准记录"(approvals → entity_versions)构建，草稿不进公开站。
2. 构建在临时目录完成并校验后，才原子切换到 public/current；
   发布失败时旧版本原样保留，绝不混入半版内容。
3. 窑址坐标标记为 private 的，公开产物中不得出现坐标。
4. 高分辨率图与打印说明按批准时的许可版本渲染并标注。
5. 旧深链接通过 redirects 生成跳转页，目标页保留公开的来源链。
"""
import html
import json
import os
import re
import shutil

from .db import utcnow
from .inheritance import resolve_process_notes
from .periods import era_text


class PublishError(Exception):
    pass


def esc(s):
    return html.escape(str(s if s is not None else ''), quote=True)


def paras(text):
    return ''.join('<p>%s</p>' % esc(p) for p in str(text or '').split('\n') if p.strip())


# ---------------------------------------------------------------- 批准快照

def load_approved(db):
    """{(entity_type, id): 已批准版本的数据 dict}"""
    out = {}
    for a in db.q('SELECT * FROM approvals'):
        v = db.one(
            'SELECT data_json FROM entity_versions WHERE entity_type=? AND entity_id=? AND version=?',
            (a['entity_type'], a['entity_id'], a['version']))
        if not v:
            raise PublishError('批准记录缺少版本快照: %s#%s v%s'
                               % (a['entity_type'], a['entity_id'], a['version']))
        out[(a['entity_type'], a['entity_id'])] = json.loads(v['data_json'])
    return out


def approved_of(approved, entity_type):
    return [d for (t, _), d in approved.items() if t == entity_type]


# ---------------------------------------------------------------- 页面渲染

PAGE = """<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title} · 窑火资料馆</title>
<style>
body{{font-family:"Songti SC",serif;max-width:52em;margin:2em auto;padding:0 1em;line-height:1.7;color:#2b2b2b}}
nav a{{margin-right:1em}} h1{{border-bottom:2px solid #8b3a2f;padding-bottom:.2em}}
.badge{{display:inline-block;background:#8b3a2f;color:#fff;border-radius:3px;padding:0 .5em;font-size:.8em;margin-left:.5em}}
.badge.local{{background:#2f5d8b}} .badge.warn{{background:#a33}}
.meta{{color:#666;font-size:.9em}} .license{{font-size:.85em;color:#555;border:1px dashed #999;padding:.2em .6em;display:inline-block}}
figure{{border:1px solid #ddd;padding:1em;margin:1em 0}} section{{margin:1.6em 0}}
table{{border-collapse:collapse}} td,th{{border:1px solid #ccc;padding:.3em .8em}}
input,button{{padding:.4em .6em;margin:.2em 0}} #result{{font-weight:bold}}
</style></head><body>
<nav><a href="/index.html">首页</a><a href="/index.html#exhibits">展品</a><a href="/index.html#sessions">工坊预约</a></nav>
{body}
<footer class="meta">窑火资料馆 · 构建版本 {build_id} · 生成于 {built_at}</footer>
</body></html>"""


def render_exhibit(db, approved, ex, build_id, built_at):
    kiln = approved.get(('kiln_site', ex.get('kiln_site_id')))
    glaze = approved.get(('glaze', ex.get('glaze_id')))
    form = approved.get(('vessel_form', ex.get('vessel_form_id')))
    for label, obj in (('窑址', kiln), ('釉色', glaze), ('器型', form)):
        if obj is None:
            raise PublishError('展品《%s》引用的%s未批准或不存在，拒绝发布半版内容'
                               % (ex['title'], label))
    b = ['<h1>%s</h1>' % esc(ex['title'])]
    b.append('<section id="statement"><h2>展品陈述</h2>%s</section>' % paras(ex['statement']))
    b.append('<section id="era"><h2>年代</h2><p>%s</p>'
             '<p class="meta">说明：年代为区间并含不确定度；与其他展品区间相交仅表示可能同期，'
             '不构成同代确证。</p></section>'
             % esc(era_text(ex.get('era_start'), ex.get('era_end'), ex.get('era_uncertainty'))))
    b.append('<section id="attrs"><h2>属性</h2><table>'
             '<tr><th>窑址</th><td><a href="/kilns/%s.html">%s</a></td></tr>'
             '<tr><th>釉色</th><td><a href="/glazes/%s.html">%s</a></td></tr>'
             '<tr><th>器型</th><td><a href="/forms/%s.html">%s</a></td></tr></table></section>'
             % (esc(kiln['slug']), esc(kiln['name']), esc(glaze['slug']), esc(glaze['name']),
                esc(form['slug']), esc(form['name'])))
    notes = resolve_process_notes(db, ex['id'])
    if notes:
        items = []
        for n in notes:
            if n['source'] == 'exhibit_override':
                items.append('<div><h3>%s<span class="badge local">本件特例说明</span></h3>%s'
                             '<p class="meta">例外理由：%s（通用工艺卡的后续修改不覆盖本说明）</p></div>'
                             % (esc(n['process_title']), paras(n['effective_body']),
                                esc(n['override']['reason'])))
            else:
                items.append('<div><h3>%s<span class="badge">继承通用工艺卡</span></h3>%s</div>'
                             % (esc(n['process_title']), paras(n['effective_body'])))
        b.append('<section id="process-notes"><h2>工艺说明</h2>%s</section>' % ''.join(items))
    if ex.get('is_loan'):
        b.append('<section id="loan"><h2>借展信息</h2>'
                 '<p>借展方：<strong>%s</strong></p>%s</section>'
                 % (esc(ex.get('lender_name')), paras(ex.get('loan_note'))))
    if ex.get('provenance_dispute'):
        b.append('<section id="dispute"><h2>来源争议</h2>'
                 '<p class="meta">以下争议如实记录，供研究者参考：</p>%s</section>'
                 % paras(ex['provenance_dispute']))
    media = [m for m in approved_of(approved, 'media') if m.get('exhibit_id') == ex['id']]
    if media:
        figs = []
        for m in media:
            kind = '高分辨率图' if m['kind'] == 'hires_image' else '打印说明'
            figs.append('<figure data-kind="%s" data-license="%s" data-license-version="%s">'
                        '<strong>%s</strong>（%s）<br><span class="license">许可：%s · 版本 %s</span>'
                        '</figure>'
                        % (esc(m['kind']), esc(m['license_name']), esc(m['license_version']),
                           esc(m['title']), kind, esc(m['license_name']), esc(m['license_version'])))
        b.append('<section id="media"><h2>图像与打印资料</h2>%s</section>' % ''.join(figs))
    chain = db.q('SELECT version,created_at,note FROM entity_versions'
                 ' WHERE entity_type=? AND entity_id=? ORDER BY version', ('exhibit', ex['id']))
    lis = ''.join('<li>v%s · %s · %s</li>' % (c['version'], esc(c['created_at']), esc(c['note'] or '—'))
                  for c in chain)
    b.append('<section id="provenance-chain"><h2>来源链（公开版本记录）</h2><ol>%s</ol></section>' % lis)
    return PAGE.format(title=esc(ex['title']), body=''.join(b), build_id=build_id, built_at=built_at)


def render_kiln(k, build_id, built_at):
    b = ['<h1>窑址 · %s</h1>' % esc(k['name']), paras(k.get('summary'))]
    if k.get('coord_visibility') == 'public' and k.get('lat') is not None:
        b.append('<p class="meta">公开坐标：%s, %s</p>' % (k['lat'], k['lng']))
    else:
        b.append('<p class="meta">坐标：应保护要求不公开。</p>')
    return PAGE.format(title='窑址 ' + esc(k['name']), body=''.join(b),
                       build_id=build_id, built_at=built_at)


def render_simple(kind_label, item, build_id, built_at, extra=''):
    body = '<h1>%s · %s</h1>%s%s' % (kind_label, esc(item.get('name') or item.get('title')),
                                     paras(item.get('description') or item.get('body')), extra)
    return PAGE.format(title='%s %s' % (kind_label, esc(item.get('name') or item.get('title'))),
                       body=body, build_id=build_id, built_at=built_at)


def render_process(db, approved, p, build_id, built_at):
    mats = db.q('SELECT m.name, m.deleted_at, r.note FROM process_material_refs r'
                ' JOIN materials m ON m.id=r.material_id WHERE r.process_id=?', (p['id'],))
    lis = []
    for m in mats:
        tag = ' <span class="badge warn">材料卡已删除，待复核</span>' if m['deleted_at'] else ''
        lis.append('<li>%s%s%s</li>' % (esc(m['name']), tag,
                                        (' — ' + esc(m['note'])) if m['note'] else ''))
    extra = '<section><h2>关联材料</h2><ul>%s</ul></section>' % ''.join(lis) if lis else ''
    return render_simple('工序', {'name': p['title'], 'description': p['body']},
                         build_id, built_at, extra)


def render_session(s, build_id, built_at):
    body = """<h1>工坊 · {title}</h1>
<p>{desc}</p><p class="meta">时间：{st} 至 {et} · 名额 {cap}</p>
<section id="live"><h2>实时名额（服务端数据）</h2>
<p>已确认 <b id="confirmed">…</b> / {cap} · 候补 <b id="waitlisted">…</b></p></section>
<section><h2>预约</h2>
<form id="book" onsubmit="return doBook(event)">
<input id="vname" placeholder="姓名" required>
<input id="contact" placeholder="联系方式" required>
<button type="submit">提交预约</button></form>
<div id="result"></div></section>
<script>
const SID={sid};
async function refresh(){{
  const r=await fetch('/api/sessions/'+SID); const d=await r.json();
  document.getElementById('confirmed').textContent=d.confirmed;
  document.getElementById('waitlisted').textContent=d.waitlisted;}}
async function doBook(e){{e.preventDefault();
  const r=await fetch('/api/reserve',{{method:'POST',headers:{{'Content-Type':'application/json'}},
    body:JSON.stringify({{session_id:SID,visitor_name:document.getElementById('vname').value,
      contact:document.getElementById('contact').value}})}});
  const d=await r.json(); const el=document.getElementById('result');
  if(d.status==='confirmed'){{el.innerHTML='✅ 服务端已确认，回执码：<b>'+d.receipt_code+'</b>（请妥善保存）';}}
  else if(d.status==='waitlisted'){{el.innerHTML='⏳ 已进入候补，序号 '+d.position;}}
  else {{el.textContent='预约失败：'+(d.error||r.status);}}
  refresh(); return false;}}
refresh(); setInterval(refresh,8000);
</script>""".format(title=esc(s['title']), desc=esc(s.get('description', '')),
                   st=esc(s.get('starts_at', '')), et=esc(s.get('ends_at', '')),
                   cap=s['capacity'], sid=s['id'])
    return PAGE.format(title='工坊 ' + esc(s['title']), body=body,
                       build_id=build_id, built_at=built_at)


def render_index(approved, build_id, built_at):
    def links(kind, path, key):
        items = sorted(approved_of(approved, kind), key=lambda x: x['id'])
        return ''.join('<li><a href="/%s/%s.html">%s</a></li>' % (path, esc(i['slug']), esc(i[key]))
                       for i in items)
    body = ('<h1>窑火资料馆</h1>'
            '<section><h2>窑址</h2><ul>%s</ul></section>'
            '<section><h2>釉色</h2><ul>%s</ul></section>'
            '<section><h2>器型</h2><ul>%s</ul></section>'
            '<section><h2>工序</h2><ul>%s</ul></section>'
            '<section id="exhibits"><h2>展品</h2><ul>%s</ul></section>'
            '<section id="sessions"><h2>工坊预约</h2><ul>%s</ul></section>'
            % (links('kiln_site', 'kilns', 'name'), links('glaze', 'glazes', 'name'),
               links('vessel_form', 'forms', 'name'), links('process_card', 'processes', 'title'),
               links('exhibit', 'exhibits', 'title'), links('session', 'sessions', 'title')))
    return PAGE.format(title='首页', body=body, build_id=build_id, built_at=built_at)


# ---------------------------------------------------------------- 校验与发布

HREF_RE = re.compile(r'(?:href|src)="(/[^"#]*)"')
IGNORE_PREFIXES = ('/api/',)


def check_links(root):
    """构建产物内部链接完整性校验：断链即失败，绝不上线半版内容。"""
    broken = []
    for dirpath, _, files in os.walk(root):
        for f in files:
            if not f.endswith('.html'):
                continue
            p = os.path.join(dirpath, f)
            with open(p, encoding='utf-8') as fh:
                for m in HREF_RE.findall(fh.read()):
                    if m.startswith(IGNORE_PREFIXES):
                        continue
                    target = os.path.join(root, m.lstrip('/'))
                    if not os.path.exists(target):
                        broken.append('%s -> %s' % (os.path.relpath(p, root), m))
    if broken:
        raise PublishError('构建产物存在断链: ' + '; '.join(broken[:5]))


def render_all(db, approved, root, build_id, built_at):
    def w(rel, content):
        path = os.path.join(root, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'w', encoding='utf-8') as f:
            f.write(content)

    w('index.html', render_index(approved, build_id, built_at))
    for k in approved_of(approved, 'kiln_site'):
        w('kilns/%s.html' % k['slug'], render_kiln(k, build_id, built_at))
    for g in approved_of(approved, 'glaze'):
        w('glazes/%s.html' % g['slug'], render_simple('釉色', g, build_id, built_at))
    for f_ in approved_of(approved, 'vessel_form'):
        w('forms/%s.html' % f_['slug'], render_simple('器型', f_, build_id, built_at))
    for p in approved_of(approved, 'process_card'):
        w('processes/%s.html' % p['slug'], render_process(db, approved, p, build_id, built_at))
    for ex in approved_of(approved, 'exhibit'):
        w('exhibits/%s.html' % ex['slug'], render_exhibit(db, approved, ex, build_id, built_at))
    for s in approved_of(approved, 'session'):
        w('sessions/%s.html' % s['slug'], render_session(s, build_id, built_at))
    # 旧深链接：生成跳转页（新内容已占用同路径时新内容优先）
    for r in db.q('SELECT * FROM redirects'):
        rel = r['old_path'].lstrip('/')
        if not rel or os.path.exists(os.path.join(root, rel)):
            continue
        w(rel, '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">'
               '<meta http-equiv="refresh" content="0;url=%s">'
               '<link rel="canonical" href="%s"></head>'
               '<body><p>该页面已迁移：<a href="%s">%s</a>（来源链保留于目标页）</p></body></html>'
               % (esc(r['new_path']), esc(r['new_path']), esc(r['new_path']), esc(r['new_path'])))


def publish(db, public_dir):
    """构建 → 校验 → 原子切换。失败时 current 保持不变。"""
    builds = os.path.join(public_dir, 'builds')
    os.makedirs(builds, exist_ok=True)
    with db.tx() as conn:
        cur = conn.execute(
            "INSERT INTO publish_runs(started_at,status) VALUES(?,'building')", (utcnow(),))
        run_id = cur.lastrowid
    tmp = os.path.join(public_dir, '.build-%d' % run_id)
    built_at = utcnow()
    try:
        approved = load_approved(db)
        shutil.rmtree(tmp, ignore_errors=True)
        os.makedirs(tmp)
        render_all(db, approved, tmp, run_id, built_at)
        check_links(tmp)
        final = os.path.join(builds, str(run_id))
        shutil.rmtree(final, ignore_errors=True)
        os.rename(tmp, final)
        tmplink = os.path.join(public_dir, '.current.tmp')
        if os.path.lexists(tmplink):
            os.remove(tmplink)
        os.symlink(os.path.relpath(final, public_dir), tmplink)
        os.replace(tmplink, os.path.join(public_dir, 'current'))  # 原子切换
        with db.tx() as conn:
            conn.execute("UPDATE publish_runs SET finished_at=?, status='success', build_dir=?"
                         ' WHERE id=?', (utcnow(), os.path.relpath(final, public_dir), run_id))
        return {'run_id': run_id, 'status': 'success'}
    except Exception as e:
        shutil.rmtree(tmp, ignore_errors=True)
        with db.tx() as conn:
            conn.execute("UPDATE publish_runs SET finished_at=?, status='failed', error=? WHERE id=?",
                         (utcnow(), str(e), run_id))
        if isinstance(e, PublishError):
            raise
        raise PublishError(str(e))
