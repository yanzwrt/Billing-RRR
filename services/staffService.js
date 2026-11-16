const db = require('../config/database');

function getAllStaff() {
  return db.prepare('SELECT * FROM staff_users ORDER BY id DESC').all();
}

function getStaffById(id) {
  return db.prepare('SELECT * FROM staff_users WHERE id = ?').get(Number(id));
}

function authenticateStaff(username, password) {
  const staff = db.prepare('SELECT * FROM staff_users WHERE username = ? LIMIT 1').get(String(username).trim());
  if (staff && staff.password === String(password).trim()) {
    return staff;
  }
  return null;
}

function createStaff(data) {
  const name = String(data.name || '').trim();
  const username = String(data.username || '').trim();
  const password = String(data.password || '').trim();
  const site = String(data.site || 'site-1').trim();
  const canAdd = data.can_add_customer ? 1 : 0;
  const canEdit = data.can_edit_customer ? 1 : 0;
  const canDelete = data.can_delete_customer ? 1 : 0;

  if (!name || !username || !password) {
    throw new Error('Nama, Username, dan Password wajib diisi.');
  }

  const existing = db.prepare('SELECT id FROM staff_users WHERE username = ? LIMIT 1').get(username);
  if (existing) throw new Error('Username sudah digunakan oleh akun lain.');

  return db.prepare(`
    INSERT INTO staff_users (name, username, password, site, can_add_customer, can_edit_customer, can_delete_customer)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(name, username, password, site, canAdd, canEdit, canDelete);
}

function updateStaff(id, data) {
  const staffId = Number(id);
  const prev = getStaffById(staffId);
  if (!prev) throw new Error('Data staf tidak ditemukan.');

  const name = String(data.name || prev.name).trim();
  const password = data.password ? String(data.password).trim() : prev.password;
  const site = String(data.site || prev.site).trim();

  // FIX CHECKBOX: Jika dicentang maka bernilai 1, jika centang dilepas maka bernilai 0
  const canAdd = (data.can_add_customer === '1' || data.can_add_customer === 1 || data.can_add_customer === 'on' || data.can_add_customer === true) ? 1 : 0;
  const canEdit = (data.can_edit_customer === '1' || data.can_edit_customer === 1 || data.can_edit_customer === 'on' || data.can_edit_customer === true) ? 1 : 0;
  const canDelete = (data.can_delete_customer === '1' || data.can_delete_customer === 1 || data.can_delete_customer === 'on' || data.can_delete_customer === true) ? 1 : 0;

  return db.prepare(`
    UPDATE staff_users 
    SET name = ?, password = ?, site = ?, can_add_customer = ?, can_edit_customer = ?, can_delete_customer = ?
    WHERE id = ?
  `).run(name, password, site, canAdd, canEdit, canDelete, staffId);
}

function deleteStaff(id) {
  return db.prepare('DELETE FROM staff_users WHERE id = ?').run(Number(id));
}

module.exports = {
  getAllStaff,
  getStaffById,
  authenticateStaff,
  createStaff,
  updateStaff,
  deleteStaff
};