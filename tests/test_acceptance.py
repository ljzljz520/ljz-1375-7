# -*- coding: utf-8 -*-
"""验收测试：借展、私坐标、材料删除、名额竞争、回执丢失、发布原子性等。"""
import json
import os
import shutil
import sys
import tempfile
import threading
import unittest
import urllib.request
from http.server import ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from kiln.db import DB
from kiln.seed import seed
from kiln import reservations as rs
from kiln import reviews as rv
from kiln.server import make_handler, create_entity, update_entity, approve
from kiln.inheritance import resolve_process_notes
from kiln.periods import era_relation
from kiln.publish import publish, PublishError

ADMIN = {'X-Admin-Token': 'dev-admin-token', 'Content-Type': 'application/json'}


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.public = os.path.join(self.tmp, 'public')
        os.makedirs(self.public)
        self.db = DB(os.path.join(self.tmp, 'test.db'))
        seed(self.db, self.public)

    def tearDown(self):
        self.db.close()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def read_public(self, rel):
        with open(os.path.join(self.public, 'current', rel), encoding='utf-8') as f:
            return f.read()

    def exhibit_by_slug(self, slug):
        return self.db.one('SELECT * FROM exhibits WHERE slug=?', (slug,))


class TestExhibitPages(Base):
    def test_loan_exhibit_shows_lender(self):
        """借展：公开页展示借展方与借展条款。"""
        html = self.read_public('exhibits/qingci-meiping.html')
        self.assertIn('借展信息', html)
        self.assertIn('邻省陶瓷博物馆', html)
        self.assertIn('2027-03-31', html)

    def test_provenance_dispute_published(self):
        """来源争议如实公开。"""
        html = self.read_public('exhibits/qingbai-wan.html')
        self.assertIn('来源争议', html)
        self.assertIn('邻近窑场', html)

    def test_era_shows_range_with_uncertainty(self):
        html = self.read_public('exhibits/qingbai-wan.html')
        self.assertIn('±30年', html)
        self.assertIn('不构成同代确证', html)

    def test_media_bound_to_license_version(self):
        """高分辨率图与打印说明在页面上绑定许可版本。"""
        html = self.read_public('exhibits/qingbai-wan.html')
        self.assertIn('data-license-version="4.0"', html)          # 高清图
        self.assertIn('data-license-version="2026-09"', html)      # 打印说明
        self.assertIn('CC BY-NC', html)
        self.assertIn('打印说明', html)


class TestKilnPrivacy(Base):
    def test_private_coords_absent_from_public_site(self):
        """禁止公开坐标的窑址：构建产物任何页面都不得含坐标。"""
        for root, _, files in os.walk(os.path.join(self.public, 'current')):
            for f in files:
                with open(os.path.join(root, f), encoding='utf-8') as fh:
                    body = fh.read()
                self.assertNotIn('121.3', body, f)
                self.assertNotIn('29.9', body, f)
        html = self.read_public('kilns/undisclosed-yue.html')
        self.assertIn('不公开', html)

    def test_public_kiln_keeps_coords(self):
        html = self.read_public('kilns/jingdezhen-hutian.html')
        self.assertIn('29.271', html)


class TestMaterialReviewFanout(Base):
    def test_delete_material_creates_review_tasks_keeps_history(self):
        """材料卡被删除：沿引用图列出待复核文章，历史记载不被自动改写。"""
        stmt_before = self.exhibit_by_slug('qingbai-wan')['statement']
        card_before = self.db.one("SELECT body FROM process_cards WHERE slug='glazing'")['body']
        mat = self.db.one("SELECT * FROM materials WHERE slug='glaze-ash'")
        result = rv.delete_material(self.db, mat['id'])
        self.assertTrue(result['review_tasks'])
        # 引用图：釉灰 → 施釉工艺卡 → 青白釉刻花碗
        tasks = self.db.q("SELECT * FROM review_tasks WHERE kind='material_deleted'")
        kinds = {(t['entity_type'], t['entity_id']) for t in tasks}
        glazing = self.db.one("SELECT id FROM process_cards WHERE slug='glazing'")
        self.assertIn(('process_card', glazing['id']), kinds)
        self.assertIn(('exhibit', self.exhibit_by_slug('qingbai-wan')['id']), kinds)
        # 历史记载未被自动修改
        self.assertEqual(stmt_before, self.exhibit_by_slug('qingbai-wan')['statement'])
        self.assertEqual(card_before,
                         self.db.one("SELECT body FROM process_cards WHERE slug='glazing'")['body'])
        # 快照仍在（历史可查）
        snaps = self.db.q("SELECT * FROM entity_versions WHERE entity_type='material' AND entity_id=?",
                          (mat['id'],))
        self.assertGreaterEqual(len(snaps), 2)
        # 已删除材料在公开工序页标注"待复核"而非静默消失
        publish(self.db, self.public)
        html = self.read_public('processes/glazing.html')
        self.assertIn('材料卡已删除，待复核', html)

    def test_update_material_lists_articles_along_reference_graph(self):
        """材料更新：引用图上的工艺卡与展品全部进入待复核列表。"""
        mat = self.db.one("SELECT * FROM materials WHERE slug='porcelain-stone'")
        rv.update_material(self.db, mat['id'], {'notes': '新研究表明需淘洗两次。'})
        tasks = self.db.q("SELECT * FROM review_tasks WHERE kind='material_updated' AND status='pending'")
        firing = self.db.one("SELECT id FROM process_cards WHERE slug='firing'")
        kinds = {(t['entity_type'], t['entity_id']) for t in tasks}
        self.assertIn(('process_card', firing['id']), kinds)
        self.assertIn(('exhibit', self.exhibit_by_slug('qingci-meiping')['id']), kinds)
        self.assertIn(('exhibit', self.exhibit_by_slug('qingbai-wan')['id']), kinds)


class TestInheritance(Base):
    def test_override_survives_card_update(self):
        """通用工艺卡全局修改不覆盖展品局部例外。"""
        ex = self.exhibit_by_slug('qingbai-wan')
        glazing = self.db.one("SELECT * FROM process_cards WHERE slug='glazing'")
        update_entity(self.db, 'process_card', glazing['id'],
                      {'body': '通用工艺（修订版）：喷釉为主。'}, '修订')
        notes = resolve_process_notes(self.db, ex['id'])
        g_note = [n for n in notes if n['process_id'] == glazing['id']][0]
        self.assertEqual(g_note['source'], 'exhibit_override')
        self.assertIn('半刀泥', g_note['effective_body'])       # 局部例外仍生效
        self.assertIn('喷釉', g_note['card_body'])              # 通用卡已更新
        self.assertTrue(g_note['card_updated_after_override'])  # 比较视图可提示
        firing = self.db.one("SELECT * FROM process_cards WHERE slug='firing'")
        f_note = [n for n in notes if n['process_id'] == firing['id']][0]
        self.assertEqual(f_note['source'], 'process_card')      # 无例外则继承

    def test_compare_inheritance_reverse_view(self):
        from kiln.inheritance import compare_inheritance
        glazing = self.db.one("SELECT * FROM process_cards WHERE slug='glazing'")
        r = compare_inheritance(self.db, glazing['id'])
        self.assertEqual(len(r['overridden']), 1)
        self.assertEqual(r['overridden'][0]['slug'], 'qingbai-wan')


class TestEraRelation(Base):
    def test_overlap_is_not_confirmed_contemporary(self):
        """区间相交（含不确定度）只表示可能同期，绝非同代确证。"""
        a = self.exhibit_by_slug('qingbai-wan')     # 960-1127 ±30
        b = self.exhibit_by_slug('qingci-meiping')  # 1100-1200 ±50
        rel = era_relation(dict(a), dict(b))
        self.assertEqual(rel['relation'], 'overlap_possible')
        self.assertIn('不构成同代确证', rel['note'])
        far = dict(a); far['era_start'], far['era_end'], far['era_uncertainty'] = 1600, 1700, 10
        self.assertEqual(era_relation(far, dict(b))['relation'], 'disjoint')


class TestReservations(Base):
    def _session(self, cap=1):
        return create_entity(self.db, 'session', {
            'slug': 's-%d' % cap, 'title': '测试场', 'capacity': cap,
            'starts_at': '2026-10-20T10:00:00+08:00', 'ends_at': '2026-10-20T12:00:00+08:00'})

    def test_last_slot_contention_exactly_one_wins(self):
        """最后名额竞争：并发抢占，服务端原子占用，恰一人确认。"""
        s = self._session(cap=1)
        results, errors = [], []

        def worker(i):
            try:
                results.append(rs.book(self.db, s['id'], '访客%d' % i, 'c%d@test' % i))
            except Exception as e:  # pragma: no cover
                errors.append(e)

        threads = [threading.Thread(target=worker, args=(i,)) for i in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertFalse(errors)
        confirmed = [r for r in results if r['status'] == 'confirmed']
        waitlisted = [r for r in results if r['status'] == 'waitlisted']
        self.assertEqual(len(confirmed), 1)
        self.assertEqual(len(waitlisted), 7)
        positions = sorted(r['position'] for r in waitlisted)
        self.assertEqual(positions, list(range(1, 8)))
        st = rs.session_status(self.db, s['id'])
        self.assertEqual((st['confirmed'], st['waitlisted'], st['remaining']), (1, 7, 0))

    def test_cancel_promotes_earliest_waitlist_with_timeline(self):
        """取消释放名额 → 候补按序递补，事件时序完整可查。"""
        s = self._session(cap=1)
        r1 = rs.book(self.db, s['id'], '甲', 'a@t')
        r2 = rs.book(self.db, s['id'], '乙', 'b@t')
        r3 = rs.book(self.db, s['id'], '丙', 'c@t')
        self.assertEqual((r2['status'], r2['position']), ('waitlisted', 1))
        out = rs.cancel(self.db, r1['reservation_id'], contact='a@t')
        self.assertEqual(out['promoted']['reservation_id'], r2['reservation_id'])
        self.assertEqual(rs.get_reservation(self.db, r2['reservation_id'], 'b@t')['status'],
                         'confirmed')
        self.assertEqual(rs.get_reservation(self.db, r3['reservation_id'], 'c@t')['position'], 1)
        events = [e['event'] for e in rs.events_of(self.db, r2['reservation_id'])]
        self.assertEqual(events, ['waitlisted', 'promoted'])  # 明确时序
        times = [e['at'] for e in rs.events_of(self.db, r2['reservation_id'])]
        self.assertEqual(times, sorted(times))

    def test_receipt_reissue_after_loss(self):
        """确认回执丢失：补发新码，旧码作废（superseded），预约状态不变。"""
        s = self._session(cap=2)
        r = rs.book(self.db, s['id'], '甲', 'a@t')
        old_code = r['receipt_code']
        out = rs.reissue_receipt(self.db, r['reservation_id'], 'a@t')
        self.assertNotEqual(out['receipt_code'], old_code)
        self.assertEqual(out['superseded'], old_code)
        old = self.db.one('SELECT status FROM receipts WHERE code=?', (old_code,))
        self.assertEqual(old['status'], 'superseded')
        got = rs.get_reservation(self.db, r['reservation_id'], 'a@t')
        self.assertEqual(got['status'], 'confirmed')
        self.assertEqual(got['receipt']['code'], out['receipt_code'])
        with self.assertRaises(rs.Forbidden):
            rs.reissue_receipt(self.db, r['reservation_id'], 'wrong@t')

    def test_double_booking_same_session_still_atomic(self):
        """容量为 2 时，前两人确认、第三人候补；取消一人后最早候补递补。"""
        s = self._session(cap=2)
        a = rs.book(self.db, s['id'], 'A', 'a@t')
        b = rs.book(self.db, s['id'], 'B', 'b@t')
        c = rs.book(self.db, s['id'], 'C', 'c@t')
        self.assertEqual(c['status'], 'waitlisted')
        rs.cancel(self.db, a['reservation_id'], contact='a@t')
        self.assertEqual(rs.get_reservation(self.db, c['reservation_id'], 'c@t')['status'],
                         'confirmed')


class TestPublishAtomicity(Base):
    def test_failed_publish_keeps_previous_build(self):
        """发布失败不混入半版内容：current 仍指向旧构建。"""
        before = os.readlink(os.path.join(self.public, 'current'))
        index_before = self.read_public('index.html')
        # 制造悬空引用：釉色存在但未获批准，引用它的展品被批准 → 构建必须失败
        g = create_entity(self.db, 'glaze', {'slug': 'unapproved', 'name': '未批准釉色'})
        bad = create_entity(self.db, 'exhibit', {
            'slug': 'broken', 'title': '坏展品', 'statement': 'x',
            'kiln_site_id': 1, 'glaze_id': g['id'], 'vessel_form_id': 1,
            'era_start': 1000, 'era_end': 1100, 'era_uncertainty': 0})
        approve(self.db, 'exhibit', bad['id'])
        with self.assertRaises(PublishError):
            publish(self.db, self.public)
        after = os.readlink(os.path.join(self.public, 'current'))
        self.assertEqual(before, after)                       # 原子性：旧版本原样保留
        self.assertEqual(index_before, self.read_public('index.html'))
        self.assertFalse(os.path.exists(os.path.join(self.public, 'current',
                                                     'exhibits/broken.html')))
        run = self.db.one('SELECT * FROM publish_runs ORDER BY id DESC LIMIT 1')
        self.assertEqual(run['status'], 'failed')

    def test_old_deep_link_redirects_and_keeps_provenance_chain(self):
        """旧深链接：slug 变更后旧地址跳转，目标页保留公开来源链。"""
        ex = self.exhibit_by_slug('qingbai-wan')
        update_entity(self.db, 'exhibit', ex['id'], {'slug': 'qingbai-wan-v2'}, '更名')
        approve(self.db, 'exhibit', ex['id'])
        publish(self.db, self.public)
        old = self.read_public('exhibits/qingbai-wan.html')   # 旧深链接仍有效
        self.assertIn('exhibits/qingbai-wan-v2.html', old)
        new = self.read_public('exhibits/qingbai-wan-v2.html')
        self.assertIn('来源链', new)
        self.assertIn('更名', new)                            # 版本记录公开可查


class TestHttpApi(Base):
    """端到端：静态页 + 公开 API 展示服务端真实状态。"""

    def setUp(self):
        super().setUp()
        handler = make_handler(self.db, self.public)
        self.httpd = ThreadingHTTPServer(('127.0.0.1', 0), handler)
        self.port = self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        super().tearDown()

    def api(self, method, path, body=None, headers=None):
        req = urllib.request.Request('http://127.0.0.1:%d%s' % (self.port, path),
                                     method=method,
                                     data=json.dumps(body).encode() if body is not None else None,
                                     headers=headers or {'Content-Type': 'application/json'})
        def parse(raw):
            text = raw.decode()
            try:
                return json.loads(text)
            except ValueError:
                return text
        try:
            with urllib.request.urlopen(req) as resp:
                return resp.status, parse(resp.read())
        except urllib.error.HTTPError as e:
            return e.code, parse(e.read())

    def test_reserve_flow_shows_server_truth(self):
        sid = self.db.one("SELECT id FROM workshop_sessions WHERE slug='glaze-basics-1010'")['id']
        st, d = self.api('POST', '/api/reserve',
                         {'session_id': sid, 'visitor_name': '王', 'contact': 'w@t'})
        self.assertEqual((st, d['status']), (200, 'confirmed'))
        self.assertTrue(d['receipt_code'].startswith('R-'))
        st, s = self.api('GET', '/api/sessions/%d' % sid)
        self.assertEqual(s['confirmed'], 1)                   # 页面计数来自服务端
        # 回执丢失 → 查询接口用联系方式找回，或补发
        st, got = self.api('GET', '/api/reservations/%d?contact=w@t' % d['reservation_id'])
        self.assertEqual(got['receipt']['code'], d['receipt_code'])
        st, re = self.api('POST', '/api/reservations/%d/receipt/reissue' % d['reservation_id'],
                          {'contact': 'w@t'})
        self.assertEqual(st, 200)
        self.assertNotEqual(re['receipt_code'], d['receipt_code'])
        # 静态页与坐标隐私
        st, _ = self.api('GET', '/index.html')
        self.assertEqual(st, 200)
        st, k = self.api('GET', '/api/kilns/undisclosed-yue')
        self.assertNotIn('lat', k)
        st, k2 = self.api('GET', '/api/kilns/jingdezhen-hutian')
        self.assertIn('lat', k2)
        # 后台接口需要令牌
        st, _ = self.api('GET', '/api/admin/review-tasks')
        self.assertEqual(st, 401)
        st, _ = self.api('GET', '/api/admin/review-tasks', headers=ADMIN)
        self.assertEqual(st, 200)


if __name__ == '__main__':
    unittest.main(verbosity=2)
