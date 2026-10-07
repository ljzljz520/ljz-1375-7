'use strict';
// 工坊预约：不做电商结算（无价格/支付字段）。
// 名额由服务端在 SQLite 事务内原子占用；候补 FIFO；取消释放名额并按序转正；
// 回执为服务端生成的随机码，页面凭回执查询真实状态，不做本地计数。
const crypto = require('crypto');

function newReceipt() {
  return crypto.randomBytes(9).toString('base64url'); // 12 位回执码
}

function logEvent(db, bookingId, workshopId, event) {
  db.prepare('INSERT INTO booking_events (booking_id, workshop_id, event) VALUES (?,?,?)')
    .run(bookingId, workshopId, event);
}

function renumberWaitlist(db, workshopId) {
  const rows = db.prepare(`
    SELECT id FROM bookings
    WHERE workshop_id = ? AND status = 'waitlist'
    ORDER BY waitlist_pos, id
  `).all(workshopId);
  const upd = db.prepare('UPDATE bookings SET waitlist_pos = ? WHERE id = ?');
  rows.forEach((r, i) => upd.run(i + 1, r.id));
}

function workshopCounts(db, workshopId) {
  const confirmed = db.prepare(
    "SELECT COUNT(*) AS c FROM bookings WHERE workshop_id = ? AND status = 'confirmed'"
  ).get(workshopId).c;
  const waiting = db.prepare(
    "SELECT COUNT(*) AS c FROM bookings WHERE workshop_id = ? AND status = 'waitlist'"
  ).get(workshopId).c;
  return { confirmed, waiting };
}

// 原子预约：事务内 检查名额→占用/候补，单连接同步执行，并发请求串行化
function book(db, workshopId, name, contact) {
  const tx = db.transaction(() => {
    const ws = db.prepare('SELECT * FROM workshops WHERE id = ?').get(workshopId);
    if (!ws) { const e = new Error('场次不存在'); e.status = 404; throw e; }
    if (!name || !contact) { const e = new Error('姓名与联系方式必填'); e.status = 400; throw e; }
    const { confirmed } = workshopCounts(db, workshopId);
    const receipt = newReceipt();
    let status = 'confirmed';
    let pos = null;
    if (confirmed >= ws.capacity) {
      status = 'waitlist';
      pos = (db.prepare(
        "SELECT COALESCE(MAX(waitlist_pos),0) AS p FROM bookings WHERE workshop_id = ? AND status = 'waitlist'"
      ).get(workshopId).p) + 1;
    }
    const id = db.prepare(`
      INSERT INTO bookings (workshop_id, name, contact, status, waitlist_pos, receipt_code)
      VALUES (?,?,?,?,?,?)
    `).run(workshopId, name, contact, status, pos, receipt).lastInsertRowid;
    logEvent(db, id, workshopId, status === 'confirmed' ? 'created_confirmed' : 'created_waitlist');
    return {
      id, workshop_id: workshopId, status, waitlist_pos: pos, receipt_code: receipt,
      counts: workshopCounts(db, workshopId), capacity: ws.capacity,
    };
  });
  return tx.immediate();
}

// 取消：释放名额；若有候补，队首原子转正。全程事件留痕，时序可查。
function cancel(db, receiptCode) {
  const tx = db.transaction(() => {
    const b = db.prepare('SELECT * FROM bookings WHERE receipt_code = ?').get(receiptCode);
    if (!b) { const e = new Error('回执无效'); e.status = 404; throw e; }
    if (b.status === 'cancelled') { const e = new Error('该预约已取消'); e.status = 409; throw e; }
    const wasConfirmed = b.status === 'confirmed';
    db.prepare("UPDATE bookings SET status = 'cancelled', waitlist_pos = NULL, updated_at = datetime('now') WHERE id = ?")
      .run(b.id);
    logEvent(db, b.id, b.workshop_id, 'cancelled');
    let promoted = null;
    if (wasConfirmed) {
      const next = db.prepare(`
        SELECT * FROM bookings WHERE workshop_id = ? AND status = 'waitlist'
        ORDER BY waitlist_pos, id LIMIT 1
      `).get(b.workshop_id);
      if (next) {
        db.prepare("UPDATE bookings SET status = 'confirmed', waitlist_pos = NULL, updated_at = datetime('now') WHERE id = ?")
          .run(next.id);
        logEvent(db, next.id, b.workshop_id, 'promoted');
        promoted = { id: next.id, receipt_code: next.receipt_code, name: next.name };
      }
    }
    renumberWaitlist(db, b.workshop_id);
    return { cancelled: b.id, promoted, counts: workshopCounts(db, b.workshop_id) };
  });
  return tx.immediate();
}

function getByReceipt(db, receiptCode) {
  const b = db.prepare(`
    SELECT b.id, b.workshop_id, b.name, b.status, b.waitlist_pos, b.receipt_code,
           b.created_at, b.updated_at, w.title AS workshop_title, w.starts_at, w.capacity
    FROM bookings b JOIN workshops w ON w.id = b.workshop_id
    WHERE b.receipt_code = ?
  `).get(receiptCode);
  if (!b) return null;
  return { ...b, counts: workshopCounts(db, b.workshop_id) };
}

// 回执丢失：凭联系方式（+可选场次）找回。只返回本人联系方式名下的回执。
function lookupByContact(db, contact, workshopId = null) {
  const sql = `
    SELECT b.receipt_code, b.status, b.waitlist_pos, b.workshop_id, w.title AS workshop_title, w.starts_at
    FROM bookings b JOIN workshops w ON w.id = b.workshop_id
    WHERE b.contact = ? AND b.status != 'cancelled'
    ${workshopId ? 'AND b.workshop_id = ?' : ''}
    ORDER BY b.id DESC
  `;
  return workshopId ? db.prepare(sql).all(contact, workshopId) : db.prepare(sql).all(contact);
}

function eventLog(db, workshopId) {
  return db.prepare(
    'SELECT * FROM booking_events WHERE workshop_id = ? ORDER BY id'
  ).all(workshopId);
}

module.exports = { book, cancel, getByReceipt, lookupByContact, workshopCounts, eventLog };
