"""材料卡变更 → 沿引用图生成待复核文章列表。

引用图：materials → process_material_refs → process_cards
                                             → exhibit_processes → exhibits
                                             → exhibit_process_overrides → exhibits
铁律：只登记待复核任务，绝不自动改写工艺卡/展品陈述等历史记载。
"""
from .db import utcnow, snapshot, row_dict


def _add_task(conn, kind, material_id, entity_type, entity_id, reason, seen):
    key = (kind, entity_type, entity_id)
    if key in seen:
        return None
    seen.add(key)
    dup = conn.execute(
        "SELECT id FROM review_tasks WHERE kind=? AND material_id=? AND entity_type=?"
        ' AND entity_id=? AND status="pending"',
        (kind, material_id, entity_type, entity_id)).fetchone()
    if dup:
        return None
    cur = conn.execute(
        'INSERT INTO review_tasks(kind,material_id,entity_type,entity_id,reason,created_at)'
        ' VALUES(?,?,?,?,?,?)',
        (kind, material_id, entity_type, entity_id, reason, utcnow()))
    return cur.lastrowid


def fanout_material_change(conn, material_id, kind):
    """沿引用图列出受影响文章，生成待复核任务。返回任务 id 列表。"""
    mat = conn.execute('SELECT * FROM materials WHERE id=?', (material_id,)).fetchone()
    mname = mat['name'] if mat else '#%d' % material_id
    verb = '更新' if kind == 'material_updated' else '删除'
    tasks, seen = [], set()
    procs = conn.execute(
        'SELECT p.* FROM process_cards p'
        ' JOIN process_material_refs r ON r.process_id=p.id'
        ' WHERE r.material_id=? ORDER BY p.id', (material_id,)).fetchall()
    for p in procs:
        tid = _add_task(conn, kind, material_id, 'process_card', p['id'],
                        '材料「%s」已%s，工艺卡《%s》待复核' % (mname, verb, p['title']), seen)
        if tid:
            tasks.append(tid)
        exh = conn.execute(
            'SELECT DISTINCT e.id, e.title FROM exhibits e'
            ' JOIN exhibit_processes ep ON ep.exhibit_id=e.id WHERE ep.process_id=?'
            ' UNION'
            ' SELECT DISTINCT e.id, e.title FROM exhibits e'
            ' JOIN exhibit_process_overrides o ON o.exhibit_id=e.id WHERE o.process_id=?'
            ' ORDER BY id', (p['id'], p['id'])).fetchall()
        for e in exh:
            tid = _add_task(conn, kind, material_id, 'exhibit', e['id'],
                            '材料「%s」已%s，展品《%s》的工艺说明待复核' % (mname, verb, e['title']),
                            seen)
            if tid:
                tasks.append(tid)
    return tasks


def update_material(db, material_id, fields, note=''):
    """更新材料卡：版本+1、存快照、沿引用图登记待复核。历史记载不动。"""
    with db.tx() as conn:
        row = conn.execute('SELECT * FROM materials WHERE id=?', (material_id,)).fetchone()
        if not row:
            raise KeyError('material not found')
        if row['deleted_at']:
            raise ValueError('material deleted')
        allowed = ('name', 'notes')
        sets = [k for k in allowed if k in fields]
        if sets:
            sql = 'UPDATE materials SET %s, version=version+1, updated_at=? WHERE id=?' % \
                  ','.join('%s=?' % k for k in sets)
            conn.execute(sql, [fields[k] for k in sets] + [utcnow(), material_id])
        new = conn.execute('SELECT * FROM materials WHERE id=?', (material_id,)).fetchone()
        snapshot(conn, 'material', material_id, new['version'], row_dict(new), note)
        tasks = fanout_material_change(conn, material_id, 'material_updated')
        return {'material': row_dict(new), 'review_tasks': tasks}


def delete_material(db, material_id, note=''):
    """软删除材料卡：标记 deleted_at、登记待复核；引用它的历史陈述保持原样。"""
    with db.tx() as conn:
        row = conn.execute('SELECT * FROM materials WHERE id=?', (material_id,)).fetchone()
        if not row:
            raise KeyError('material not found')
        conn.execute('UPDATE materials SET deleted_at=?, version=version+1, updated_at=? WHERE id=?',
                     (utcnow(), utcnow(), material_id))
        new = conn.execute('SELECT * FROM materials WHERE id=?', (material_id,)).fetchone()
        snapshot(conn, 'material', material_id, new['version'], row_dict(new), note or '删除材料卡')
        tasks = fanout_material_change(conn, material_id, 'material_deleted')
        return {'material': row_dict(new), 'review_tasks': tasks}
