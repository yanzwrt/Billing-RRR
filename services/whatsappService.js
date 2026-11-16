const { logger } = require('../config/logger');
const { getSetting } = require('../config/settingsManager');
const db = require('../config/database');
const metaWAService = require('./metaWhatsappService');
const fonnteWAService = require('./fonnteWhatsappService');

/**
 * Unified WhatsApp Gateway Service
 * Menangani routing pengiriman pesan baik via Baileys (Unofficial Socket), Fonnte API, maupun Meta Cloud API (Official Meta).
 */

/**
 * Kirim pesan WhatsApp universal
 * @param {string} toPhone Nomor HP tujuan
 * @param {string} messageText Teks pesan
 * @param {object} options Opsi tambahan: { templateName, parameters, langCode, url, filename }
 */
async function sendWhatsAppMessage(toPhone, messageText, options = {}) {
  const gatewayType = getSetting('wa_gateway_type', 'baileys'); // 'baileys', 'fonnte', or 'meta'

  if (gatewayType === 'fonnte') {
    // Mode FONNTE API GATEWAY (Cloud / Self-Hosted)
    const res = await fonnteWAService.sendFonnteMessage(toPhone, messageText, options);
    return res && res.success;
  } else if (gatewayType === 'meta') {
    // Mode META API RESMI
    if (options.templateName) {
      // Kirim via Meta Template Message
      return await metaWAService.sendMetaTemplateMessage(
        toPhone,
        options.templateName,
        options.langCode || 'id',
        options.parameters || []
      );
    } else {
      // Kirim via Meta Direct Text Message
      return await metaWAService.sendMetaTextMessage(toPhone, messageText);
    }
  } else {
    /* === AWAL PERUBAHAN: LOGGING OUTBOUND DENGAN PENYIMPANAN MESSAGE ID BAILEYS === */
    // Mode BAILEYS WEB (Default Socket)
    const { sendWA, whatsappStatus, resolveContactIdentity } = await import('./whatsappBot.mjs');

    if (!whatsappStatus || whatsappStatus.connection !== 'open') {
      throw new Error('Bot WhatsApp (Baileys) belum terhubung / offline. Silakan scan QR Code di menu /admin/whatsapp.');
    }

    const sendResult = await sendWA(toPhone, messageText, options);

    if (!sendResult) {
      throw new Error('Gagal mengirim pesan via Baileys. Pastikan nomor HP tujuan terdaftar di WhatsApp.');
    }

    // Ambil ID unik pesan dari Baileys agar update tanda terima (centang 2 & biru) bisa mencocokkan baris ini
    const msgId = (sendResult && typeof sendResult === 'object' && (sendResult.messageId || sendResult.key?.id)) ? String(sendResult.messageId || sendResult.key.id) : '';

    try {
      const phone = metaWAService.normalizePhone(toPhone);
      const identity = typeof resolveContactIdentity === 'function' ? resolveContactIdentity(phone) : { name: phone, customerId: null };

      db.prepare(`
        INSERT INTO wa_chat_messages 
        (direction, gateway, sender_phone, recipient_phone, customer_id, customer_name, message_text, status, meta_message_id)
        VALUES ('outbound', 'baileys', 'baileys_bot', ?, ?, ?, ?, 'sent', ?)
      `).run(phone, identity.customerId, identity.name, messageText, msgId);
    } catch (e) {
      logger.warn('[whatsappService sendWA DB log error]: ' + e.message);
    }

    return true;
/* === AKHIR PERUBAHAN === */
  }
}

/**
 * Ambil riwayat chat / percakapan dengan nomor tertentu untuk Live Chat
 */
function getChatHistory(phone, limit = 50) {
  const normalized = metaWAService.normalizePhone(phone);
  if (!normalized) return [];

  const rows = db.prepare(`
    SELECT * FROM wa_chat_messages
    WHERE sender_phone LIKE ? OR recipient_phone LIKE ? OR sender_phone LIKE ? OR recipient_phone LIKE ?
    ORDER BY id ASC
    LIMIT ?
  `).all(`%${normalized.slice(-8)}%`, `%${normalized.slice(-8)}%`, `%${normalized}%`, `%${normalized}%`, Number(limit) || 50);

  return rows || [];
}

/* === AWAL PERUBAHAN: QUERY RECENT CONVERSATIONS DENGAN HITUNGAN UNREAD BADGE === */
function getRecentConversations(limit = 30) {
  const rows = db.prepare(`
    SELECT 
      m.id,
      m.direction,
      m.gateway,
      conv.contact_phone as phone,
      m.customer_id,
      m.customer_name,
      m.message_text,
      m.status,
      m.created_at,
      COALESCE(unread.cnt, 0) as unread_count
    FROM wa_chat_messages m
    INNER JOIN (
      SELECT 
        MAX(id) as max_id,
        CASE WHEN direction = 'inbound' THEN sender_phone ELSE recipient_phone END as contact_phone
      FROM wa_chat_messages
      GROUP BY CASE WHEN direction = 'inbound' THEN sender_phone ELSE recipient_phone END
    ) conv ON m.id = conv.max_id
    LEFT JOIN (
      SELECT 
        sender_phone, 
        COUNT(1) as cnt 
      FROM wa_chat_messages 
      WHERE direction = 'inbound' AND status != 'read'
      GROUP BY sender_phone
    ) unread ON unread.sender_phone = conv.contact_phone
    ORDER BY m.id DESC
    LIMIT ?
  `).all(Number(limit) || 30);

  // Validasi nama kontak dengan fungsi identitas master agar tidak tertukar
  try {
    const { resolveContactIdentity } = require('./whatsappBot.mjs');
    if (typeof resolveContactIdentity === 'function') {
      return (rows || []).map(r => {
        const idt = resolveContactIdentity(r.phone, r.customer_name);
        return {
          ...r,
          customer_name: idt.name || r.customer_name || r.phone,
          unread_count: Number(r.unread_count || 0)
        };
      });
    }
  } catch (_) {}

  return (rows || []).map(r => ({ ...r, unread_count: Number(r.unread_count || 0) }));
}
/* === AKHIR PERUBAHAN === */

const DEFAULT_PAYMENT_SUCCESS_TEMPLATE = 
`🧾 *BUKTI PEMBAYARAN RESMI (LUNAS)*
🏢 *{{company}}*
────────────────────────────
Yth. Pelanggan *{{nama}}*,

Terima kasih, pembayaran tagihan internet Anda telah kami terima dan diverifikasi.

📋 *Rincian Pembayaran:*
• *No. Invoice:* #INV-{{no_invoice}}
• *ID Pelanggan:* {{username}}
• *Paket Layanan:* {{paket}}
• *Periode:* {{periode}}
• *Waktu Bayar:* {{waktu}}
• *Metode Bayar:* {{metode}}
• *Total Bayar:* *Rp {{total}}*
• *Status:* *LUNAS ✅*

🌐 *Status Layanan:*
Layanan internet Anda saat ini dalam status *AKTIF* dan dapat digunakan dengan nyaman.

────────────────────────────
🔗 *Cek Tagihan / Riwayat:*
{{link_portal}}

📞 *Bantuan & Layanan Pelanggan:*
WhatsApp: {{company_phone}}

_Simpan pesan ini sebagai bukti pembayaran yang sah dari {{company}}._`;

const INDONESIAN_MONTH_NAMES = [
  'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
  'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'
];

function getIndonesianMonthName(monthNumber) {
  const m = parseInt(monthNumber, 10);
  if (m >= 1 && m <= 12) {
    return INDONESIAN_MONTH_NAMES[m - 1];
  }
  return String(monthNumber || '').trim();
}

/**
 * Format periode bulan dan tahun ke dalam bahasa Indonesia, misal: "Oktober 2026"
 * @param {string|number} month - Bulan (angka 1-12 atau string nama bulan atau "10/2026")
 * @param {string|number} [year] - Tahun (misal 2026)
 * @returns {string} Contoh: "Oktober 2026"
 */
function formatIndonesianPeriod(month, year) {
  if (!month && !year) return '-';
  let m = String(month || '').trim();
  let y = String(year || '').trim();

  if (!y && m.includes('/')) {
    const parts = m.split('/');
    m = parts[0].trim();
    y = parts[1].trim();
  } else if (!y && m.includes('-')) {
    const parts = m.split('-');
    if (parts[0].length === 4) {
      y = parts[0].trim();
      m = parts[1].trim();
    } else {
      m = parts[0].trim();
      y = parts[1].trim();
    }
  }

  // Jika terdapat koma (banyak bulan)
  if (m.includes(',')) {
    const monthItems = m.split(',').map(x => x.trim()).filter(Boolean);
    const formattedMonths = monthItems.map(x => getIndonesianMonthName(x));
    if (formattedMonths.length === 2) {
      return `${formattedMonths[0]} & ${formattedMonths[1]}${y ? ' ' + y : ''}`;
    } else if (formattedMonths.length > 2) {
      const last = formattedMonths.pop();
      return `${formattedMonths.join(', ')} & ${last}${y ? ' ' + y : ''}`;
    }
    return `${formattedMonths.join(', ')}${y ? ' ' + y : ''}`;
  }

  const mName = getIndonesianMonthName(m);
  return y ? `${mName} ${y}` : mName;
}

/**
 * Format daftar tagihan belum lunas (unpaid invoices) menjadi ringkasan yang jelas:
 * - count: jumlah tagihan belum lunas
 * - totalAmount: akumulasi nominal rupiah
 * - totalAmountStr: format string rupiah (misal "220.000")
 * - periodText: nama bulan dalam huruf (misal "September & Oktober 2026 (2 Bulan)")
 * - breakdownText: rincian baris per bulan
 * - isMultiple: boolean apakah menunggak > 1 bulan
 */
function formatUnpaidInvoicesSummary(unpaidInvoices) {
  if (!unpaidInvoices || !Array.isArray(unpaidInvoices) || unpaidInvoices.length === 0) {
    return {
      count: 0,
      totalAmount: 0,
      totalAmountStr: '0',
      periodText: '-',
      breakdownText: '',
      isMultiple: false
    };
  }

  const formatter = new Intl.NumberFormat('id-ID');
  const count = unpaidInvoices.length;
  const totalAmount = unpaidInvoices.reduce((sum, inv) => sum + (Number(inv.amount) || 0), 0);
  const totalAmountStr = formatter.format(totalAmount);

  // Urutkan invoice berdasarkan period_year asc, period_month asc, id asc
  const sorted = [...unpaidInvoices].sort((a, b) => {
    const yA = Number(a.period_year) || 0;
    const yB = Number(b.period_year) || 0;
    if (yA !== yB) return yA - yB;
    const mA = Number(a.period_month) || 0;
    const mB = Number(b.period_month) || 0;
    if (mA !== mB) return mA - mB;
    return (Number(a.id) || 0) - (Number(b.id) || 0);
  });

  const periodStrings = sorted.map(inv => formatIndonesianPeriod(inv.period_month, inv.period_year));

  let periodText = '';
  if (periodStrings.length === 1) {
    periodText = periodStrings[0];
  } else if (periodStrings.length === 2) {
    periodText = `${periodStrings[0]} & ${periodStrings[1]}`;
  } else {
    const last = periodStrings[periodStrings.length - 1];
    periodText = `${periodStrings.slice(0, -1).join(', ')} & ${last}`;
  }

  const breakdownLines = sorted.map(inv => {
    const pStr = formatIndonesianPeriod(inv.period_month, inv.period_year);
    const amtStr = formatter.format(Number(inv.amount) || 0);
    return `• *${pStr}:* Rp ${amtStr}${inv.id ? ` (Inv #${inv.id})` : ''}`;
  });

  return {
    count,
    totalAmount,
    totalAmountStr,
    periodText: count > 1 ? `${periodText} (${count} Bulan)` : periodText,
    breakdownText: breakdownLines.join('\n'),
    isMultiple: count > 1
  };
}

/**
 * Format Payment Success WhatsApp Message
 */
function formatPaymentSuccessMessage({
  customerName = '',
  invoiceId = '',
  customerUsername = '',
  packageName = '',
  periodMonth = '',
  periodYear = '',
  amount = 0,
  paymentMethod = '',
  paidAt = null,
  companyName = '',
  companyPhone = '',
  portalUrl = '',
  customTemplate = '',
  remainingUnpaidInvoices = null,
  customerId = null
}) {
  let template = String(customTemplate || DEFAULT_PAYMENT_SUCCESS_TEMPLATE).trim();
  if (!template) template = DEFAULT_PAYMENT_SUCCESS_TEMPLATE;

  const periodText = formatIndonesianPeriod(periodMonth, periodYear);

  const tz = getSetting('timezone', 'Asia/Jakarta');
  let tzSuffix = 'WIB';
  if (/Makassar|Ujung_Pandang|Bali|Pontianak|Banjarmasin|Manado|Mataram|Kupang/i.test(tz)) {
    tzSuffix = 'WITA';
  } else if (/Jayapura|Ambon|Papua|Maluku/i.test(tz)) {
    tzSuffix = 'WIT';
  } else if (!/Jakarta|Bangkok|Asia\/Jakarta/i.test(tz)) {
    tzSuffix = tz;
  }

  let formattedTime = '';
  try {
    const { formatDateLocal } = require('../config/settingsManager');
    formattedTime = `${formatDateLocal(paidAt || new Date())} ${tzSuffix}`;
  } catch {
    const now = new Date();
    formattedTime = `${now.toLocaleDateString('id-ID')} ${now.toLocaleTimeString('id-ID')} ${tzSuffix}`;
  }

  const formattedAmount = Number(amount || 0).toLocaleString('id-ID');

  let remainingList = remainingUnpaidInvoices;
  if (remainingList === null && customerId) {
    try {
      const billingSvc = require('./billingService.js');
      const allUnpaid = billingSvc.getUnpaidInvoicesByCustomerId(customerId) || [];
      remainingList = allUnpaid.filter(inv => String(inv.id) !== String(invoiceId));
    } catch (e) {}
  }

  // Format informasi sisa tunggakan jika ada
  let tunggakanInfo = '';
  if (remainingList && Array.isArray(remainingList) && remainingList.length > 0) {
    const summary = formatUnpaidInvoicesSummary(remainingList);
    tunggakanInfo = `\n⚠️ *Perhatian Tunggakan Lain:*\nMasih ada *${summary.count} tagihan lain* belum lunas:\n${summary.breakdownText}\n💰 *Total Sisa Tunggakan:* *Rp ${summary.totalAmountStr}*\n_Mohon segera diselesaikan agar layanan tetap lancar._\n`;
  }

  let rendered = template
    .replace(/{{nama}}/gi, customerName || 'Pelanggan')
    .replace(/{{no_invoice}}/gi, String(invoiceId || '-'))
    .replace(/{{invoice_id}}/gi, String(invoiceId || '-'))
    .replace(/{{username}}/gi, customerUsername || '-')
    .replace(/{{id_pelanggan}}/gi, customerUsername || '-')
    .replace(/{{paket}}/gi, packageName || '-')
    .replace(/{{periode}}/gi, periodText)
    .replace(/{{total}}/gi, formattedAmount)
    .replace(/{{metode}}/gi, paymentMethod || 'Admin / Kasir')
    .replace(/{{waktu}}/gi, formattedTime)
    .replace(/{{tanggal}}/gi, formattedTime)
    .replace(/{{company}}/gi, companyName || 'ALIJAYA NET')
    .replace(/{{company_phone}}/gi, companyPhone || '-')
    .replace(/{{link_portal}}/gi, portalUrl || '-')
    .replace(/{{link}}/gi, portalUrl || '-')
    .replace(/{{tunggakan_info}}/gi, tunggakanInfo);

  // Jika template belum memiliki placeholder {{tunggakan_info}} tapi ada tunggakan lain, sisipkan sebelum link atau footer
  if (tunggakanInfo && !template.includes('{{tunggakan_info}}')) {
    if (rendered.includes('───')) {
      const idx = rendered.lastIndexOf('───');
      rendered = rendered.slice(0, idx) + `${tunggakanInfo}\n` + rendered.slice(idx);
    } else {
      rendered += `\n${tunggakanInfo}`;
    }
  }

  // Process spintax {A|B|C} only if pipe is present
  rendered = rendered.replace(/\{([^{}|]+(?:\|[^{}|]+)+)\}/g, (match, choices) => {
    const arr = choices.split('|');
    return arr[Math.floor(Math.random() * arr.length)].trim();
  });

  return rendered;
}

/* === AWAL PERUBAHAN: TEMPLATE & FORMATTER PENDAFTARAN & TEKNISI === */
const DEFAULT_REG_ADMIN_TEMPLATE = 
`🔔 *PENDAFTARAN PASANG BARU #{{id}}*
────────────────────────────
👤 *Nama:* {{nama}}
📞 *No. WA:* {{nohp}}
📍 *Alamat:* {{alamat}}
📦 *Paket:* {{paket}}{{lokasi}}

👉 *Untuk menunjuk teknisi, balas:*
*PIC {{id}} [NamaTeknisi] [Tanggal DDMMYYYY]*

_Contoh: PIC {{id}} Dindin 01012026_`;

//FORMAT PESAN PENOLAKAN PENDAFTARAN
const DEFAULT_REG_TECH_TEMPLATE = 
`📦 *TUGAS PASANG BARU #{{id}}*
────────────────────────────
📅 *Jadwal Pasang:* {{jadwal}}
👤 *Nama Pelanggan:* {{nama}}
📞 *No. WA:* {{nohp}}
📍 *Alamat:* {{alamat}}
📦 *Paket:* {{paket}}{{lokasi}}

👉 *Balas pesan ini untuk update status:*
• *TERIMA {{id}}* (Menerima job)
• *MULAI {{id}}* (Mulai pengerjaan)
• *SELESAI {{id}}* (Pemasangan selesai & aktif)`;

// === AWAL TAMBAHAN: TEMPLATE & FORMATTER REJECT PENDAFTARAN ===
const DEFAULT_REG_REJECT_TEMPLATE = 
`Halo Yth. *{{nama}}*,

Terima kasih telah mengajukan pendaftaran pasang baru di *{{company}}* (Ref #{{id}}).

Mohon maaf yang sebesar-besarnya, saat ini permohonan pendaftaran Anda *belum dapat kami proses* karena:
⚠️ *Alasan:* {{alasan}}

Data Anda telah kami simpan. Jika di kemudian hari area Anda telah ter-cover atau kapasitas jaringan tersedia, tim kami akan segera menghubungi Anda kembali.

Terima kasih atas pengertian dan kerja samanya. 🙏
Salam,
*Admin {{company}}*`;

function formatRegRejectMessage(data, customTemplate = '') {
  let template = String(customTemplate || db.getAppSetting('whatsapp_reg_reject_template', DEFAULT_REG_REJECT_TEMPLATE)).trim();
  if (!template) template = DEFAULT_REG_REJECT_TEMPLATE;

  return template
    .replace(/{{id}}/gi, String(data.id || ''))
    .replace(/{{nama}}/gi, data.name || '')
    .replace(/{{alasan}}/gi, data.reason || '-')
    .replace(/{{company}}/gi, data.company || 'Kami');
}
// === AKHIR TAMBAHAN: TEMPLATE & FORMATTER REJECT PENDAFTARAN ===


//UCAPAN SELAMAT DATANG JIKA SUDAH SELSAI PENDAFTARAN
const DEFAULT_REG_WELCOME_TEMPLATE = 
`Halo *{{nama}}*,

Selamat! Pemasangan internet Anda telah selesai dan saat ini layanan sudah *AKTIF* ✅

Terima kasih telah bergabung bersama *{{company}}*. Selamat menikmati layanan internet kami!`;

function formatRegAdminMessage(data, customTemplate = '') {
  let template = String(customTemplate || db.getAppSetting('whatsapp_reg_admin_template', DEFAULT_REG_ADMIN_TEMPLATE)).trim();
  if (!template) template = DEFAULT_REG_ADMIN_TEMPLATE;

  return template
    .replace(/{{id}}/gi, String(data.id || ''))
    .replace(/{{nama}}/gi, data.name || '')
    .replace(/{{nohp}}/gi, data.phone || '')
    .replace(/{{alamat}}/gi, data.address || '')
    .replace(/{{paket}}/gi, data.packageName || '')
    .replace(/{{lokasi}}/gi, data.mapLine ? `\n🗺️ *Maps:* ${data.mapLine}` : '');
}

function formatRegTechMessage(data, customTemplate = '') {
  let template = String(customTemplate || db.getAppSetting('whatsapp_reg_tech_template', DEFAULT_REG_TECH_TEMPLATE)).trim();
  if (!template) template = DEFAULT_REG_TECH_TEMPLATE;

  return template
    .replace(/{{id}}/gi, String(data.id || ''))
    .replace(/{{jadwal}}/gi, data.installDate || '-')
    .replace(/{{nama}}/gi, data.name || '')
    .replace(/{{nohp}}/gi, data.phone || '')
    .replace(/{{alamat}}/gi, data.address || '')
    .replace(/{{paket}}/gi, data.packageName || '')
    .replace(/{{lokasi}}/gi, data.mapLine ? `\n🗺️ *Maps:* ${data.mapLine}` : '');
}

function formatRegWelcomeMessage(data, customTemplate = '') {
  let template = String(customTemplate || db.getAppSetting('whatsapp_reg_welcome_template', DEFAULT_REG_WELCOME_TEMPLATE)).trim();
  if (!template) template = DEFAULT_REG_WELCOME_TEMPLATE;

  return template
    .replace(/{{nama}}/gi, data.name || '')
    .replace(/{{company}}/gi, data.company || 'Kami');
}
/* === AKHIR PERUBAHAN === */

// === AWAL TAMBAHAN: TEMPLATE TERPUSAT UNTUK SELURUH FITUR APLIKASI ===

// 1. Caption PDF Invoice
const DEFAULT_INVOICE_PDF_CAPTION_TEMPLATE =
`📄 *INVOICE PEMBAYARAN INTERNET*

Yth. *{{nama}}*,
Berikut kami lampirkan dokumen resmi Invoice Pembayaran Internet untuk periode *{{periode}}*.

📦 *Paket:* {{paket}}
💰 *Total Tagihan:* Rp {{total}}
📌 *Status:* *{{status}}*

Terima kasih telah menggunakan layanan *{{company}}*!`;

// 2. Notifikasi Ganti SSID WiFi
const DEFAULT_WIFI_SSID_CHANGED_TEMPLATE =
`📶 *PERUBAHAN SSID WIFI*

👤 *Pelanggan:* {{nama}}
🕒 *Waktu:* {{waktu}}

SSID WiFi Anda sudah diperbarui menjadi:
📡 *{{ssid}}*

Silakan pilih SSID baru di perangkat Anda untuk terhubung.
⚠️ Jangan bagikan info ini ke orang lain.`;

// 3. Notifikasi Ganti Password WiFi
const DEFAULT_WIFI_PASS_CHANGED_TEMPLATE =
`🔑 *PERUBAHAN PASSWORD WIFI*

👤 *Pelanggan:* {{nama}}
🕒 *Waktu:* {{waktu}}

Password WiFi Anda sudah diperbarui menjadi:
🔐 *{{password}}*

Silakan gunakan password baru untuk terhubung.
⚠️ Jangan bagikan password ini ke orang lain.`;

// 4. Kirim Ulang Voucher Hotspot Online
const DEFAULT_VOUCHER_RESEND_TEMPLATE =
`🎫 *KIRIM ULANG VOUCHER HOTSPOT*

✅ Pembayaran diterima via *{{gateway}}*
📦 Paket: *{{paket}}* ({{validity}})
💰 Harga: Rp {{harga}}

👤 User: *{{username}}*
🔑 Pass: *{{password}}*

Terima kasih telah menggunakan layanan kami.`;

// 5. Tiket Keluhan Selesai
const DEFAULT_TICKET_RESOLVED_TEMPLATE =
`✅ *TIKET KELUHAN SELESAI*

🎫 *ID Tiket:* #{{id}}
👤 *Pelanggan:* {{nama}}
📝 *Subjek:* {{subjek}}
🛠️ *Petugas:* {{petugas}}

Keluhan Anda telah selesai dikerjakan. Terima kasih atas kesabarannya.`;

// 6. Slip Gaji Karyawan
const DEFAULT_PAYROLL_SLIP_TEMPLATE =
`🧾 *SLIP GAJI KARYAWAN*

👤 *Nama:* {{nama}}
📅 *Periode:* {{periode}}
🏢 *Status:* {{status}}

*PENDAPATAN:*
- Gaji Pokok: Rp {{gaji_pokok}}{{rincian_pendapatan}}
*Total Pendapatan: Rp {{total_pendapatan}}*

*POTONGAN:*{{rincian_potongan}}
*Total Potongan: Rp {{total_potongan}}*

💰 *GAJI BERSIH: Rp {{gaji_bersih}}*

Terima kasih atas kerja keras Anda! 🙏`;

// 7. Pesan Uji Coba WhatsApp
const DEFAULT_TEST_NOTIF_TEMPLATE =
`🧪 *TEST NOTIFIKASI WHATSAPP*

✅ Jika pesan ini masuk, berarti notifikasi WhatsApp dari Billing System sudah berfungsi dengan baik.
📅 Waktu: {{waktu}}`;

// --- FUNGSI FORMATTER PEMBANTU ---

function formatInvoicePdfCaption(data) {
  let template = String(db.getAppSetting('whatsapp_invoice_pdf_caption_template', DEFAULT_INVOICE_PDF_CAPTION_TEMPLATE) || DEFAULT_INVOICE_PDF_CAPTION_TEMPLATE).trim();
  return template
    .replace(/{{nama}}/gi, data.name || 'Pelanggan')
    .replace(/{{periode}}/gi, data.period || '-')
    .replace(/{{paket}}/gi, data.packageName || '-')
    .replace(/{{total}}/gi, data.total || '0')
    .replace(/{{status}}/gi, data.status || 'LUNAS')
    .replace(/{{company}}/gi, data.company || 'Kami');
}

function formatWifiSsidChanged(data) {
  let template = String(db.getAppSetting('whatsapp_wifi_ssid_changed_template', DEFAULT_WIFI_SSID_CHANGED_TEMPLATE) || DEFAULT_WIFI_SSID_CHANGED_TEMPLATE).trim();
  return template
    .replace(/{{nama}}/gi, data.name || 'Pelanggan')
    .replace(/{{ssid}}/gi, data.ssid || '')
    .replace(/{{waktu}}/gi, data.time || '-');
}

function formatWifiPassChanged(data) {
  let template = String(db.getAppSetting('whatsapp_wifi_pass_changed_template', DEFAULT_WIFI_PASS_CHANGED_TEMPLATE) || DEFAULT_WIFI_PASS_CHANGED_TEMPLATE).trim();
  return template
    .replace(/{{nama}}/gi, data.name || 'Pelanggan')
    .replace(/{{password}}/gi, data.password || '')
    .replace(/{{waktu}}/gi, data.time || '-');
}

function formatVoucherResend(data) {
  let template = String(db.getAppSetting('whatsapp_voucher_resend_template', DEFAULT_VOUCHER_RESEND_TEMPLATE) || DEFAULT_VOUCHER_RESEND_TEMPLATE).trim();
  return template
    .replace(/{{gateway}}/gi, data.gateway || 'QRIS')
    .replace(/{{paket}}/gi, data.packageName || '-')
    .replace(/{{validity}}/gi, data.validity || '-')
    .replace(/{{harga}}/gi, data.price || '0')
    .replace(/{{username}}/gi, data.username || '')
    .replace(/{{password}}/gi, data.password || data.username || '');
}

function formatTicketResolved(data) {
  let template = String(db.getAppSetting('whatsapp_ticket_resolved_template', DEFAULT_TICKET_RESOLVED_TEMPLATE) || DEFAULT_TICKET_RESOLVED_TEMPLATE).trim();
  return template
    .replace(/{{id}}/gi, String(data.id || ''))
    .replace(/{{nama}}/gi, data.name || '')
    .replace(/{{subjek}}/gi, data.subject || '')
    .replace(/{{petugas}}/gi, data.officer || 'Admin');
}

function formatPayrollSlip(data) {
  let template = String(db.getAppSetting('whatsapp_payroll_slip_template', DEFAULT_PAYROLL_SLIP_TEMPLATE) || DEFAULT_PAYROLL_SLIP_TEMPLATE).trim();
  return template
    .replace(/{{nama}}/gi, data.name || '')
    .replace(/{{periode}}/gi, data.period || '')
    .replace(/{{status}}/gi, data.status || '')
    .replace(/{{gaji_pokok}}/gi, data.baseSalary || '0')
    .replace(/{{rincian_pendapatan}}/gi, data.incomeDetails || '')
    .replace(/{{total_pendapatan}}/gi, data.grossSalary || '0')
    .replace(/{{rincian_potongan}}/gi, data.deductionDetails || '')
    .replace(/{{total_potongan}}/gi, data.totalDeductions || '0')
    .replace(/{{gaji_bersih}}/gi, data.netSalary || '0');
}

function formatTestNotif(data) {
  let template = String(db.getAppSetting('whatsapp_test_notif_template', DEFAULT_TEST_NOTIF_TEMPLATE) || DEFAULT_TEST_NOTIF_TEMPLATE).trim();
  return template.replace(/{{waktu}}/gi, data.time || '-');
}

// === AKHIR TAMBAHAN: TEMPLATE TERPUSAT UNTUK SELURUH FITUR APLIKASI ===

module.exports = {
  sendWhatsAppMessage,
  sendWA: sendWhatsAppMessage, // Alias untuk kompatibilitas fungsi lama
  getChatHistory,
  getRecentConversations,
  INDONESIAN_MONTH_NAMES,
  getIndonesianMonthName,
  formatIndonesianPeriod,
  formatUnpaidInvoicesSummary,
  formatPaymentSuccessMessage,
  DEFAULT_PAYMENT_SUCCESS_TEMPLATE,
  /* === EXPORT FORMATTER PENDAFTARAN BARU === */
  DEFAULT_REG_ADMIN_TEMPLATE,
  DEFAULT_REG_TECH_TEMPLATE,
  DEFAULT_REG_WELCOME_TEMPLATE,
  formatRegAdminMessage,
  formatRegTechMessage,
  formatRegWelcomeMessage,
  // Tambahkan ini:
  DEFAULT_REG_REJECT_TEMPLATE,
  formatRegRejectMessage,
  // Template Terpusat Tambahan
  DEFAULT_INVOICE_PDF_CAPTION_TEMPLATE,
  DEFAULT_WIFI_SSID_CHANGED_TEMPLATE,
  DEFAULT_WIFI_PASS_CHANGED_TEMPLATE,
  DEFAULT_VOUCHER_RESEND_TEMPLATE,
  DEFAULT_TICKET_RESOLVED_TEMPLATE,
  DEFAULT_PAYROLL_SLIP_TEMPLATE,
  DEFAULT_TEST_NOTIF_TEMPLATE,
  formatInvoicePdfCaption,
  formatWifiSsidChanged,
  formatWifiPassChanged,
  formatVoucherResend,
  formatTicketResolved,
  formatPayrollSlip,
  formatTestNotif
};
