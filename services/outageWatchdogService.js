/**
 * ──────────────────────────────────────────────────────────────────────────────
 * Service: Smart Outage Watchdog (Deteksi Gangguan Massal & Kabel Putus)
 * ──────────────────────────────────────────────────────────────────────────────
 * Memantau klaster ODP & Area secara proaktif:
 * - Mendeteksi jika >= 3 pelanggan di ODP/Area yang sama offline serentak.
 * - Mengirimkan peringatan dini kabel putus / mati lampu PLN ke Telegram Admin & Soundbox.
 * - Otomatis mendeteksi pemulihan (recovery) saat jalur kembali online.
 */

'use strict';

const db = require('../config/database');
const { logger } = require('../config/logger');
const { getSetting } = require('../config/settingsManager');

// Status pelacakan outage per ODP (In-Memory State)
const activeOutages = new Map(); // odpId -> { detectedAt, offlineCount, totalCount, odpName, alertedAt }
const recoveryAlertDebounce = new Map();

class OutageWatchdogService {

  /**
   * Pindai semua ODP dan Area untuk mendeteksi anomali pemutusan massal
   */
  async scanNetworkOutages(options = {}) {
    const isManual = options.isManual || false;
    const summary = {
      scannedOdps: 0,
      activeIncidents: [],
      recoveredIncidents: [],
      timestamp: new Date().toISOString()
    };

    try {
      const isEnabled = getSetting('outage_watchdog_enabled', true);
      if (!isManual && (isEnabled === false || isEnabled === 'false')) {
        return summary;
      }

      // 1. Ambil data sesi PPPoE aktif dari MikroTik
      const mt = require('./mikrotikService');
      const activePppoeMap = await mt.getActivePppoeSessionsMap().catch(() => new Map());

      // 2. Ambil data inform ACS devices
      const acsDevs = db.prepare(`SELECT serial_number, last_inform FROM acs_devices`).all() || [];
      const acsInformMap = new Map();
      const nowMs = Date.now();
      const acsOnlineThresholdMs = 15 * 60 * 1000;

      for (const a of acsDevs) {
        if (!a.serial_number) continue;
        const lastMs = a.last_inform ? new Date(a.last_inform).getTime() : 0;
        const isOnline = (nowMs - lastMs) <= acsOnlineThresholdMs;
        acsInformMap.set(a.serial_number.toUpperCase(), isOnline);
      }

      /* ========================================================================= */
/* [AWAL]: FILTER BYPASS ODP & ABAIKAN PELANGGAN HOTSPOT                     */
/* Fungsi: Lewati ODP yang di-ignore & hanya cek pelanggan kabel (PPPoE/ACS) */
/* ========================================================================= */
      // 3. Ambil daftar ODP aktif & daftar ODP yang di-bypass/ignore dari setting
      const odps = db.prepare(`SELECT id, name, description FROM odps`).all() || [];
      const ignoredOdpsRaw = String(getSetting('outage_ignored_odps', '') || '');
      // Format setting berupa teks pisah koma, misal: "ODP-01, ODP-PASAR, 5, 12"
      const ignoredOdpList = ignoredOdpsRaw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

      for (const odp of odps) {
        const odpKey = `odp_${odp.id}`;
        const odpNameLower = String(odp.name || '').trim().toLowerCase();
        const odpIdStr = String(odp.id);

        // A. Cek apakah ODP ini ada di daftar BYPASS / PENGECUALIAN
        if (ignoredOdpList.includes(odpNameLower) || ignoredOdpList.includes(odpIdStr)) {
          // Hapus status jika sebelumnya pernah tercatat outage agar alert bersih
          if (activeOutages.has(odpKey)) activeOutages.delete(odpKey);
          continue; // Lewati pemindaian ODP ini!
        }

        summary.scannedOdps++;

        // B. Ambil pelanggan aktif di ODP ini
        // PENTING: Hanya ambil pelanggan kabel (PPPoE / ada ACS Tag). 
        // Abaikan pelanggan bertipe 'hotspot' agar tidak memicu alarm palsu.
        const customers = db.prepare(`
          SELECT id, name, phone, address, pppoe_username, genieacs_tag, connection_type
          FROM customers
          WHERE odp_id = ? 
            AND status = 'active'
            AND (connection_type IS NULL OR LOWER(connection_type) != 'hotspot')
        `).all(odp.id) || [];

        if (customers.length < 3) {
          // Klaster kabel terlalu kecil untuk deteksi statistik massal (< 3 pelanggan)
          continue;
        }
/* ========================================================================= */
/* [AKHIR]: FILTER BYPASS ODP & ABAIKAN PELANGGAN HOTSPOT                    */
/* ========================================================================= */

        const offlineCustomers = [];
        const onlineCustomers = [];

        for (const c of customers) {
          let isOnline = false;

          // Cek PPPoE session
          if (c.pppoe_username && activePppoeMap.has(c.pppoe_username.toLowerCase())) {
            isOnline = true;
          }

          // Cek ACS session jika ada serial number
          if (!isOnline && c.genieacs_tag) {
            const acsStatus = acsInformMap.get(c.genieacs_tag.toUpperCase());
            if (acsStatus === true) isOnline = true;
          }

          if (isOnline) {
            onlineCustomers.push(c);
          } else {
            offlineCustomers.push(c);
          }
        }

        const totalCount = customers.length;
        const offlineCount = offlineCustomers.length;
        const offlinePercent = Math.round((offlineCount / totalCount) * 100);

        // Ambang batas gangguan massal:
        // Minimal 3 pelanggan offline DAN minimal 50% dari total pelanggan di ODP tersebut offline
        const isOutage = offlineCount >= 3 && offlinePercent >= 50;

        if (isOutage) {
          const incident = {
            odpId: odp.id,
            odpName: odp.name,
            totalCount,
            offlineCount,
            offlinePercent,
            offlineCustomers: offlineCustomers.map(c => ({ id: c.id, name: c.name, phone: c.phone || '-' }))
          };
          summary.activeIncidents.push(incident);

          // Cek debounce notifikasi (maksimal 1 alert per 45 menit untuk ODP yang sama)
          const existing = activeOutages.get(odpKey);
          const lastAlertMs = existing ? existing.alertedAt : 0;

          if (!existing || (nowMs - lastAlertMs > 45 * 60 * 1000)) {
            activeOutages.set(odpKey, {
              detectedAt: existing ? existing.detectedAt : nowMs,
              alertedAt: nowMs,
              odpName: odp.name,
              offlineCount,
              totalCount
            });

            logger.warn(`[OutageWatchdog] Terdeteksi gangguan massal di ODP ${odp.name}: ${offlineCount}/${totalCount} offline.`);
            await this._notifyOutage(incident);
          }
        } else {
          // Jika sebelumnya ODP ini tercatat outage dan sekarang sudah pulih (>= 75% online)
          if (activeOutages.has(odpKey)) {
            const prev = activeOutages.get(odpKey);
            if (offlinePercent <= 25) {
              activeOutages.delete(odpKey);
              summary.recoveredIncidents.push({
                odpId: odp.id,
                odpName: odp.name,
                totalCount,
                onlineCount: onlineCustomers.length
              });

              logger.info(`[OutageWatchdog] ODP ${odp.name} telah pulih normal (${onlineCustomers.length}/${totalCount} online).`);
              await this._notifyRecovery(odp.name, onlineCustomers.length, totalCount);
            }
          }
        }
      }
    } catch (err) {
      logger.error(`[OutageWatchdog] Error pemindaian outage: ${err.message}`);
    }

    return summary;
  }

  /**
   * Kirim notifikasi darurat gangguan massal ke Telegram & Soundbox
   */
  async _notifyOutage(inc) {
    try {
      const namesList = inc.offlineCustomers.slice(0, 8).map(c => `• ${c.name}`).join('\n');
      const moreStr = inc.offlineCustomers.length > 8 ? `\n• _...dan ${inc.offlineCustomers.length - 8} pelanggan lainnya_` : '';

      const msg = 
        `🚨 *PERINGATAN GANGGUAN MASSAL (POTENSI KABEL PUTUS / MATI LISTRIK)*\n\n` +
        `Sistem mendeteksi pemutusan serentak di titik distribusi jaringan:\n\n` +
        `📍 *Titik Distribusi:* *${inc.odpName}*\n` +
        `👥 *Pelanggan Terdampak:* *${inc.offlineCount} dari ${inc.totalCount} Pelanggan (${inc.offlinePercent}% OFFLINE)*\n` +
        `⏱️ *Waktu Deteksi:* ${new Date().toLocaleString('id-ID')}\n\n` +
        `📋 *Daftar Pelanggan Offline:*\n${namesList}${moreStr}\n\n` +
        `🔍 *Analisis AI:* Karena pemutusan terjadi serentak pada ODP yang sama, kemungkinan besar *kabel feeder/distribusi ODP putus*, atau terjadi *pemadaman listrik PLN lokal* di area tersebut.\n\n` +
        `_💡 Sistem akan otomatis mengirim notifikasi pemulihan saat pelanggan kembali online._`;

      /* ========================================================================= */
/* [AWAL]: NOTIFIKASI GANGGUAN ODP (TELEGRAM, WHATSAPP & SOUNDBOX CONDITIONAL)*/
/* Fungsi: Memeriksa saklar Telegram, WA, dan Soundbox sebelum mengirim pesan*/
/* ========================================================================= */
      // 1. Cek Saklar Notifikasi Telegram
      const tgEnabled = String(getSetting('outage_telegram_notif_enabled', 'true')) === 'true';
      if (tgEnabled) {
        try {
          const { sendAdminMessage } = require('./telegramBot');
          if (typeof sendAdminMessage === 'function') {
            await sendAdminMessage(msg);
          }
        } catch (tgErr) {
          logger.warn(`[OutageWatchdog] Gagal kirim Telegram: ${tgErr.message}`);
        }
      }

      // 2. Cek Saklar Notifikasi WhatsApp Admin
      const waEnabled = String(getSetting('outage_wa_notif_enabled', 'true')) === 'true';
      if (waEnabled) {
        try {
          const adminPhone = getSetting('admin_phone') || getSetting('company_phone');
          if (adminPhone) {
            const { sendWA, whatsappStatus } = await import('./whatsappBot.mjs');
            if (whatsappStatus && whatsappStatus.connection === 'open') {
              await sendWA(adminPhone, msg);
            }
          }
        } catch (waErr) {
          logger.warn(`[OutageWatchdog] Gagal kirim WA: ${waErr.message}`);
        }
      }

      // 3. Cek Saklar Voice Alert Soundbox Kasir
      const soundboxEnabled = String(getSetting('soundbox_outage_alert_enabled', 'true')) === 'true';
      if (soundboxEnabled) {
        try {
          const soundboxSvc = require('./soundboxService');
          soundboxSvc.queueSoundboxEvent({
            type: 'security_alert',
            title: 'Peringatan Gangguan Massal',
            speechText: `Peringatan darurat! Terdeteksi potensi kabel putus atau pemadaman listrik di area ODP ${inc.odpName}. ${inc.offlineCount} pelanggan terputus serentak.`,
            amount: 0,
            customerName: inc.odpName
          });
        } catch (_) {}
      }
/* ========================================================================= */
/* [AKHIR]: NOTIFIKASI GANGGUAN ODP                                          */
/* ========================================================================= */

      // Catat ke Audit Trail
      this._recordAudit({
        action: 'MASS_OUTAGE_DETECTED',
        entity_type: 'network_odp',
        entity_id: `ODP-${inc.odpId}`,
        details: {
          odpName: inc.odpName,
          offlineCount: inc.offlineCount,
          totalCount: inc.totalCount,
          offlinePercent: inc.offlinePercent
        }
      });
    } catch (e) {
      logger.warn(`[OutageWatchdog] Gagal kirim notifikasi outage: ${e.message}`);
    }
  }

  /**
   * Kirim notifikasi pemulihan jalur ke Telegram & Soundbox
   */
  async _notifyRecovery(odpName, onlineCount, totalCount) {
    try {
      const msg = 
        `✅ *PEMBERITAHUAN JALUR KEMBALI NORMAL (RECOVERED)*\n\n` +
        `Jalur transmisi pada *${odpName}* telah pulih:\n\n` +
        `🟢 *Status:* Normal & Terhubung Kembali\n` +
        `👥 *Pelanggan Online:* *${onlineCount} dari ${totalCount} Pelanggan*\n` +
        `⏱️ *Waktu Pulih:* ${new Date().toLocaleString('id-ID')}\n\n` +
        `_Jaringan beroperasi normal kembali._`;

      const { sendAdminMessage } = require('./telegramBot');
      if (typeof sendAdminMessage === 'function') {
        await sendAdminMessage(msg);
      }

      try {
        const soundboxSvc = require('./soundboxService');
        soundboxSvc.queueSoundboxEvent({
          type: 'network_recovery',
          title: 'Jalur Kembali Normal',
          speechText: `Kabar baik. Jalur distribusi pada ODP ${odpName} telah pulih dan beroperasi normal kembali.`,
          amount: 0,
          customerName: odpName
        });
      } catch (_) {}

      this._recordAudit({
        action: 'MASS_OUTAGE_RECOVERED',
        entity_type: 'network_odp',
        entity_id: odpName,
        details: { odpName, onlineCount, totalCount }
      });
    } catch (_) {}
  }

  /**
   * Ambil ringkasan status outage aktif untuk ditampilkan ke AI
   */
  async getOutageStatusReport() {
    const scan = await this.scanNetworkOutages({ isManual: true });
    let out = `📡 *STATUS JARINGAN & ANALISIS GANGGUAN JALUR (ODP / KABEL):*\n\n`;
    out += `• Total ODP Dipindai: *${scan.scannedOdps} ODP*\n`;

    if (scan.activeIncidents.length === 0) {
      out += `• Status Gangguan Massal: *✅ AMAN (Tidak terdeteksi pemadaman massal atau kabel putus)*\n`;
      out += `\n_💡 Seluruh klaster ODP berjalan normal. Jika ada pelanggan offline, itu merupakan gangguan individual (mati adaptor/perangkat dimatikan)._`;
    } else {
      out += `• 🚨 *GANGGUAN MASSAL TERDETEKSI:* *${scan.activeIncidents.length} ODP Mengalami Masalah*\n\n`;
      scan.activeIncidents.forEach((inc, idx) => {
        out += `${idx + 1}. *${inc.odpName}*\n`;
        out += `   - Terdampak: *${inc.offlineCount} dari ${inc.totalCount} pelanggan (${inc.offlinePercent}% offline)*\n`;
        out += `   - Indikasi: *Kabel feeder/distribusi ODP putus atau mati lampu wilayah*\n`;
        out += `   - Contoh Pelanggan: ${inc.offlineCustomers.slice(0, 3).map(c => c.name).join(', ')}\n\n`;
      });
      out += `_Saran Tindakan: Kirim teknisi untuk inspeksi fisik ke tiang ODP tersebut atau pastikan PLN area sekitar tidak padam._`;
    }

    return out;
  }

  _recordAudit(data) {
    try {
      db.prepare(`
        INSERT INTO audit_trail (action, entity_type, entity_id, details, created_at)
        VALUES (?, ?, ?, ?, datetime('now', 'localtime'))
      `).run(
        data.action,
        data.entity_type,
        data.entity_id,
        typeof data.details === 'object' ? JSON.stringify(data.details) : String(data.details || '')
      );
    } catch (_) {}
  }
}

module.exports = new OutageWatchdogService();