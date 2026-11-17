// =========================================================================
// [MODUL TERISOLASI: PUSH NOTIFICATION ENGINE (AUTO-INITIALIZE)]
// Lokasi File: services/pushNotification.js
// Fungsi:
// 1. OTOMATIS membuat tabel SQLite jika baru pertama kali dipasang
// 2. OTOMATIS membuat kunci VAPID jika settings.json masih kosong
// 3. Mengelola pengiriman notifikasi ke HP Android secara terenkripsi
// =========================================================================

const path = require('path');
const fs = require('fs');
const webpush = require('web-push');
const Database = require('better-sqlite3');

// 1. Inisialisasi Koneksi Database SQLite
const dbPath = path.join(__dirname, '..', 'database', 'billing.db');
const db = new Database(dbPath);

// [PERUBAHAN 1: MIGRASI TABEL UNTUK DUKUNGAN MULTI-ROLE DALAM 1 HP]
// Fungsi: Mengizinkan 1 browser/HP terdaftar ke banyak role (admin, tech, customer)
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS push_subscriptions_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role TEXT NOT NULL,
      user_id TEXT,
      endpoint TEXT NOT NULL,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(endpoint, role)
    );
    INSERT OR IGNORE INTO push_subscriptions_new (id, role, user_id, endpoint, p256dh, auth, created_at)
    SELECT id, role, user_id, endpoint, p256dh, auth, created_at FROM push_subscriptions;
    DROP TABLE IF EXISTS push_subscriptions;
    ALTER TABLE push_subscriptions_new RENAME TO push_subscriptions;
  `);
} catch (e) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role TEXT NOT NULL,
      user_id TEXT,
      endpoint TEXT NOT NULL,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(endpoint, role)
    );
  `);
}
// ===================== AKHIR PERUBAHAN 1 ==================================

// 2. Inisialisasi Kunci VAPID dari settings.json
const settingsPath = path.join(__dirname, '..', 'settings.json');
let settings = {};
try {
  if (fs.existsSync(settingsPath)) {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8') || '{}');
  }
} catch (e) {
  console.error('[WebPush] Gagal membaca settings.json:', e.message);
}

// [FITUR AUTO-INIT 2: OTOMATIS GENERATE KUNCI VAPID JIKA BELUM ADA]
if (!settings.vapid_public_key || !settings.vapid_private_key) {
  const generatedKeys = webpush.generateVAPIDKeys();
  settings.vapid_public_key = generatedKeys.publicKey;
  settings.vapid_private_key = generatedKeys.privateKey;
  try {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
    console.log('[WebPush] VAPID Keys baru berhasil dibuat otomatis.');
  } catch (err) {
    console.error('[WebPush] Gagal menyimpan VAPID keys otomatis:', err.message);
  }
}

const vapidPublicKey = settings.vapid_public_key || '';
const vapidPrivateKey = settings.vapid_private_key || '';

if (vapidPublicKey && vapidPrivateKey) {
  webpush.setVapidDetails(
    'mailto:admin@' + (settings.domain || 'ikdmp.yan-wrt.my.id'),
    vapidPublicKey,
    vapidPrivateKey
  );
}

// [PERUBAHAN 2: FUNGSI SAVESUBSCRIPTION DENGAN ON CONFLICT(endpoint, role)]
// Fungsi: Menyimpan token perangkat tanpa menimpa role lain di HP yang sama
function saveSubscription(role, userId, subscription) {
  if (!subscription || !subscription.endpoint || !subscription.keys) {
    throw new Error('Format subscription tidak valid');
  }

  const endpoint = subscription.endpoint;
  const p256dh = subscription.keys.p256dh;
  const auth = subscription.keys.auth;
  const uid = userId ? String(userId) : null;

  const stmt = db.prepare(`
    INSERT INTO push_subscriptions (role, user_id, endpoint, p256dh, auth)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(endpoint, role) DO UPDATE SET
      user_id = excluded.user_id,
      p256dh = excluded.p256dh,
      auth = excluded.auth,
      created_at = CURRENT_TIMESTAMP
  `);

  return stmt.run(role, uid, endpoint, p256dh, auth);
}
// -------------------------------------------------------------------------

// [FUNGSI 2: HAPUS TOKEN PERANGKAT USANG]
function deleteSubscription(endpoint) {
  const stmt = db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?');
  return stmt.run(endpoint);
}
// -------------------------------------------------------------------------

// [FUNGSI 3: KIRIM PUSH NOTIFIKASI KE SEMUA HP BERDASARKAN PERAN (ROLE)]
async function sendPushToRole(role, payload) {
  const rows = db.prepare('SELECT * FROM push_subscriptions WHERE role = ?').all(role);
  if (!rows || rows.length === 0) return { success: 0, failed: 0 };

  const jsonPayload = JSON.stringify({
    title: payload.title || 'IKDMP Notifikasi',
    body: payload.body || '',
    icon: payload.icon || '/img/pwa-icon.svg',
    badge: '/img/logo.png',
    url: payload.url || '/',
    tag: payload.tag || 'general-notif',
    vibrate: [200, 100, 200]
  });

  let success = 0;
  let failed = 0;

  const promises = rows.map(async (row) => {
    const pushSub = {
      endpoint: row.endpoint,
      keys: {
        p256dh: row.p256dh,
        auth: row.auth
      }
    };

    try {
      await webpush.sendNotification(pushSub, jsonPayload);
      success++;
    } catch (err) {
      failed++;
      if (err.statusCode === 410 || err.statusCode === 404) {
        deleteSubscription(row.endpoint);
      }
    }
  });

  await Promise.all(promises);
  return { success, failed };
}
// -------------------------------------------------------------------------

// [FUNGSI 4: KIRIM PUSH NOTIFIKASI KE PENGGUNA SPESIFIK]
async function sendPushToUser(role, userId, payload) {
  const rows = db.prepare('SELECT * FROM push_subscriptions WHERE role = ? AND user_id = ?').all(role, String(userId));
  if (!rows || rows.length === 0) return { success: 0, failed: 0 };

  const jsonPayload = JSON.stringify({
    title: payload.title || 'IKDMP Notifikasi',
    body: payload.body || '',
    icon: payload.icon || '/img/pwa-icon.svg',
    badge: '/img/logo.png',
    url: payload.url || '/',
    tag: payload.tag || 'personal-notif',
    vibrate: [200, 100, 200]
  });

  let success = 0;
  let failed = 0;

  const promises = rows.map(async (row) => {
    const pushSub = {
      endpoint: row.endpoint,
      keys: {
        p256dh: row.p256dh,
        auth: row.auth
      }
    };

    try {
      await webpush.sendNotification(pushSub, jsonPayload);
      success++;
    } catch (err) {
      failed++;
      if (err.statusCode === 410 || err.statusCode === 404) {
        deleteSubscription(row.endpoint);
      }
    }
  });

  await Promise.all(promises);
  return { success, failed };
}

module.exports = {
  vapidPublicKey,
  saveSubscription,
  deleteSubscription,
  sendPushToRole,
  sendPushToUser
};