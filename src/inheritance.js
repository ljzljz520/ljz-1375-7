'use strict';
// 继承关系：通用工艺卡（processes.card_body） vs 展品特定说明（exhibit_processes.local_note）。
// 展品特定说明是局部例外，优先于通用卡；更新通用卡绝不改写局部例外。

function effectiveProcessCards(db, exhibitId) {
  const links = db.prepare(`
    SELECT ep.process_id, ep.use_local, ep.local_note,
           p.name, p.summary, p.card_body, p.updated_at
    FROM exhibit_processes ep
    JOIN processes p ON p.id = ep.process_id
    WHERE ep.exhibit_id = ?
    ORDER BY p.id
  `).all(exhibitId);
  return links.map((l) => {
    const hasLocal = !!(l.use_local && l.local_note && l.local_note.trim());
    return {
      process_id: l.process_id,
      name: l.name,
      generic: { summary: l.summary, card_body: l.card_body, updated_at: l.updated_at },
      local_note: hasLocal ? l.local_note : null,
      effective_body: hasLocal ? l.local_note : l.card_body,
      source: hasLocal ? 'exhibit' : 'generic', // 生效来源：展品局部 / 通用卡
    };
  });
}

// 更新通用工艺卡：只写 processes 表，不触碰任何 exhibit_processes 局部例外。
function updateGenericCard(db, processId, { summary, card_body }) {
  db.prepare(`
    UPDATE processes SET summary = COALESCE(?, summary),
                         card_body = COALESCE(?, card_body),
                         updated_at = datetime('now')
    WHERE id = ?
  `).run(summary ?? null, card_body ?? null, processId);
  return db.prepare('SELECT * FROM processes WHERE id = ?').get(processId);
}

module.exports = { effectiveProcessCards, updateGenericCard };
