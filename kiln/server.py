"""HTTP 服务：公开 API、后台管理 API、公开静态站。

- 公开静态站只服务 public/current（由发布管线原子切换）。
- 预约类接口全部走服务端事务，页面所见即服务端真实状态。
- 后台接口需 X-Admin-Token（默认 dev-admin-token，可用 ADMIN_TOKEN 覆盖）。
"""
import json
import os
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

from .db import DB, ENTITY_TABLES, utcnow, snapshot, row_dict
from . import reservations as rs
from . import reviews as rv
from .inheritance import resolve_process_notes, compare_inheritance
from .periods import era_relation
from .publish import publish, PublishError

ADMIN_TOKEN = os.environ.get('ADMIN_TOKEN', 'dev-admin-token')

# 各实体允许后台写入的字段
FIELDS = {
    'kiln_site': ['slug', 'name', 'summary', 'lat', 'lng', 'coord_visibility'],
    'glaze': ['slug', 'name', 'description'],
    'vessel_form': ['slug', 'name', 'description'],
    'process_card': ['slug', 'title', 'body'],
    'material': ['slug', 'name', 'notes'],
    'exhibit': ['slug', 'title', 'statement', 'kiln_site_id', 'glaze_id', 'vessel_form_id',
                'era_start', 'era_end', 'era_uncertainty', 'is_loan', 'lender_name',
                'loan_note', 'provenance_dispute'],
    'media': ['exhibit_id', 'kind', 'title', 'file_path', 'license_name', 'license_version'],
    'session': ['slug', 'title', 'description', 'starts_at', 'ends_at', 'capacity'],
}


class ApiError(Exception):
    def __init__(self, status, msg):
        super().__init__(msg)
        self.status = status


def create_entity(db, etype, data):
    table = ENTITY_TABLES[etype]
    fields = [f for f in FIELDS[etype] if f in data]
    if 'slug' not in fields and etype != 'media':
        raise ApiError(400, 'slug 必填')
    now = utcnow()
    with db.tx() as conn:
        cur = conn.execute(
            'INSERT INTO %s(%s,created_at,updated_at) VALUES(%s,?,?)'
            % (table, ','.join(fields), ','.join('?' * len(fields))),
            [data[f] for f in fields] + [now, now])
        eid = cur.lastrowid
        row = conn.execute('SELECT * FROM %s WHERE id=?' % table, (eid,)).fetchone()
        snapshot(conn, etype, eid, row['version'], row_dict(row), '创建')
        return row_dict(row)


def update_entity(db, etype, eid, data, note='更新'):
    table = ENTITY_TABLES[etype]
    fields = [f for f in FIELDS[etype] if f in data]
    with db.tx() as conn:
        old = conn.execute('SELECT * FROM %s WHERE id=?' % table, (eid,)).fetchone()
        if not old:
            raise ApiError(404, 'not found')
        if etype == 'exhibit' and 'slug' in data and data['slug'] != old['slug']:
            # 旧深链接保留：登记跳转，来源链仍在目标页公开
            conn.execute(
                'INSERT OR REPLACE INTO redirects(old_path,new_path,created_at) VALUES(?,?,?)',
                ('/exhibits/%s.html' % old['slug'], '/exhibits/%s.html' % data['slug'], utcnow()))
        if fields:
            conn.execute(
                'UPDATE %s SET %s, version=version+1, updated_at=? WHERE id=?'
                % (table, ','.join('%s=?' % f for f in fields)),
                [data[f] for f in fields] + [utcnow(), eid])
        row = conn.execute('SELECT * FROM %s WHERE id=?' % table, (eid,)).fetchone()
        snapshot(conn, etype, eid, row['version'], row_dict(row), note)
        return row_dict(row)


def approve(db, etype, eid, by='admin'):
    table = ENTITY_TABLES[etype]
    with db.tx() as conn:
        row = conn.execute('SELECT * FROM %s WHERE id=?' % table, (eid,)).fetchone()
        if not row:
            raise ApiError(404, 'not found')
        conn.execute(
            'INSERT INTO approvals(entity_type,entity_id,version,approved_by,approved_at)'
            ' VALUES(?,?,?,?,?)'
            ' ON CONFLICT(entity_type,entity_id) DO UPDATE SET'
            ' version=excluded.version, approved_by=excluded.approved_by,'
            ' approved_at=excluded.approved_at',
            (etype, eid, row['version'], by, utcnow()))
        return {'entity_type': etype, 'entity_id': eid, 'approved_version': row['version']}


def public_kiln(row):
    d = row_dict(row)
    if d['coord_visibility'] != 'public':   # 禁止公开坐标
        d.pop('lat', None)
        d.pop('lng', None)
    return d


def make_handler(db, public_dir):
    routes = []

    def route(method, pattern, auth=False):
        def deco(fn):
            routes.append((method, re.compile('^' + pattern + '$'), fn, auth))
            return fn
        return deco

    # ---------------- 公开 API ----------------
    @route('GET', r'/api/health')
    def _(req, m):
        return {'ok': True}

    @route('GET', r'/api/sessions/(\d+)')
    def _(req, m):
        try:
            return rs.session_status(db, int(m.group(1)))
        except rs.NotFound as e:
            raise ApiError(404, str(e))

    @route('POST', r'/api/reserve')
    def _(req, m):
        b = req.body
        try:
            return rs.book(db, int(b.get('session_id')), b.get('visitor_name'), b.get('contact'))
        except rs.NotFound as e:
            raise ApiError(404, str(e))
        except ValueError as e:
            raise ApiError(400, str(e))

    @route('POST', r'/api/reservations/(\d+)/cancel')
    def _(req, m):
        try:
            return rs.cancel(db, int(m.group(1)), req.body.get('contact'))
        except rs.NotFound as e:
            raise ApiError(404, str(e))
        except rs.Forbidden as e:
            raise ApiError(403, str(e))

    @route('GET', r'/api/reservations/(\d+)')
    def _(req, m):
        contact = req.query.get('contact', [''])[0]
        try:
            return rs.get_reservation(db, int(m.group(1)), contact)
        except rs.NotFound as e:
            raise ApiError(404, str(e))
        except rs.Forbidden as e:
            raise ApiError(403, str(e))

    @route('POST', r'/api/reservations/(\d+)/receipt/reissue')
    def _(req, m):
        try:
            return rs.reissue_receipt(db, int(m.group(1)), req.body.get('contact', ''))
        except rs.NotFound as e:
            raise ApiError(404, str(e))
        except rs.Forbidden as e:
            raise ApiError(403, str(e))
        except ValueError as e:
            raise ApiError(400, str(e))

    @route('GET', r'/api/era-relation')
    def _(req, m):
        a = db.one('SELECT * FROM exhibits WHERE slug=?', (req.query.get('a', [''])[0],))
        b = db.one('SELECT * FROM exhibits WHERE slug=?', (req.query.get('b', [''])[0],))
        if not a or not b:
            raise ApiError(404, 'exhibit not found')
        rel = era_relation(row_dict(a), row_dict(b))
        rel['a'], rel['b'] = a['slug'], b['slug']
        return rel

    @route('GET', r'/api/kilns/([a-z0-9-]+)')
    def _(req, m):
        row = db.one('SELECT * FROM kiln_sites WHERE slug=?', (m.group(1),))
        if not row:
            raise ApiError(404, 'not found')
        return public_kiln(row)

    # ---------------- 后台 API ----------------
    @route('POST', r'/api/admin/(kiln_site|glaze|vessel_form|process_card|material|exhibit|media|session)s?', auth=True)
    def _(req, m):
        return create_entity(db, m.group(1), req.body)

    @route('PUT', r'/api/admin/(kiln_site|glaze|vessel_form|process_card|material|exhibit|media|session)s?/(\d+)', auth=True)
    def _(req, m):
        etype, eid = m.group(1), int(m.group(2))
        if etype == 'material':
            return rv.update_material(db, eid, req.body, req.body.get('note', '更新材料卡'))
        return update_entity(db, etype, eid, req.body, req.body.get('note', '更新'))

    @route('DELETE', r'/api/admin/materials?/(\d+)', auth=True)
    def _(req, m):
        try:
            return rv.delete_material(db, int(m.group(1)))
        except KeyError as e:
            raise ApiError(404, str(e))

    @route('POST', r'/api/admin/exhibits/(\d+)/processes/(\d+)', auth=True)
    def _(req, m):
        with db.tx() as conn:
            conn.execute('INSERT OR IGNORE INTO exhibit_processes(exhibit_id,process_id) VALUES(?,?)',
                         (int(m.group(1)), int(m.group(2))))
        return {'linked': True}

    @route('PUT', r'/api/admin/exhibits/(\d+)/overrides/(\d+)', auth=True)
    def _(req, m):
        eid, pid = int(m.group(1)), int(m.group(2))
        body = req.body.get('body', '')
        if not body.strip():
            raise ApiError(400, 'body 必填')
        with db.tx() as conn:
            conn.execute(
                'INSERT INTO exhibit_process_overrides(exhibit_id,process_id,body,reason,updated_at)'
                ' VALUES(?,?,?,?,?)'
                ' ON CONFLICT(exhibit_id,process_id) DO UPDATE SET'
                ' body=excluded.body, reason=excluded.reason, updated_at=excluded.updated_at',
                (eid, pid, body, req.body.get('reason', ''), utcnow()))
        return {'exhibit_id': eid, 'process_id': pid, 'override': True}

    @route('GET', r'/api/admin/exhibits/(\d+)/process-notes', auth=True)
    def _(req, m):
        return {'notes': resolve_process_notes(db, int(m.group(1)))}

    @route('GET', r'/api/admin/process-cards/(\d+)/inheritance', auth=True)
    def _(req, m):
        r = compare_inheritance(db, int(m.group(1)))
        if not r:
            raise ApiError(404, 'not found')
        return r

    @route('GET', r'/api/admin/review-tasks', auth=True)
    def _(req, m):
        status = req.query.get('status', ['pending'])[0]
        return {'tasks': [row_dict(r) for r in db.q(
            'SELECT * FROM review_tasks WHERE status=? ORDER BY id', (status,))]}

    @route('POST', r'/api/admin/review-tasks/(\d+)/resolve', auth=True)
    def _(req, m):
        with db.tx() as conn:
            conn.execute("UPDATE review_tasks SET status='resolved', resolved_at=? WHERE id=?",
                         (utcnow(), int(m.group(1))))
        return {'resolved': int(m.group(1))}

    @route('POST', r'/api/admin/approvals', auth=True)
    def _(req, m):
        return approve(db, req.body['entity_type'], int(req.body['entity_id']),
                       req.body.get('by', 'admin'))

    @route('POST', r'/api/admin/publish', auth=True)
    def _(req, m):
        try:
            return publish(db, public_dir)
        except PublishError as e:
            raise ApiError(422, str(e))

    @route('GET', r'/api/admin/publish-runs', auth=True)
    def _(req, m):
        return {'runs': [row_dict(r) for r in db.q('SELECT * FROM publish_runs ORDER BY id DESC LIMIT 20')]}

    @route('GET', r'/api/admin/sessions/(\d+)/reservations', auth=True)
    def _(req, m):
        rows = db.q('SELECT * FROM reservations WHERE session_id=? ORDER BY id', (int(m.group(1)),))
        out = []
        for r in rows:
            d = row_dict(r)
            d['events'] = rs.events_of(db, r['id'])
            d['receipts'] = [row_dict(x) for x in db.q(
                'SELECT * FROM receipts WHERE reservation_id=? ORDER BY id', (r['id'],))]
            out.append(d)
        return {'reservations': out}

    @route('GET', r'/api/admin/(kiln_site|glaze|vessel_form|process_card|material|exhibit|media|session)s?', auth=True)
    def _(req, m):
        table = ENTITY_TABLES[m.group(1)]
        return {'items': [row_dict(r) for r in db.q('SELECT * FROM %s ORDER BY id' % table)]}

    # ---------------- 请求分发 ----------------
    class Handler(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'

        def log_message(self, *a):
            pass

        def _send(self, status, payload, ctype='application/json; charset=utf-8'):
            data = payload if isinstance(payload, bytes) else json.dumps(
                payload, ensure_ascii=False).encode('utf-8')
            self.send_response(status)
            self.send_header('Content-Type', ctype)
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def _handle(self, method):
            parsed = urlparse(self.path)
            path = parsed.path
            req = type('Req', (), {})()
            req.query = parse_qs(parsed.query)
            req.body = {}
            if method in ('POST', 'PUT', 'DELETE'):
                raw = self.rfile.read(int(self.headers.get('Content-Length') or 0))
                if raw:
                    try:
                        req.body = json.loads(raw.decode('utf-8'))
                    except ValueError:
                        return self._send(400, {'error': 'invalid json'})
            try:
                for meth, rx, fn, auth in routes:
                    if meth != method:
                        continue
                    mm = rx.match(path)
                    if not mm:
                        continue
                    if auth and self.headers.get('X-Admin-Token') != ADMIN_TOKEN:
                        return self._send(401, {'error': 'unauthorized'})
                    return self._send(200, fn(req, mm))
                if method == 'GET':
                    return self._static(path)
                self._send(404, {'error': 'not found'})
            except ApiError as e:
                self._send(e.status, {'error': str(e)})
            except Exception as e:  # pragma: no cover
                self._send(500, {'error': 'internal: %s' % e})

        def _static(self, path):
            if path in ('/', ''):
                path = '/index.html'
            root_abs = os.path.abspath(os.path.join(public_dir, 'current'))
            full = os.path.abspath(os.path.normpath(os.path.join(root_abs, path.lstrip('/'))))
            if full != root_abs and not full.startswith(root_abs + os.sep):
                return self._send(403, {'error': 'forbidden'})
            if not os.path.isfile(full):
                return self._send(404, {'error': 'not found'})
            ctype = 'text/html; charset=utf-8' if full.endswith('.html') else 'application/octet-stream'
            with open(full, 'rb') as f:
                self._send(200, f.read(), ctype)

        do_GET = lambda s: s._handle('GET')
        do_POST = lambda s: s._handle('POST')
        do_PUT = lambda s: s._handle('PUT')
        do_DELETE = lambda s: s._handle('DELETE')

    return Handler


def serve(db, public_dir, host='127.0.0.1', port=8000):
    handler = make_handler(db, public_dir)
    httpd = ThreadingHTTPServer((host, port), handler)
    print('窑火资料馆服务已启动: http://%s:%d （后台令牌见 ADMIN_TOKEN）' % (host, port))
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    return httpd
