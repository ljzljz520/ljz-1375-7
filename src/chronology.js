'use strict';
// 年代：区间 + 不确定度。区间相交不表示同代确证。

function effectiveRange(row) {
  const u = row.uncertainty_years || 0;
  return { start: row.date_start - u, end: row.date_end + u, uncertainty: u };
}

function rangesOverlap(a, b) {
  return a.start <= b.end && b.start <= a.end;
}

// 比较两件展品的年代关系。无论是否相交，都不输出“同代确证”。
function compareChronology(a, b) {
  const ra = effectiveRange(a);
  const rb = effectiveRange(b);
  const overlap = rangesOverlap(ra, rb);
  return {
    overlap,
    same_era_confirmed: false, // 区间相交 ≠ 同代确证，恒为 false
    explanation: overlap
      ? '两件展品年代区间（含不确定度）存在相交；区间相交不表示同代确证，需结合地层与测年证据另行论证。'
      : '两件展品年代区间（含不确定度）不相交。',
    ranges: { a: ra, b: rb },
  };
}

function formatRange(row) {
  if (row.date_start == null || row.date_end == null) return '年代不详';
  const u = row.uncertainty_years || 0;
  const base = row.date_start === row.date_end
    ? `${row.date_start} 年`
    : `${row.date_start}—${row.date_end} 年`;
  return u > 0 ? `${base}（±${u} 年）` : base;
}

module.exports = { effectiveRange, rangesOverlap, compareChronology, formatRange };
