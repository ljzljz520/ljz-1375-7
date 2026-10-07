"""演示数据：窑址/釉色/器型/工序/材料/展品/媒体/工坊，并批准后发布。"""
import os
from .db import utcnow, snapshot, row_dict
from .server import create_entity, update_entity, approve
from .publish import publish


def _link(db, sql, args):
    with db.tx() as conn:
        conn.execute(sql, args)


def seed(db, public_dir):
    # 窑址：一处坐标可公开，一处禁止公开
    k1 = create_entity(db, 'kiln_site', {
        'slug': 'jingdezhen-hutian', 'name': '景德镇湖田窑',
        'summary': '宋元时期重要青白瓷窑场。', 'lat': 29.271, 'lng': 117.208,
        'coord_visibility': 'public'})
    k2 = create_entity(db, 'kiln_site', {
        'slug': 'undisclosed-yue', 'name': '某越窑系窑址（保护中）',
        'summary': '尚未完成发掘保护，坐标不公开。', 'lat': 29.9, 'lng': 121.3,
        'coord_visibility': 'private'})
    g1 = create_entity(db, 'glaze', {'slug': 'qingbai', 'name': '青白釉',
                                     'description': '釉色青中泛白，白中显青。'})
    g2 = create_entity(db, 'glaze', {'slug': 'qingci', 'name': '青釉',
                                     'description': '铁呈色的高温石灰釉。'})
    f1 = create_entity(db, 'vessel_form', {'slug': 'wan', 'name': '碗',
                                           'description': '敞口圈足日用器。'})
    f2 = create_entity(db, 'vessel_form', {'slug': 'meiping', 'name': '梅瓶',
                                           'description': '小口短颈丰肩瓶。'})
    p1 = create_entity(db, 'process_card', {
        'slug': 'glazing', 'title': '施釉',
        'body': '通用工艺：坯体干燥后浸釉或荡釉，釉层厚薄均匀。'})
    p2 = create_entity(db, 'process_card', {
        'slug': 'firing', 'title': '烧成',
        'body': '通用工艺：龙窑或馒头窑还原焰烧成，烧成温度约 1280°C。'})
    m1 = create_entity(db, 'material', {'slug': 'porcelain-stone', 'name': '瓷石',
                                        'notes': '主要制胎原料。'})
    m2 = create_entity(db, 'material', {'slug': 'glaze-ash', 'name': '釉灰',
                                        'notes': '与釉果配比调釉。'})
    _link(db, 'INSERT INTO process_material_refs(process_id,material_id,note) VALUES(?,?,?)',
          (p1['id'], m2['id'], '施釉工序的主要调釉材料'))
    _link(db, 'INSERT INTO process_material_refs(process_id,material_id,note) VALUES(?,?,?)',
          (p2['id'], m1['id'], '胎料影响烧成曲线'))

    e1 = create_entity(db, 'exhibit', {
        'slug': 'qingbai-wan', 'title': '青白釉刻花碗',
        'statement': '湖田窑青白釉刻花碗，芒口，刻花流畅。',
        'kiln_site_id': k1['id'], 'glaze_id': g1['id'], 'vessel_form_id': f1['id'],
        'era_start': 960, 'era_end': 1127, 'era_uncertainty': 30,
        'provenance_dispute': '有学者认为该器可能出自湖田窑邻近窑场，尚无定论。'})
    e2 = create_entity(db, 'exhibit', {
        'slug': 'qingci-meiping', 'title': '青釉梅瓶（借展）',
        'statement': '借展青釉梅瓶，釉色莹润。',
        'kiln_site_id': k2['id'], 'glaze_id': g2['id'], 'vessel_form_id': f2['id'],
        'era_start': 1100, 'era_end': 1200, 'era_uncertainty': 50,
        'is_loan': 1, 'lender_name': '邻省陶瓷博物馆',
        'loan_note': '借展期至 2027-03-31，禁止闪光灯拍摄。'})
    _link(db, 'INSERT INTO exhibit_processes(exhibit_id,process_id) VALUES(?,?)', (e1['id'], p1['id']))
    _link(db, 'INSERT INTO exhibit_processes(exhibit_id,process_id) VALUES(?,?)', (e1['id'], p2['id']))
    _link(db, 'INSERT INTO exhibit_processes(exhibit_id,process_id) VALUES(?,?)', (e2['id'], p2['id']))
    # 展品特定说明（局部例外）
    _link(db,
          'INSERT INTO exhibit_process_overrides(exhibit_id,process_id,body,reason,updated_at)'
          ' VALUES(?,?,?,?,?)',
          (e1['id'], p1['id'], '本件为半刀泥刻花后荡釉，釉层刻意偏薄以显刀锋。',
           '刻花装饰要求薄釉', utcnow()))

    create_entity(db, 'media', {
        'exhibit_id': e1['id'], 'kind': 'hires_image', 'title': '青白釉刻花碗 高清正视图',
        'file_path': 'media/qingbai-wan-hi.tif', 'license_name': 'CC BY-NC',
        'license_version': '4.0'})
    create_entity(db, 'media', {
        'exhibit_id': e1['id'], 'kind': 'print_note', 'title': '青白釉刻花碗 打印说明卡',
        'file_path': 'media/qingbai-wan-print.pdf', 'license_name': '馆内印刷许可',
        'license_version': '2026-09'})

    create_entity(db, 'session', {
        'slug': 'glaze-basics-1010', 'title': '施釉体验工坊（10月10日场）',
        'description': '学习浸釉与荡釉，亲手为素坯施釉。',
        'starts_at': '2026-10-10T14:00:00+08:00', 'ends_at': '2026-10-10T16:00:00+08:00',
        'capacity': 2})

    # 全部批准后发布公开静态站
    for etype in ('kiln_site', 'glaze', 'vessel_form', 'process_card', 'material',
                  'exhibit', 'media', 'session'):
        for row in db.q('SELECT id FROM %s' % {
                'kiln_site': 'kiln_sites', 'glaze': 'glazes', 'vessel_form': 'vessel_forms',
                'process_card': 'process_cards', 'material': 'materials', 'exhibit': 'exhibits',
                'media': 'media_assets', 'session': 'workshop_sessions'}[etype]):
            approve(db, etype, row['id'], by='seed')
    return publish(db, public_dir)
