/**
 * Service: CRUD Pelanggan & Paket
 */
const db = require('../config/database');
const { logger } = require('../config/logger');
const { getCurrentDateInTimezone, getSetting } = require('../config/settingsManager');

// ─── HELPER FUNCTIONS ─────────────────────────────────────────
/**
 * Get effective router_id for a customer
 * Respects multi-router mode setting:
 * - If mode is 'active': returns customer's router_id if set.
 *   For legacy single-router customers with NULL router_id, it falls back to
 *   explicit default_router_id or the only active router (if exactly one exists).
 * - If mode is 'disabled': returns customer's router_id if set, else auto-detect
 *   - First tries explicit default_router_id setting
 *   - If not set, auto-detects first (smallest ID) available router
 */
function getEffectiveRouterId(customerRouterId) {
  const mode = getSetting('multi_router_mode', 'disabled');

  if (customerRouterId && customerRouterId > 0) {
    return customerRouterId;
  }

  const explicitDefault = getSetting('default_router_id', null);
  if (explicitDefault) {
    const parsed = parseInt(explicitDefault, 10);
    if (parsed && parsed > 0) {
      return parsed;
    }
  }

  try {
    if (mode === 'active') {
      // In multi-router mode, only fall back automatically if there is exactly one active router.
      const routers = db.prepare('SELECT id FROM routers WHERE is_active = 1 ORDER BY id ASC LIMIT 2').all();
      if (routers.length === 1 && routers[0].id > 0) {
        logger.warn(`[getEffectiveRouterId] router_id pelanggan kosong saat multi-router aktif. Fallback ke satu-satunya router aktif: ${routers[0].id}`);
        return routers[0].id;
      }
      return null;
    }

    // Mode: disabled (single router with fallback) - auto-detect first active router
    const router = db.prepare('SELECT id FROM routers WHERE is_active = 1 ORDER BY id ASC LIMIT 1').get();
    if (router && router.id > 0) {
      return router.id;
    }
  }

  catch (e) {
    // Ignore if routers table doesn't exist or query fails
  }

  return null;
}

// ─── CUSTOMERS ───────────────────────────────────────────────
function calculateExpiredAt(startDateStr, durationDays = 30) {
  const d = startDateStr ? new Date(startDateStr) : new Date();
  if (isNaN(d.getTime())) return null;
  d.setDate(d.getDate() + (parseInt(durationDays, 10) || 30));
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day} 23:59:59`;
}

function getAllCustomers(search = '', routerId = null, filterStatus = '', filterArea = '', filterSite = '') {
  const now = getCurrentDateInTimezone();
  const month = now.getMonth() + 1;
  const year = now.getFullYear();

  const base = `
    SELECT c.*, p.name as package_name, p.price as package_price,
           p.billing_type as package_billing_type, p.duration_days as package_duration_days,
           p.promo_cycles as package_promo_cycles,
           p.prorate_first_invoice as package_prorate_first_invoice,
           p.speed_down, p.speed_up, p.fup_limit_gb, p.use_fup,
           r.name as router_name,
           o.name as olt_name,
           odp.name as odp_name,
           (SELECT COUNT(*) FROM invoices WHERE customer_id=c.id AND status='unpaid') as unpaid_count,
           u.bytes_in, u.bytes_out
    FROM customers c
    LEFT JOIN packages p ON c.package_id = p.id
    LEFT JOIN routers r ON c.router_id = r.id
    LEFT JOIN olts o ON c.olt_id = o.id
    LEFT JOIN odps odp ON c.odp_id = odp.id
    LEFT JOIN customer_usage u ON u.customer_id = c.id AND u.period_month = ${month} AND u.period_year = ${year}
  `;

  const whereClauses = [];
  const params = [];

  if (search) {
    const s = `%${search}%`;
    whereClauses.push(`(c.name LIKE ? OR c.phone LIKE ? OR c.nik LIKE ? OR c.genieacs_tag LIKE ? OR c.address LIKE ? OR c.area LIKE ? OR c.pppoe_username LIKE ? OR c.static_ip LIKE ? OR c.hotspot_username LIKE ?)`);
    params.push(s, s, s, s, s, s, s, s, s);
  }

  const rId = routerId ? Number(routerId) : null;
  if (rId && rId > 0) {
    whereClauses.push(`c.router_id = ?`);
    params.push(rId);
  }

  if (filterStatus) {
    whereClauses.push(`c.status = ?`);
    params.push(filterStatus);
  }

  if (filterArea) {
    whereClauses.push(`LOWER(TRIM(c.area)) = LOWER(TRIM(?))`);
    params.push(filterArea);
  }
  
  if (filterSite) {
    whereClauses.push(`c.site = ?`);
    params.push(filterSite);
  }

  const whereSql = whereClauses.length > 0 ? ` WHERE ` + whereClauses.join(' AND ') : '';
  return db.prepare(base + whereSql + ` ORDER BY c.name ASC`).all(...params);
}

function getAllCustomerAreas() {
  try {
    const hasCustArea = db.prepare("PRAGMA table_info(customers)").all().some(c => c.name === 'area');
    const hasColArea = db.prepare("PRAGMA table_info(collectors)").all().some(c => c.name === 'area');
    const hasTechArea = db.prepare("PRAGMA table_info(technicians)").all().some(c => c.name === 'area');

    const queries = [];
    if (hasCustArea) queries.push("SELECT area FROM customers WHERE area IS NOT NULL AND TRIM(area) != ''");
    if (hasColArea) queries.push("SELECT area FROM collectors WHERE area IS NOT NULL AND TRIM(area) != ''");
    if (hasTechArea) queries.push("SELECT area FROM technicians WHERE area IS NOT NULL AND TRIM(area) != ''");

    if (queries.length === 0) return [];

    const unionSql = `SELECT DISTINCT TRIM(area) as area FROM (` + queries.join(' UNION ') + `) ORDER BY area ASC`;
    const rows = db.prepare(unionSql).all();
    return rows.map(r => r.area).filter(Boolean);
  } catch (e) {
    logger.warn('[CustomerService] getAllCustomerAreas error:', e.message);
    return [];
  }
}

function resetPromoCyclesUsed(customerId) {
  const id = Number(customerId);
  if (!Number.isFinite(id) || id <= 0) throw new Error('ID pelanggan tidak valid');
  return db.prepare('UPDATE customers SET promo_cycles_used = 0 WHERE id=?').run(id);
}

function getCustomerById(id) {
  return db.prepare(`
    SELECT c.*, p.name as package_name, p.price as package_price,
           p.billing_type as package_billing_type, p.duration_days as package_duration_days,
           p.promo_cycles as package_promo_cycles,
           p.prorate_first_invoice as package_prorate_first_invoice,
           r.name as router_name, o.name as olt_name, odp.name as odp_name
    FROM customers c 
    LEFT JOIN packages p ON c.package_id = p.id 
    LEFT JOIN routers r ON c.router_id = r.id
    LEFT JOIN olts o ON c.olt_id = o.id
    LEFT JOIN odps odp ON c.odp_id = odp.id
    WHERE c.id = ?
  `).get(id);
}

function createCustomer(data) {
  let expiredAt = data.expired_at || null;
  if (!expiredAt && data.package_id) {
    const pkg = db.prepare('SELECT billing_type, duration_days FROM packages WHERE id=?').get(data.package_id);
    if (pkg && pkg.billing_type === 'prepaid') {
      const baseDate = data.install_date || new Date().toISOString().slice(0, 10);
      expiredAt = calculateExpiredAt(baseDate, pkg.duration_days || 30);
    }
  }

  return db.prepare(`
    INSERT INTO customers (nik, name, phone, email, address, area, package_id, router_id, olt_id, odp_id, pon_port, lat, lng, genieacs_tag, pppoe_username, pppoe_password, pppoe_remote_address, isolir_profile, status, install_date, expired_at, notes, auto_isolate, isolate_day, connection_type, static_ip, mac_address, hotspot_username, hotspot_password, hotspot_profile, collector_id, is_radius, site)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    data.nik ? String(data.nik).trim() : '',
    data.name, data.phone || '', data.email || '', data.address || '',
    data.area ? String(data.area).trim() : '',
    data.package_id ? parseInt(data.package_id) : null,
    data.router_id ? parseInt(data.router_id) : null,
    data.olt_id ? parseInt(data.olt_id) : null,
    data.odp_id ? parseInt(data.odp_id) : null,
    data.pon_port || '',
    data.lat || '',
    data.lng || '',
    data.genieacs_tag || '', data.pppoe_username || '',
    data.pppoe_password || '',
    data.pppoe_remote_address || '',
    data.isolir_profile || 'isolir',
    data.status || 'active',
    data.install_date || null,
    expiredAt,
    data.notes || '',
    data.auto_isolate !== undefined ? parseInt(data.auto_isolate) : 1,
    data.isolate_day !== undefined ? parseInt(data.isolate_day) : 10,
    data.connection_type || 'pppoe',
    data.static_ip || '',
    data.mac_address || '',
    data.hotspot_username || '',
    data.hotspot_password || '',
    data.hotspot_profile || '',
    data.collector_id ? parseInt(data.collector_id) : null,
    data.is_radius !== undefined ? parseInt(data.is_radius) : 1,
    data.site || 'site-1'
  );
}


//UPDATE/EDIT DATA PELANGGAN
function updateCustomer(id, data) {
  const prev = db.prepare('SELECT package_id, expired_at, install_date, cable_path, site FROM customers WHERE id=?').get(id);
  const newPkgId = data.package_id ? parseInt(data.package_id, 10) : null;
  const pkgChanged = prev && Number(prev.package_id || 0) !== Number(newPkgId || 0);

  let expiredAt = data.expired_at !== undefined ? data.expired_at : (prev ? prev.expired_at : null);
  if (!expiredAt && newPkgId) {
    const pkg = db.prepare('SELECT billing_type, duration_days FROM packages WHERE id=?').get(newPkgId);
    if (pkg && pkg.billing_type === 'prepaid') {
      const baseDate = data.install_date || (prev ? prev.install_date : null) || new Date().toISOString().slice(0, 10);
      expiredAt = calculateExpiredAt(baseDate, pkg.duration_days || 30);
    }
  }

  // Pertahankan jalur kabel lama jika form edit tidak menyertakan data cable_path baru
  const finalCablePath = data.cable_path !== undefined ? data.cable_path : (prev ? prev.cable_path : null);

  const result = db.prepare(`
    UPDATE customers SET nik=?, name=?, phone=?, email=?, address=?, area=?, package_id=?, router_id=?, olt_id=?, odp_id=?, pon_port=?, lat=?, lng=?, genieacs_tag=?, pppoe_username=?, pppoe_password=?, pppoe_remote_address=?, isolir_profile=?, status=?, install_date=?, expired_at=?, notes=?, auto_isolate=?, isolate_day=?, cable_path=?, connection_type=?, static_ip=?, mac_address=?, hotspot_username=?, hotspot_password=?, hotspot_profile=?, collector_id=?, is_radius=?, site=?
    WHERE id=?
  `).run(
    data.nik !== undefined ? (data.nik ? String(data.nik).trim() : '') : (prev ? prev.nik : ''),
    data.name, data.phone || '', data.email || '', data.address || '',
    data.area ? String(data.area).trim() : '',
    data.package_id ? parseInt(data.package_id) : null,
    data.router_id ? parseInt(data.router_id) : null,
    data.olt_id ? parseInt(data.olt_id) : null,
    data.odp_id ? parseInt(data.odp_id) : null,
    data.pon_port || '',
    data.lat || '',
    data.lng || '',
    data.genieacs_tag || '', data.pppoe_username || '',
    data.pppoe_password || '',
    data.pppoe_remote_address || '',
    data.isolir_profile || 'isolir',
    data.status || 'active',
    data.install_date || null,
    expiredAt,
    data.notes || '',
    data.auto_isolate !== undefined ? parseInt(data.auto_isolate) : 1,
    data.isolate_day !== undefined ? parseInt(data.isolate_day) : 10,
    finalCablePath, // 👈 Aman! Tidak akan ter-reset jadi null lagi
    data.connection_type || 'pppoe',
    data.static_ip || '',
    data.mac_address || '',
    data.hotspot_username || '',
    data.hotspot_password || '',
    data.hotspot_profile || '',
    data.collector_id ? parseInt(data.collector_id) : null,
    data.is_radius !== undefined ? parseInt(data.is_radius) : 1,
    data.site || (prev ? prev.site : 'site-1'),
    id
  );

  if (pkgChanged) {
    db.prepare('UPDATE customers SET promo_cycles_used = 0 WHERE id=?').run(id);
  }

  return result;
}
//AKHIR EDIT UPDATE PELANGGAN


function updateCustomerCablePath(id, path) {
  return db.prepare('UPDATE customers SET cable_path = ? WHERE id = ?').run(path, id);
}

async function deleteCustomer(id) {
  const customer = getCustomerById(id);
  const mikrotikSvc = require('./mikrotikService');
  
  // WARNING: Check if customer has MikroTik connections without router_id
  const hasMikrotikConnection = customer && (
    customer.connection_type === 'pppoe' && customer.pppoe_username
    || customer.connection_type === 'static' && customer.static_ip
    || customer.connection_type === 'hotspot' && customer.hotspot_username
  );
  
  if (hasMikrotikConnection && !customer.router_id) {
    logger.warn(`[deleteCustomer] Pelanggan "${customer.name}" (ID: ${id}) memiliki koneksi ${customer.connection_type} tapi router_id NULL. Akun tidak akan dihapus dari MikroTik.`);
  }
  
  // Remove static IP if connection type is static
  if (customer && customer.connection_type === 'static' && customer.static_ip && customer.router_id) {
    try {
      await mikrotikSvc.removeStaticIp(customer.static_ip, customer.router_id);
    } catch (e) {
      console.error('Failed to remove static IP from MikroTik during customer deletion:', e);
    }
  }
  
  // CATATAN: Sesuai permintaan, akun/secret PPPoE di MikroTik TIDAK dihapus saat pelanggan dihapus
  // agar data user PPPoE di MikroTik tetap aman dan tidak terhapus.
  if (customer && customer.connection_type === 'pppoe' && customer.pppoe_username) {
    logger.info(`[deleteCustomer] Pelanggan "${customer.name}" dihapus dari billing. Akun PPPoE "${customer.pppoe_username}" di MikroTik dipertahankan.`);
  }

  // Remove Hotspot user if connection type is hotspot and username exists
  if (customer && customer.connection_type === 'hotspot' && customer.hotspot_username && customer.router_id) {
    try {
      // Get hotspot user to find the ID
      const hotspotUser = await mikrotikSvc.getHotspotUserByName(customer.hotspot_username, customer.router_id);
      
      if (hotspotUser && hotspotUser.id) {
        await mikrotikSvc.deleteHotspotUser(hotspotUser.id, customer.router_id);
        console.log(`Successfully removed Hotspot user ${customer.hotspot_username} from MikroTik`);
      } else {
        console.warn(`Hotspot user ${customer.hotspot_username} not found in MikroTik`);
      }
    } catch (e) {
      console.error('Failed to remove Hotspot user from MikroTik during customer deletion:', e);
    }
  }
  
  return db.prepare('DELETE FROM customers WHERE id=?').run(id);
}

async function bulkDeleteCustomers(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return 0;
  let deleted = 0;
  for (const id of ids) {
    const numId = Number(id);
    if (!Number.isFinite(numId) || numId <= 0) continue;
    try {
      await deleteCustomer(numId);
      deleted++;
    } catch (e) {
      logger.error(`[bulkDeleteCustomers] Gagal menghapus pelanggan ${numId}: ${e.message}`);
    }
  }
  return deleted;
}

function getCustomerStats(filterSite = '') {
  const whereSite = filterSite ? " WHERE site = ? " : "";
  const andSite = filterSite ? " AND site = ? " : "";
  const params = filterSite ? [filterSite] : [];

  return {
    total:        db.prepare(`SELECT COUNT(*) as c FROM customers ${whereSite}`).get(...params)?.c || 0,
    active:       db.prepare(`SELECT COUNT(*) as c FROM customers WHERE status IN ('active', 'ditangguhkan') ${andSite}`).get(...params)?.c || 0,
    ditangguhkan: db.prepare(`SELECT COUNT(*) as c FROM customers WHERE status='ditangguhkan' ${andSite}`).get(...params)?.c || 0,
    suspended:    db.prepare(`SELECT COUNT(*) as c FROM customers WHERE status='suspended' ${andSite}`).get(...params)?.c || 0,
    inactive:     db.prepare(`SELECT COUNT(*) as c FROM customers WHERE status='inactive' ${andSite}`).get(...params)?.c || 0,
  };
}

// Auto-migrasi kolom baru agar tabel packages mendukung profil MikroTik, router, & tipe layanan
try { db.prepare("ALTER TABLE packages ADD COLUMN mikrotik_profile TEXT").run(); } catch(e) {}
try { db.prepare("ALTER TABLE packages ADD COLUMN service_type TEXT DEFAULT 'pppoe'").run(); } catch(e) {}
try { db.prepare("ALTER TABLE packages ADD COLUMN router_id INTEGER").run(); } catch(e) {}

// ─── PACKAGES ────────────────────────────────────────────────
function getAllPackages(routerId = null) {
  const rId = routerId ? Number(routerId) : null;
  try {
    if (rId && rId > 0) {
      return db.prepare(`
        SELECT p.*, r.name as router_name, COUNT(c.id) as customer_count
        FROM packages p 
        LEFT JOIN customers c ON c.package_id = p.id
        LEFT JOIN routers r ON p.router_id = r.id
        WHERE p.router_id IS NULL OR p.router_id = ?
        GROUP BY p.id ORDER BY p.price ASC
      `).all(rId);
    }
    return db.prepare(`
      SELECT p.*, r.name as router_name, COUNT(c.id) as customer_count
      FROM packages p 
      LEFT JOIN customers c ON c.package_id = p.id
      LEFT JOIN routers r ON p.router_id = r.id
      GROUP BY p.id ORDER BY p.price ASC
    `).all();
  } catch (e) {
    if (String(e?.message || '').includes('no such column')) {
      return db.prepare(`
        SELECT p.*, NULL as router_name, COUNT(c.id) as customer_count
        FROM packages p 
        LEFT JOIN customers c ON c.package_id = p.id
        GROUP BY p.id ORDER BY p.price ASC
      `).all();
    }
    throw e;
  }
}

function getPackageById(id) {
  return db.prepare('SELECT * FROM packages WHERE id=?').get(id);
}


// ==================== AWAL PERBAIKAN: CRUD PAKET BEBAS NAMA & PROFILE MIKROTIK ====================
function createPackage(data) {
  // Hitung kecepatan dalam Kbps jika input dari form berupa Mbps (angka < 1000)
  const parseSpeed = (val) => {
    const num = parseFloat(val || 0);
    if (!num || isNaN(num)) return 0;
    return num < 1000 ? Math.round(num * 1000) : Math.round(num);
  };

  const down = parseSpeed(data.speed_down);
  const up = parseSpeed(data.speed_up);
  const down_upto = parseSpeed(data.speed_down_upto);
  const up_upto = parseSpeed(data.speed_up_upto);
  const n_down = parseSpeed(data.night_speed_down);
  const n_up = parseSpeed(data.night_speed_up);
  const f_down = parseSpeed(data.fup_speed_down);
  const f_limit = parseFloat(data.fup_limit_gb || 0);

  const promoPrice = parsePromoPrice(data.promo_price);
  const promoCycles = Math.max(0, parseInt(data.promo_cycles, 10) || 0);
  const prorateFirst = data.prorate_first_invoice ? 1 : 0;
  const usePpn = data.use_ppn ? 1 : 0;
  const ppnPercentage = parseFloat(data.ppn_percentage || 11.0);
  const useUso = data.use_uso ? 1 : 0;
  const usoPercentage = parseFloat(data.uso_percentage || 1.75);
  const routerId = data.router_id ? parseInt(data.router_id, 10) : null;
  const serviceType = data.service_type || 'pppoe';
  const billingType = (data.billing_type === 'prepaid') ? 'prepaid' : 'postpaid';
  const durationDays = Math.max(1, parseInt(data.duration_days, 10) || 30);
  
  // 1. mikrotik_profile = Profile ASLI di MikroTik (Contoh: "1 Device", "default")
  const mikrotikProfile = data.mikrotik_profile ? String(data.mikrotik_profile).trim() : (data.name || '').trim();
  // 2. name = Nama Tampilan BEBAS (Contoh: "1 Device - Rp 40.000", "Paket Kost A")
  const displayName = data.name ? String(data.name).trim() : mikrotikProfile;

  return db.prepare(`
    INSERT INTO packages (
      name, mikrotik_profile, price, promo_price, promo_cycles, prorate_first_invoice,
      speed_down, speed_up, speed_down_upto, speed_up_upto,
      use_night_speed, night_profile_name, night_speed_down, night_speed_up, 
      use_fup, fup_profile_name, fup_limit_gb, fup_speed_down, 
      description,
      billing_type, duration_days,
      use_ppn, ppn_percentage, use_uso, uso_percentage, router_id, service_type
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    displayName, mikrotikProfile, parseInt(data.price) || 0, promoPrice, promoCycles, prorateFirst,
    down, up, down_upto, up_upto,
    data.use_night_speed ? 1 : 0, data.night_profile_name || null, n_down, n_up,
    data.use_fup ? 1 : 0, data.fup_profile_name || null, f_limit, f_down,
    data.description || '',
    billingType, durationDays,
    usePpn, ppnPercentage, useUso, usoPercentage, routerId, serviceType
  );
}

function updatePackage(id, data) {
  const parseSpeed = (val) => {
    const num = parseFloat(val || 0);
    if (!num || isNaN(num)) return 0;
    return num < 1000 ? Math.round(num * 1000) : Math.round(num);
  };

  const down = parseSpeed(data.speed_down);
  const up = parseSpeed(data.speed_up);
  const down_upto = parseSpeed(data.speed_down_upto);
  const up_upto = parseSpeed(data.speed_up_upto);
  const n_down = parseSpeed(data.night_speed_down);
  const n_up = parseSpeed(data.night_speed_up);
  const f_down = parseSpeed(data.fup_speed_down);
  const f_limit = parseFloat(data.fup_limit_gb || 0);
  const promoPrice = parsePromoPrice(data.promo_price);
  const promoCycles = Math.max(0, parseInt(data.promo_cycles, 10) || 0);
  const prorateFirst = data.prorate_first_invoice ? 1 : 0;
  const usePpn = data.use_ppn ? 1 : 0;
  const ppnPercentage = parseFloat(data.ppn_percentage || 11.0);
  const useUso = data.use_uso ? 1 : 0;
  const usoPercentage = parseFloat(data.uso_percentage || 1.75);
  const routerId = data.router_id ? parseInt(data.router_id, 10) : null;
  const serviceType = data.service_type || 'pppoe';
  const billingType = (data.billing_type === 'prepaid') ? 'prepaid' : 'postpaid';
  const durationDays = Math.max(1, parseInt(data.duration_days, 10) || 30);
  
  // Ambil data lama sebagai cadangan jika ada field yang tidak dikirim form
  const oldPkg = db.prepare('SELECT name, mikrotik_profile FROM packages WHERE id=?').get(id);

  // Profile asli MikroTik
  const mikrotikProfile = data.mikrotik_profile ? String(data.mikrotik_profile).trim() : (oldPkg ? oldPkg.mikrotik_profile : (data.name || '').trim());
  // Nama custom tampilan bebas
  const displayName = data.name ? String(data.name).trim() : (oldPkg ? oldPkg.name : mikrotikProfile);

  return db.prepare(`
    UPDATE packages 
    SET name=?, mikrotik_profile=?, price=?, promo_price=?, promo_cycles=?, prorate_first_invoice=?,
        speed_down=?, speed_up=?, speed_down_upto=?, speed_up_upto=?,
        use_night_speed=?, night_profile_name=?, night_speed_down=?, night_speed_up=?, 
        use_fup=?, fup_profile_name=?, fup_limit_gb=?, fup_speed_down=?, 
        description=?, is_active=?,
        billing_type=?, duration_days=?,
        use_ppn=?, ppn_percentage=?, use_uso=?, uso_percentage=?, router_id=?, service_type=?
    WHERE id=?
  `).run(
    displayName, mikrotikProfile, parseInt(data.price) || 0, promoPrice, promoCycles, prorateFirst,
    down, up, down_upto, up_upto,
    data.use_night_speed ? 1 : 0, data.night_profile_name || null, n_down, n_up,
    data.use_fup ? 1 : 0, data.fup_profile_name || null, f_limit, f_down,
    data.description || '', data.is_active == '1' ? 1 : 0,
    billingType, durationDays,
    usePpn, ppnPercentage, useUso, usoPercentage, routerId, serviceType,
    id
  );
}
// ==================== AKHIR PERBAIKAN: CRUD PAKET BEBAS NAMA & PROFILE MIKROTIK ====================

function parsePromoPrice(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}


function deletePackage(id) {
  return db.prepare('DELETE FROM packages WHERE id=?').run(id);
}

function findCustomerByAny(val) {
  if (!val) return null;
  const cleanVal = val.toString().trim();
  
  // 1. Try Phone (Priority for Login)
  const phoneDigits = cleanVal.replace(/\D/g, '');
  if (phoneDigits.length >= 8) {
    // Cari yang 8-10 digit terakhirnya sama (lebih akurat untuk 08 vs 62)
    const suffix = phoneDigits.slice(-9);
    const p1 = db.prepare('SELECT id FROM customers WHERE phone LIKE ?').get(`%${suffix}`);
    if (p1) return getCustomerById(p1.id);
  }

  // 2. Try GenieACS Tag (Exact Match)
  const byTag = db.prepare('SELECT id FROM customers WHERE genieacs_tag = ?').get(cleanVal);
  if (byTag) return getCustomerById(byTag.id);

  // 3. Try PPPoE Username (Exact Match)
  const byPppoe = db.prepare('SELECT id FROM customers WHERE pppoe_username = ?').get(cleanVal);
  if (byPppoe) return getCustomerById(byPppoe.id);

  // 4. Try MAC Address (Exact Match or Partial Match for ONU MAC format)
  // Handle ONU MAC format like: F4B5AA-ZXHN%20F477-01FFFFFFFF011FFF23F4B5AA7D806FBA
  const byMac = db.prepare('SELECT id FROM customers WHERE mac_address = ?').get(cleanVal);
  if (byMac) return getCustomerById(byMac.id);
  
  // Try partial MAC match (first part before dash for ONU format)
  if (cleanVal.includes('-')) {
    const macPrefix = cleanVal.split('-')[0];
    if (macPrefix.length >= 6) {
      const byMacPrefix = db.prepare('SELECT id FROM customers WHERE mac_address LIKE ?').get(`${macPrefix}%`);
      if (byMacPrefix) return getCustomerById(byMacPrefix.id);
    }
  }

  // 5. Try ID if numeric
  if (/^\d+$/.test(cleanVal) && cleanVal.length < 8) {
    const c = getCustomerById(parseInt(cleanVal));
    if (c) return c;
  }
  
  return null;
}

// ==================== AWAL PERBAIKAN: ISOLIR DENGAN HITUNG TELAT HARI & BUKA ISOLIR KE PAKET ASLI ====================

/**
 * Helper: Menghitung berapa hari pelanggan menunggak / telat bayar.
 * Menghitung selisih hari antara hari ini dengan tanggal jatuh tempo (isolate_day) dari tagihan tertua yang belum dibayar.
 */
function calculateCustomerLateDays(customerId) {
  try {
    const cust = db.prepare('SELECT isolate_day FROM customers WHERE id = ?').get(customerId);
    const oldestUnpaid = db.prepare(`
      SELECT period_month, period_year 
      FROM invoices 
      WHERE customer_id = ? AND status = 'unpaid' 
      ORDER BY period_year ASC, period_month ASC 
      LIMIT 1
    `).get(customerId);

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    if (!oldestUnpaid) {
      return 1; // Default 1 hari jika diisolir manual tanpa tagihan tercatat
    }

    const isoDay = Math.max(1, Math.min(28, Number(cust?.isolate_day || 10)));
    const dueDate = new Date(oldestUnpaid.period_year, oldestUnpaid.period_month - 1, isoDay);

    const diffTime = today.getTime() - dueDate.getTime();
    const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
    return Math.max(1, diffDays);
  } catch (e) {
    return 1;
  }
}

/**
 * Fungsi: Mengisolir pelanggan.
 * 1. Mengubah profile PPPoE ke 'isolir'
 * 2. Mengubah comment secret di MikroTik menjadi: [ISOLIR - Telat X Hari] Nama - NoHP
 * 3. Menendang sesi aktif agar langsung terputus dan dial ulang masuk isolir
 */
async function suspendCustomer(id) {
  const customer = getCustomerById(id);
  if (!customer) throw new Error('Pelanggan tidak ditemukan');
  
  const mikrotikSvc = require('./mikrotikService');
  const effectiveRouterId = getEffectiveRouterId(customer.router_id);

  const hasMikrotikConnection = customer.connection_type === 'pppoe' && customer.pppoe_username
    || customer.connection_type === 'static' && customer.static_ip
    || customer.connection_type === 'hotspot' && customer.hotspot_username;
  
  if (hasMikrotikConnection && !effectiveRouterId) {
    logger.warn(`[suspendCustomer] Pelanggan "${customer.name}" (ID: ${id}) memiliki koneksi ${customer.connection_type} tapi router_id NULL. Hanya isolir lokal.`);
    updateCustomer(id, { ...customer, status: 'suspended' });
    return;
  }

  // Hitung jumlah hari telat & buat comment khusus
  const lateDays = calculateCustomerLateDays(id);
  const cleanPhone = customer.phone ? ` - ${customer.phone}` : '';
  const isolirComment = `[ISOLIR - Telat ${lateDays} Hari] ${customer.name}${cleanPhone}`;

  try {
    if (customer.connection_type === 'static' && customer.static_ip) {
      const pkg = getPackageById(customer.package_id);
      let limit = '5M/5M';
      if (pkg) {
        const up = Number(pkg.speed_up || 0) || 0;
        const down = Number(pkg.speed_down || 0) || 0;
        const upMbps = up > 0 ? Math.max(1, Math.round(up / 1000)) : 5;
        const downMbps = down > 0 ? Math.max(1, Math.round(down / 1000)) : 5;
        limit = `${upMbps}M/${downMbps}M`;
      }
      await mikrotikSvc.manageStaticIp({
        ip: customer.static_ip,
        name: isolirComment,
        limit: limit,
        isolate: true
      }, effectiveRouterId);
    } else if (customer.pppoe_username) {
      const isolirProfile = customer.isolir_profile || 'isolir';
      // Ubah profile ke isolir + update comment telat + kick sesi
      await mikrotikSvc.setPppoeProfile(customer.pppoe_username, isolirProfile, effectiveRouterId, isolirComment);
      
      if (effectiveRouterId) {
        try {
          await mikrotikSvc.ensurePppProfileIsolirAddressListHook(isolirProfile, effectiveRouterId);
        } catch (e) {
          logger.warn(`[suspendCustomer] Hook profil isolir "${isolirProfile}" di router ${effectiveRouterId}: ${e.message}`);
        }
      }
	  
    } else if (customer.connection_type === 'hotspot' || customer.connection_type === 'static') {
      // 1. Jika ada username hotspot, disable user dan kick aktifnya
      if (customer.hotspot_username) {
        try {
          await mikrotikSvc.setHotspotUserDisabled(customer.hotspot_username, true, effectiveRouterId);
          logger.info(`[suspendCustomer] Hotspot user "${customer.hotspot_username}" berhasil di-disable & di-kick.`);
        } catch (hsErr) {
          logger.warn(`[suspendCustomer] Gagal disable hotspot user: ${hsErr.message}`);
        }
      }

      // 2. Jika pelanggan di-binding (Static IP / MAC Address), disable baris IP-Binding-nya di MikroTik
      const targetBindingIp = customer.static_ip ? String(customer.static_ip).trim() : '';
      const targetBindingMac = customer.mac_address ? String(customer.mac_address).trim() : '';

      if (targetBindingIp) {
        await mikrotikSvc.setHotspotIpBindingDisabled(targetBindingIp, true, effectiveRouterId);
      }
      if (targetBindingMac && targetBindingMac !== targetBindingIp) {
        await mikrotikSvc.setHotspotIpBindingDisabled(targetBindingMac, true, effectiveRouterId);
      }
    }
	
	
  } catch (mikrotikErr) {
    logger.error(`[suspendCustomer] GAGAL ubah profil di MikroTik: ${mikrotikErr.message}. Tetap update status ke database.`);
  }

  // Update status pelanggan di database menjadi 'suspended'
  updateCustomer(id, { ...customer, status: 'suspended' });

  // Notifikasi WhatsApp jika dicentang di pengaturan
  const isIsolirNotifEnabled = db.getAppSetting('whatsapp_isolir_notif_enabled', '0') === '1';
  if (isIsolirNotifEnabled && customer.phone) {
    try {
      const { getSetting } = require('../config/settingsManager');
      if (getSetting('whatsapp_enabled', false)) {
        const { sendWA, whatsappStatus } = await import('./whatsappBot.mjs');
        if (whatsappStatus && whatsappStatus.connection === 'open') {
          const defaultIsolir = `Yth. Pelanggan {{nama}},\n\nLayanan internet Anda (Paket {{paket}}) saat ini ditangguhkan (Terisolir) karena belum melunasi tagihan sebesar *Rp {{tagihan}}*.\n\nSilakan lakukan pembayaran segera melalui portal pelanggan: {{link}}\n\nTerima kasih.`;
          const template = db.getAppSetting('whatsapp_isolir_message', defaultIsolir);

          const billingSvc = require('./billingService');
          const { formatUnpaidInvoicesSummary } = require('./whatsappService');
          const unpaidInvoices = billingSvc.getUnpaidInvoicesByCustomerId(customer.id);
          const summary = formatUnpaidInvoicesSummary(unpaidInvoices);
          const totalTagihan = summary.totalAmount;
          const displayPeriode = summary.isMultiple
            ? `${summary.periodText}\n\n📋 *Rincian Tunggakan:*\n${summary.breakdownText}`
            : summary.periodText;

          const explicitBaseUrl = String(getSetting('public_base_url', '') || '').trim();
          let baseUrl = explicitBaseUrl.replace(/\/+$/, '');
          if (!baseUrl) {
            const hostRaw = String(getSetting('server_host', 'localhost') || 'localhost').trim();
            const port = Number(getSetting('server_port', 3001) || 3001);
            const proto = port === 443 ? 'https' : 'http';
            const host = /^https?:\/\//i.test(hostRaw) ? hostRaw.replace(/\/+$/, '') : `${proto}://${hostRaw}`;
            baseUrl = (port === 80 || port === 443) ? host : `${host}:${port}`;
          }
          const loginLink = `${baseUrl}/customer/login`;

          let formattedMsg = template
            .replace(/{{nama}}/gi, customer.name || 'Pelanggan')
            .replace(/{{paket}}/gi, customer.package_name || '-')
            .replace(/{{tagihan}}/gi, summary.totalAmountStr || totalTagihan.toLocaleString('id-ID'))
            .replace(/{{rincian_detail}}/gi, summary.isMultiple ? `📋 *Rincian Tunggakan:*\n${summary.breakdownText}` : '')
            .replace(/{{rincian}}/gi, displayPeriode || '-')
            .replace(/{{periode}}/gi, displayPeriode || '-')
            .replace(/{{link}}/gi, loginLink);

          await sendWA(customer.phone, formattedMsg);
          logger.info(`[suspendCustomer] Notifikasi WhatsApp isolir terkirim ke ${customer.name} (${customer.phone})`);
        }
      }
    } catch (waErr) {
      logger.error(`[suspendCustomer] Gagal kirim notif WhatsApp isolir: ${waErr.message}`);
    }
  }

  return true;
}

function _handleUnsuspendInvoice(id, customer, wasSuspended, targetStatus) {
  if (wasSuspended && (targetStatus === 'active' || targetStatus === 'ditangguhkan') && customer.package_id) {
    try {
      const now = new Date();
      const curMonth = now.getMonth() + 1;
      const curYear = now.getFullYear();
      const existingCurInv = db.prepare('SELECT id FROM invoices WHERE customer_id = ? AND period_month = ? AND period_year = ? LIMIT 1').get(id, curMonth, curYear);
      if (!existingCurInv) {
        const billingSvc = require('./billingService');
        billingSvc.generateInvoiceForCustomer(id, curMonth, curYear);
        logger.info(`[activateCustomer] Pelanggan "${customer.name}" (ID: ${id}) dibuka dari isolir (status: ${targetStatus}). Tagihan periode berjalan ${curMonth}/${curYear} otomatis diterbitkan.`);
      }
    } catch (invErr) {
      logger.error(`[activateCustomer] Gagal generate tagihan periode berjalan untuk pelanggan "${customer.name}" (ID: ${id}): ${invErr.message}`);
    }
  }
}

/**
 * Fungsi: Mengaktifkan kembali pelanggan (Buka Isolir / Pembayaran Lunas).
 * 1. Mengembalikan profile PPPoE ke nama paket aslinya yang terdaftar di master packages
 * 2. Membersihkan comment secret di MikroTik menjadi normal: Nama - NoHP
 * 3. Menendang sesi aktif agar pelanggan langsung dial ulang dan mendapatkan profil paket normal
 */
async function activateCustomer(id, targetStatus = 'active') {
  const customer = getCustomerById(id);
  if (!customer) throw new Error('Pelanggan tidak ditemukan');
  
  const wasSuspended = (customer.status === 'suspended' || customer.status === 'isolated');
  const effectiveRouterId = getEffectiveRouterId(customer.router_id);

  const hasMikrotikConnection = customer.connection_type === 'pppoe' && customer.pppoe_username
    || customer.connection_type === 'static' && customer.static_ip
    || customer.connection_type === 'hotspot' && customer.hotspot_username;
  
  if (hasMikrotikConnection && !effectiveRouterId) {
    logger.warn(`[activateCustomer] Pelanggan "${customer.name}" (ID: ${id}) memiliki koneksi ${customer.connection_type} tapi router_id NULL. Aktivasi lokal saja.`);
    updateCustomer(id, { ...customer, status: targetStatus });
    _handleUnsuspendInvoice(id, customer, wasSuspended, targetStatus);
    return;
  }

  const mikrotikSvc = require('./mikrotikService');

  // Bersihkan komentar kembali ke format normal tanpa embel-embel [ISOLIR ...]
  const cleanPhone = customer.phone ? ` - ${customer.phone}` : '';
  const normalComment = `${customer.name}${cleanPhone}`;

  try {
    if (customer.connection_type === 'static' && customer.static_ip) {
      const pkg = getPackageById(customer.package_id);
      let limit = '5M/5M';
      if (pkg) {
        const up = Number(pkg.speed_up || 0) || 0;
        const down = Number(pkg.speed_down || 0) || 0;
        const upMbps = up > 0 ? Math.max(1, Math.round(up / 1000)) : 5;
        const downMbps = down > 0 ? Math.max(1, Math.round(down / 1000)) : 5;
        limit = `${upMbps}M/${downMbps}M`;
      }
      await mikrotikSvc.manageStaticIp({
        ip: customer.static_ip,
        name: normalComment,
        limit: limit,
        isolate: false
      }, effectiveRouterId);
    // ==================== AWAL PERBAIKAN: SMART RESOLVER PROFILE MULTI-ROUTER ====================
    } else if (customer.pppoe_username) {
      let targetProfile = '';
      let candidateNames = [];

      if (customer.package_id) {
        const pkg = getPackageById(customer.package_id);
        if (pkg) {
          // Kumpulkan semua kemungkinan nama profile dari paket ini
          if (pkg.mikrotik_profile) candidateNames.push(String(pkg.mikrotik_profile).trim());
          if (pkg.name) candidateNames.push(String(pkg.name).trim());
          
          // Tambahkan kandidat berdasarkan kecepatan Mbps (misal: 10M, 10Mbps)
          const downMbps = pkg.speed_down ? Math.round(Number(pkg.speed_down) / 1000) : 0;
          if (downMbps > 0) {
            candidateNames.push(`${downMbps}M`);
            candidateNames.push(`${downMbps}Mbps`);
            candidateNames.push(`Paket ${downMbps} Mbps`);
            candidateNames.push(`Paket ${downMbps}M`);
          }
        }
      }

      try {
        // Ambil daftar profile yang BENAR-BENAR ADA di router tempat pelanggan ini terhubung
        const routerProfiles = await mikrotikSvc.getPppoeProfiles(effectiveRouterId);
        const availableNames = (routerProfiles || []).map(p => String(p.name || '').trim()).filter(Boolean);

        logger.info(`[activateCustomer] Profile yang tersedia di Router ID ${effectiveRouterId}: [${availableNames.join(', ')}]`);
        logger.info(`[activateCustomer] Kandidat nama profile paket pelanggan: [${candidateNames.join(', ')}]`);

        // 1. Coba cocokkan kandidat nama secara persis atau case-insensitive
        for (const candidate of candidateNames) {
          const match = availableNames.find(p => p.toLowerCase() === candidate.toLowerCase());
          if (match) {
            targetProfile = match;
            break;
          }
        }

        // 2. Jika belum ketemu, cari profile yang mengandung salah satu kata kunci nama paket (selain isolir/default)
        if (!targetProfile) {
          for (const candidate of candidateNames) {
            const cleanCandidate = candidate.toLowerCase().replace(/[^a-z0-9]/g, '');
            const match = availableNames.find(p => {
              const cleanP = p.toLowerCase().replace(/[^a-z0-9]/g, '');
              return cleanP.length > 2 && (cleanP.includes(cleanCandidate) || cleanCandidate.includes(cleanP)) && !cleanP.includes('isolir');
            });
            if (match) {
              targetProfile = match;
              break;
            }
          }
        }

        // 3. Jika masih belum cocok, pilih profile aktif selain isolir / default jika ada
        if (!targetProfile) {
          const nonIsolir = availableNames.find(p => !p.toLowerCase().includes('isolir') && !p.toLowerCase().includes('default'));
          if (nonIsolir) {
            targetProfile = nonIsolir;
            logger.warn(`[activateCustomer] Tidak ada nama yang persis cocok, memilih profile non-isolir pertama: "${targetProfile}"`);
          } else {
            targetProfile = availableNames.includes('default') ? 'default' : (availableNames[0] || 'default');
          }
        }
      } catch (profErr) {
        logger.warn(`[activateCustomer] Gagal mengambil profile dari Router ID ${effectiveRouterId}: ${profErr.message}`);
        targetProfile = candidateNames[0] || 'default';
      }

      // Update profile PPPoE kembali ke paket yang berhasil dicocokkan + comment + kick
      await mikrotikSvc.setPppoeProfile(customer.pppoe_username, targetProfile, effectiveRouterId, normalComment);
      logger.info(`[activateCustomer] PPPoE "${customer.pppoe_username}" BERHASIL diset ke profile: [${targetProfile}] di Router ID ${effectiveRouterId}`);
// ==================== AKHIR PERBAIKAN: SMART RESOLVER PROFILE MULTI-ROUTER ====================

    } else if (customer.connection_type === 'hotspot' || customer.connection_type === 'static') {
      // 1. Jika ada username hotspot, aktifkan kembali (disabled = false)
      if (customer.hotspot_username) {
        try {
          const pkg = getPackageById(customer.package_id);
          const targetProfile = String(customer.hotspot_profile || '').trim() || (pkg ? pkg.name : '');
          await mikrotikSvc.upsertHotspotUser({
            username: String(customer.hotspot_username || '').trim(),
            password: String(customer.hotspot_password || '').trim(),
            profile: targetProfile,
            macAddress: String(customer.mac_address || '').trim(),
            disabled: false
          }, effectiveRouterId);
          logger.info(`[activateCustomer] Hotspot user "${customer.hotspot_username}" berhasil diaktifkan kembali.`);
        } catch (hsActErr) {
          logger.warn(`[activateCustomer] Gagal aktivasi hotspot user: ${hsActErr.message}`);
        }
      }

      // 2. Jika pelanggan di-binding (Static IP / MAC Address), aktifkan kembali baris IP-Binding-nya di MikroTik
      const targetBindingIp = customer.static_ip ? String(customer.static_ip).trim() : '';
      const targetBindingMac = customer.mac_address ? String(customer.mac_address).trim() : '';

      if (targetBindingIp) {
        await mikrotikSvc.setHotspotIpBindingDisabled(targetBindingIp, false, effectiveRouterId);
      }
      if (targetBindingMac && targetBindingMac !== targetBindingIp) {
        await mikrotikSvc.setHotspotIpBindingDisabled(targetBindingMac, false, effectiveRouterId);
      }
    }
	
  } catch (mikrotikErr) {
    logger.error(`[activateCustomer] GAGAL ubah profil di MikroTik: ${mikrotikErr.message}. Tetap update status ke database.`);
  }

  // Update status pelanggan di database
  updateCustomer(id, { ...customer, status: targetStatus });
  _handleUnsuspendInvoice(id, customer, wasSuspended, targetStatus);
  return true;
}
// ==================== AKHIR PERBAIKAN: ISOLIR DENGAN HITUNG TELAT HARI & BUKA ISOLIR KE PAKET ASLI ====================

/**
 * Top-up / Deposit or Adjust Customer Balance manually by Admin/Cashier
 * @param {number|string} customerId 
 * @param {number} amount - positive number
 * @param {string} note - memo or payment source
 * @param {string} actorName - admin or cashier name
 * @param {'add'|'deduct'} actionType - 'add' or 'deduct'
 * @param {boolean} sendWhatsApp - whether to send WA notification
 */
async function topupCustomerBalance(customerId, amount, note = '', actorName = 'Admin', actionType = 'add', sendWhatsApp = true) {
  const cid = Number(customerId);
  const amt = Math.abs(Number(amount) || 0);
  if (!cid || amt <= 0) {
    throw new Error('ID Pelanggan dan nominal valid wajib diisi.');
  }

  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(cid);
  if (!customer) {
    throw new Error('Pelanggan tidak ditemukan.');
  }

  const isDeduct = actionType === 'deduct';
  const delta = isDeduct ? -amt : amt;
  const before = Number(customer.balance || 0);
  const after = Math.max(0, before + delta);

  // Execute in SQLite transaction
  db.transaction(() => {
    db.prepare('UPDATE customers SET balance = ? WHERE id = ?').run(after, cid);

    const orderId = `MANUAL-${Date.now()}`;
    const desc = note ? note.trim() : (isDeduct ? `Penyesuaian/Pemotongan Saldo oleh ${actorName}` : `Deposit Manual oleh ${actorName}`);
    
    try {
      db.prepare(`
        INSERT INTO customer_topup_requests (
          customer_id, amount, payment_gateway, payment_order_id, payment_reference, payment_payload, status, paid_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'paid', (NOW_LOCAL()), (NOW_LOCAL()), (NOW_LOCAL()))
      `).run(
        cid,
        delta,
        'MANUAL_ADMIN',
        orderId,
        desc,
        JSON.stringify({ actorName, actionType, note: desc, before, after, timestamp: new Date().toISOString() })
      );
    } catch (tblErr) {
      logger.warn('[topupCustomerBalance] customer_topup_requests insert error: ' + tblErr.message);
    }
  })();

  // WhatsApp Notification
  if (sendWhatsApp && customer.phone) {
    try {
      const { getSettings } = require('../config/settingsManager');
      const settings = getSettings();
      if (settings.whatsapp_enabled) {
        const { sendWA, whatsappStatus } = await import('./whatsappBot.mjs');
        if (whatsappStatus.connection === 'open') {
          const waMsg = !isDeduct
            ? `✅ *DEPOSIT SALDO BERHASIL*\n\n` +
              `Halo *${customer.name}*,\n` +
              `Deposit saldo dompet Anda telah berhasil ditambahkan oleh pihak admin/kasir.\n\n` +
              `💰 *Nominal:* Rp ${amt.toLocaleString('id-ID')}\n` +
              `💳 *Total Saldo Sekarang:* Rp ${after.toLocaleString('id-ID')}\n` +
              `📝 *Keterangan:* ${note || 'Setor Tunai / Manual'}\n` +
              `👤 *Diterima oleh:* ${actorName}\n\n` +
              `Saldo dapat langsung digunakan untuk pembelian pulsa, paket data, voucher, atau token PLN di portal/aplikasi Alijaya. Terima kasih!`
            : `⚠️ *PENYESUAIAN SALDO DOMPET*\n\n` +
              `Halo *${customer.name}*,\n` +
              `Terdapat penyesuaian/pemotongan saldo dompet Anda oleh pihak admin.\n\n` +
              `🔻 *Nominal:* -Rp ${amt.toLocaleString('id-ID')}\n` +
              `💳 *Sisa Saldo:* Rp ${after.toLocaleString('id-ID')}\n` +
              `📝 *Keterangan:* ${note || 'Penyesuaian Saldo'}\n` +
              `👤 *Petugas:* ${actorName}`;

          await sendWA(customer.phone, waMsg);
        }
      }
    } catch (waErr) {
      logger.error('[topupCustomerBalance] WA notification error: ' + waErr.message);
    }
  }

  return {
    success: true,
    customerId: cid,
    customer,
    before,
    after,
    delta,
    actionType
  };
}

/**
 * Helper untuk membatasi query pelanggan berdasarkan wilayah tugas kolektor.
 * Jika kolektor sudah ditentukan wilayahnya (misal: "pegagan"):
 * - Kolektor HANYA bisa melihat pelanggan di wilayahnya sendiri.
 * - Tidak bisa melihat pelanggan di wilayah lain atau tanpa wilayah.
 * - Tidak bisa melihat pelanggan yang sudah secara spesifik ditugaskan ke kolektor lain.
 * Jika kolektor tidak ditentukan wilayahnya (kosong / "semua" / bebas):
 * - Kolektor bisa melihat semua pelanggan (kecuali yang ditugaskan ke kolektor lain).
 */
function getCollectorCustomerWhere(collector, tableAlias = 'c') {
  let col = collector;
  if (typeof collector === 'number' || typeof collector === 'string') {
    col = db.prepare('SELECT id, area FROM collectors WHERE id = ?').get(Number(collector));
  }
  const colId = Number(col?.id || col?.collectorId || 0);
  const rawArea = String(col?.area || '').trim();

  // Parsing area, dukung multi area dengan koma
  const areas = rawArea.split(',')
    .map(a => a.trim().toLowerCase())
    .filter(a => a.length > 0 && a !== 'semua' && a !== 'all');

  if (areas.length > 0) {
    const placeholders = areas.map(() => '?').join(', ');
    const where = `(LOWER(TRIM(${tableAlias}.area)) IN (${placeholders}) AND (${tableAlias}.collector_id = ? OR ${tableAlias}.collector_id IS NULL OR ${tableAlias}.collector_id = 0))`;
    const params = [...areas, colId];
    return { where, params, isRestricted: true, areas };
  } else {
    const where = `(${tableAlias}.collector_id = ? OR ${tableAlias}.collector_id IS NULL OR ${tableAlias}.collector_id = 0)`;
    const params = [colId];
    return { where, params, isRestricted: false, areas: [] };
  }
}

/**
 * Validasi apakah kolektor berhak mengakses data / transaksi seorang pelanggan.
 */
function canCollectorAccessCustomer(collector, customer) {
  if (!collector || !customer) return false;
  let col = collector;
  if (typeof collector === 'number' || typeof collector === 'string') {
    col = db.prepare('SELECT id, area FROM collectors WHERE id = ?').get(Number(collector));
  }
  const colId = Number(col?.id || col?.collectorId || 0);
  const custColId = Number(customer?.collector_id || 0);

  // Jika pelanggan secara spesifik ditugaskan ke kolektor lain, tolak
  if (custColId > 0 && custColId !== colId) {
    return false;
  }

  const rawArea = String(col?.area || '').trim();
  const areas = rawArea.split(',')
    .map(a => a.trim().toLowerCase())
    .filter(a => a.length > 0 && a !== 'semua' && a !== 'all');

  if (areas.length > 0) {
    const custArea = String(customer?.area || '').trim().toLowerCase();
    if (!custArea) return false;
    return areas.includes(custArea);
  }

  return true;
}

module.exports = {
  getAllCustomers, getAllCustomerAreas, getCustomerById, createCustomer, updateCustomer, deleteCustomer, bulkDeleteCustomers, getCustomerStats,
  getAllPackages, getPackageById, createPackage, updatePackage, deletePackage,
  suspendCustomer, activateCustomer, findCustomerByAny, updateCustomerCablePath,
  resetPromoCyclesUsed, getEffectiveRouterId, topupCustomerBalance,
  getCollectorCustomerWhere, canCollectorAccessCustomer
};

