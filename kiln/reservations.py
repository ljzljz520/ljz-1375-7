"""工坊预约：服务端原子占座、候补递补、取消释放、回执补发。

不做电商结算；名额占用全部在 BEGIN IMMEDIATE 事务内完成，
页面只展示服务端返回的真实状态，不做本地计数。
"""
import secrets
from .db import utcnow


class NotFound(Exception):
    pass


class Forbidden(Exception):
    pass


def _log(conn, reservation_id, event, detail=None):
    import json
    conn.execute(
        'INSERT INTO reservation_events(reservation_id,event,at,detail_json) VALUES(?,?,?,?)',
        (reservation_id, event, utcnow(), json.dumps(detail or {}, ensure_ascii=False)))


def _issue_receipt(conn, reservation_id, reissue_of=None):
    while True:
        code = 'R-' + secrets.token_hex(4).upper()
        try:
            cur = conn.execute(
                'INSERT INTO receipts(reservation_id,code,issued_at,reissue_of) VALUES(?,?,?,?)',
                (reservation_id, code, utcnow(), reissue_of))
            return cur.lastrowid, code
        except Exception:
            continue  # 唯一冲突则重试


def book(db, session_id, visitor_name, contact):
    """原子占座：事务内核对余量，确认或进入候补。返回服务端真实状态。"""
    visitor_name = (visitor_name or '').strip()
    contact = (contact or '').strip()
    if not visitor_name or not contact:
        raise ValueError('visitor_name 与 contact 必填')
    with db.tx() as conn:
        s = conn.execute('SELECT * FROM workshop_sessions WHERE id=?', (session_id,)).fetchone()
        if not s:
            raise NotFound('session not found')
        confirmed = conn.execute(
            "SELECT COUNT(*) n FROM reservations WHERE session_id=? AND status='confirmed'",
            (session_id,)).fetchone()['n']
        now = utcnow()
        if confirmed < s['capacity']:
            cur = conn.execute(
                "INSERT INTO reservations(session_id,visitor_name,contact,status,created_at,confirmed_at)"
                ' VALUES(?,?,?,?,?,?)',
                (session_id, visitor_name, contact, 'confirmed', now, now))
            rid = cur.lastrowid
            _, code = _issue_receipt(conn, rid)
            _log(conn, rid, 'confirmed', {'receipt_code': code})
            return {'reservation_id': rid, 'status': 'confirmed', 'receipt_code': code}
        pos = conn.execute(
            "SELECT COALESCE(MAX(waitlist_position),0)+1 p FROM reservations"
            " WHERE session_id=? AND status='waitlisted'", (session_id,)).fetchone()['p']
        cur = conn.execute(
            "INSERT INTO reservations(session_id,visitor_name,contact,status,waitlist_position,created_at)"
            ' VALUES(?,?,?,?,?,?)',
            (session_id, visitor_name, contact, 'waitlisted', pos, now))
        rid = cur.lastrowid
        _log(conn, rid, 'waitlisted', {'position': pos})
        return {'reservation_id': rid, 'status': 'waitlisted', 'position': pos}


def cancel(db, reservation_id, contact=None):
    """取消并释放名额：若是已确认名额，同事务内按候补时序递补最早者。"""
    with db.tx() as conn:
        r = conn.execute('SELECT * FROM reservations WHERE id=?', (reservation_id,)).fetchone()
        if not r:
            raise NotFound('reservation not found')
        if contact is not None and r['contact'] != contact:
            raise Forbidden('contact mismatch')
        if r['status'] == 'cancelled':
            return {'reservation_id': reservation_id, 'status': 'cancelled', 'promoted': None}
        was_confirmed = r['status'] == 'confirmed'
        now = utcnow()
        conn.execute("UPDATE reservations SET status='cancelled', cancelled_at=? WHERE id=?",
                     (now, reservation_id))
        _log(conn, reservation_id, 'cancelled', {'was': r['status']})
        conn.execute("UPDATE receipts SET status='void' WHERE reservation_id=? AND status='active'",
                     (reservation_id,))
        promoted = None
        if was_confirmed:
            nxt = conn.execute(
                "SELECT * FROM reservations WHERE session_id=? AND status='waitlisted'"
                ' ORDER BY waitlist_position LIMIT 1', (r['session_id'],)).fetchone()
            if nxt:
                conn.execute(
                    "UPDATE reservations SET status='confirmed', confirmed_at=?, promoted_at=?"
                    ' WHERE id=?', (now, now, nxt['id']))
                _, code = _issue_receipt(conn, nxt['id'])
                _log(conn, nxt['id'], 'promoted',
                     {'from_waitlist_position': nxt['waitlist_position'],
                      'released_by_reservation': reservation_id, 'receipt_code': code})
                promoted = {'reservation_id': nxt['id'], 'receipt_code': code}
        return {'reservation_id': reservation_id, 'status': 'cancelled', 'promoted': promoted}


def reissue_receipt(db, reservation_id, contact):
    """回执丢失补发：旧回执作废（superseded），签发新码，预约状态不变。"""
    with db.tx() as conn:
        r = conn.execute('SELECT * FROM reservations WHERE id=?', (reservation_id,)).fetchone()
        if not r:
            raise NotFound('reservation not found')
        if r['contact'] != contact:
            raise Forbidden('contact mismatch')
        if r['status'] != 'confirmed':
            raise ValueError('仅已确认的预约可补发回执')
        old = conn.execute(
            "SELECT * FROM receipts WHERE reservation_id=? AND status='active'",
            (reservation_id,)).fetchone()
        if old:
            conn.execute("UPDATE receipts SET status='superseded' WHERE id=?", (old['id'],))
        _, code = _issue_receipt(conn, reservation_id, reissue_of=old['id'] if old else None)
        _log(conn, reservation_id, 'receipt_reissued',
             {'old_code': old['code'] if old else None, 'new_code': code})
        return {'reservation_id': reservation_id, 'receipt_code': code,
                'superseded': old['code'] if old else None}


def get_reservation(db, reservation_id, contact):
    r = db.one('SELECT * FROM reservations WHERE id=?', (reservation_id,))
    if not r:
        raise NotFound('reservation not found')
    if r['contact'] != contact:
        raise Forbidden('contact mismatch')
    receipt = db.one(
        "SELECT code,status,issued_at FROM receipts WHERE reservation_id=? AND status='active'",
        (reservation_id,))
    events = db.one(
        'SELECT COALESCE(MAX(waitlist_position),0) p FROM reservations'
        " WHERE session_id=? AND status='waitlisted' AND waitlist_position<?",
        (r['session_id'], r['waitlist_position'] or 0))
    out = {'reservation_id': r['id'], 'session_id': r['session_id'], 'status': r['status'],
           'receipt': dict(receipt) if receipt else None,
           'confirmed_at': r['confirmed_at'], 'cancelled_at': r['cancelled_at'],
           'promoted_at': r['promoted_at']}
    if r['status'] == 'waitlisted':
        out['position'] = (events['p'] or 0) + 1
    return out


def session_status(db, session_id):
    """服务端真实计数（页面不得本地计数）。"""
    s = db.one('SELECT * FROM workshop_sessions WHERE id=?', (session_id,))
    if not s:
        raise NotFound('session not found')
    confirmed = db.one("SELECT COUNT(*) n FROM reservations WHERE session_id=? AND status='confirmed'",
                       (session_id,))['n']
    waitlisted = db.one("SELECT COUNT(*) n FROM reservations WHERE session_id=? AND status='waitlisted'",
                        (session_id,))['n']
    return {'session_id': session_id, 'title': s['title'], 'capacity': s['capacity'],
            'confirmed': confirmed, 'waitlisted': waitlisted,
            'remaining': max(0, s['capacity'] - confirmed)}


def events_of(db, reservation_id):
    return [dict(r) for r in db.q(
        'SELECT event,at,detail_json FROM reservation_events WHERE reservation_id=? ORDER BY id',
        (reservation_id,))]
