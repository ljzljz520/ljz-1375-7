"""通用工艺卡 与 展品特定说明 的继承关系。

规则：展品默认继承通用工艺卡正文；一旦存在"展品特定说明"（override），
该展品对该工序生效局部例外。通用卡后续更新绝不覆盖局部例外，
只在比较视图中提示"通用卡已更新，本件仍为例外"。
"""


def resolve_process_notes(db, exhibit_id):
    """展品页实际展示的工艺说明 = 局部例外优先，否则继承通用卡。"""
    rows = db.q(
        'SELECT p.* FROM process_cards p'
        ' JOIN exhibit_processes ep ON ep.process_id=p.id'
        ' WHERE ep.exhibit_id=? ORDER BY p.id', (exhibit_id,))
    out = []
    for p in rows:
        ov = db.one(
            'SELECT * FROM exhibit_process_overrides WHERE exhibit_id=? AND process_id=?',
            (exhibit_id, p['id']))
        out.append({
            'process_id': p['id'],
            'process_slug': p['slug'],
            'process_title': p['title'],
            'card_body': p['body'],
            'card_version': p['version'],
            'card_updated_at': p['updated_at'],
            'source': 'exhibit_override' if ov else 'process_card',
            'effective_body': ov['body'] if ov else p['body'],
            'override': dict(ov) if ov else None,
            'card_updated_after_override': bool(ov and p['updated_at'] > ov['updated_at']),
        })
    return out


def compare_inheritance(db, process_id):
    """反向比较：某通用卡被哪些展品继承、被哪些展品打了局部例外。"""
    card = db.one('SELECT * FROM process_cards WHERE id=?', (process_id,))
    if not card:
        return None
    rows = db.q(
        'SELECT e.id, e.slug, e.title FROM exhibits e'
        ' JOIN exhibit_processes ep ON ep.exhibit_id=e.id WHERE ep.process_id=? ORDER BY e.id',
        (process_id,))
    inherited, overridden = [], []
    for e in rows:
        ov = db.one(
            'SELECT * FROM exhibit_process_overrides WHERE exhibit_id=? AND process_id=?',
            (e['id'], process_id))
        item = {'exhibit_id': e['id'], 'slug': e['slug'], 'title': e['title']}
        if ov:
            item['override_body'] = ov['body']
            item['card_updated_after_override'] = card['updated_at'] > ov['updated_at']
            overridden.append(item)
        else:
            inherited.append(item)
    return {'card': dict(card), 'inherited': inherited, 'overridden': overridden}
