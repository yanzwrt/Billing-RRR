const db = require('../config/database');

function getAllTickets(status = null, filterSite = '') {
  let query = `
    SELECT t.*, 
           CASE WHEN t.customer_id IS NULL OR t.customer_id = 0 THEN 'Tugas Umum / Maintenance Admin' ELSE COALESCE(c.name, 'Pelanggan #' || t.customer_id) END as customer_name, 
           COALESCE(c.phone, '-') as customer_phone, 
           COALESCE(c.address, '-') as customer_address, 
           tech.name as technician_name
    FROM tickets t
    LEFT JOIN customers c ON (t.customer_id = c.id AND t.customer_id != 0)
    LEFT JOIN technicians tech ON t.technician_id = tech.id
  `;
  
  const whereClauses = [];
  const params = [];

  if (status && status !== 'all') {
    whereClauses.push('t.status = ?');
    params.push(status);
  }

  if (filterSite) {
    whereClauses.push('c.site = ?');
    params.push(filterSite);
  }

  if (whereClauses.length > 0) {
    query += ' WHERE ' + whereClauses.join(' AND ');
  }

  query += ` ORDER BY CASE WHEN t.status = 'open' THEN 1 WHEN t.status = 'in_progress' THEN 2 ELSE 3 END, t.created_at DESC`;
  return db.prepare(query).all(...params);
}

function getTicketsByCustomerId(customerId) {
  return db.prepare(`
    SELECT t.*, tech.name as technician_name
    FROM tickets t
    LEFT JOIN technicians tech ON t.technician_id = tech.id
    WHERE t.customer_id = ?
    ORDER BY t.created_at DESC
  `).all(customerId);
}

function getTicketById(id) {
  return db.prepare(`
    SELECT t.*, 
           CASE WHEN t.customer_id IS NULL OR t.customer_id = 0 THEN 'Tugas Umum / Maintenance Admin' ELSE COALESCE(c.name, 'Pelanggan #' || t.customer_id) END as customer_name, 
           COALESCE(c.phone, '-') as customer_phone, 
           COALESCE(c.address, '-') as customer_address, 
           tech.name as technician_name
    FROM tickets t
    LEFT JOIN customers c ON (t.customer_id = c.id AND t.customer_id != 0)
    LEFT JOIN technicians tech ON t.technician_id = tech.id
    WHERE t.id = ?
  `).get(id);
}

function createTicket(customerId, subject, message, extraData = {}) {
  const { customerPhotos, customerPhotoMetadata, technicianId, status } = extraData;
  const custId = (customerId && parseInt(customerId, 10) > 0) ? parseInt(customerId, 10) : 0;
  const techId = (technicianId && parseInt(technicianId, 10) > 0) ? parseInt(technicianId, 10) : null;
  const initialStatus = status || (techId ? 'in_progress' : 'open');
  
  return db.prepare(`
    INSERT INTO tickets (customer_id, subject, message, status, technician_id, customer_photos, customer_photo_metadata, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, (NOW_LOCAL()), (NOW_LOCAL()))
  `).run(
    custId,
    subject,
    message,
    initialStatus,
    techId,
    customerPhotos || '',
    customerPhotoMetadata || ''
  );
}

function updateTicketStatus(id, status, technicianId = undefined) {
  if (technicianId !== undefined) {
    const techId = (technicianId && parseInt(technicianId, 10) > 0) ? parseInt(technicianId, 10) : null;
    return db.prepare(`
      UPDATE tickets 
      SET status = ?, technician_id = ?, updated_at = (NOW_LOCAL())
      WHERE id = ?
    `).run(status, techId, id);
  } else {
    return db.prepare(`
      UPDATE tickets 
      SET status = ?, updated_at = (NOW_LOCAL())
      WHERE id = ?
    `).run(status, id);
  }
}

function deleteTicket(id) {
  return db.prepare('DELETE FROM tickets WHERE id = ?').run(id);
}

function getTicketStats(filterSite = '') {
  let siteJoin = "";
  let siteWhere = "";
  let params = [];

  if (filterSite) {
    siteJoin = " JOIN customers c ON tickets.customer_id = c.id ";
    siteWhere = " AND c.site = ? ";
    params.push(filterSite);
  }

  const open = db.prepare(`SELECT COUNT(*) as c FROM tickets ${siteJoin} WHERE status='open' ${siteWhere}`).get(...params)?.c || 0;
  const inProgress = db.prepare(`SELECT COUNT(*) as c FROM tickets ${siteJoin} WHERE status='in_progress' ${siteWhere}`).get(...params)?.c || 0;
  const resolved = db.prepare(`SELECT COUNT(*) as c FROM tickets ${siteJoin} WHERE status='resolved' ${siteWhere}`).get(...params)?.c || 0;
  return { open, inProgress, resolved, total: open + inProgress + resolved };
}

module.exports = {
  getAllTickets,
  getTicketsByCustomerId,
  getTicketById,
  createTicket,
  updateTicketStatus,
  deleteTicket,
  getTicketStats
};
