"""年代区间与不确定度。

铁律：区间（含不确定度）相交只表示"可能同期"，绝不输出"同代确证"。
"""

DISCLAIMER = '年代区间（含不确定度）相交，仅表示可能同期，不构成同代确证。'


def fmt_year(y):
    if y is None:
        return '不详'
    return '公元前%d年' % -y if y < 0 else '公元%d年' % y


def era_bounds(start, end, uncertainty):
    """含不确定度的有效区间 [lo, hi]。"""
    u = uncertainty or 0
    lo = None if start is None else start - u
    hi = None if end is None else end + u
    return lo, hi


def era_text(start, end, uncertainty):
    if start is None and end is None:
        return '年代不详'
    lo, hi = era_bounds(start, end, uncertainty)
    if lo == hi:
        base = fmt_year(lo)
    else:
        base = '%s–%s' % (fmt_year(lo), fmt_year(hi))
    if uncertainty:
        base += '（±%d年）' % uncertainty
    return base


def era_relation(a, b):
    """比较两件展品的年代。返回 disjoint / overlap_possible（永无 confirmed）。"""
    lo1, hi1 = era_bounds(a['era_start'], a['era_end'], a.get('era_uncertainty'))
    lo2, hi2 = era_bounds(b['era_start'], b['era_end'], b.get('era_uncertainty'))
    if None in (lo1, hi1, lo2, hi2):
        return {'relation': 'unknown', 'note': '年代数据不完整，无法比较。'}
    if hi1 < lo2 or hi2 < lo1:
        return {'relation': 'disjoint', 'note': '年代区间（含不确定度）不相交。'}
    return {'relation': 'overlap_possible', 'note': DISCLAIMER}
