/**
 * Route Admin Dashboard — termasuk Billing System
 */
const express = require('express');
const router = express.Router();
const { getSetting, getSettings, saveSettings, getNowLocal, getCurrentDateInTimezone, getCurrentTimeInfo, getNowLocalISO, formatDateLocal, formatTimeLocal, parseDateInTimezone } = require('../config/settingsManager');
const { logger } = require('../config/logger');
const db = require('../config/database');
const customerDevice = require('../services/customerDeviceService');
const customerSvc = require('../services/customerService');
const billingSvc = require('../services/billingService');
const pdfSvc = require('../services/pdfInvoiceService');
const mikrotikService = require('../services/mikrotikService');
const adminSvc = require('../services/adminService');
const staffSvc = require('../services/staffService');
const agentSvc = require('../services/agentService');
const oltSvc = require('../services/oltService');
const odpSvc = require('../services/odpService');
const uniqueCodeService = require('../services/uniqueCodeService');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const XLSX = require('xlsx');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });
const qrisUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

// Promo slides upload storage
const promoSlidesStorage = multer.diskStorage({
  destination: function(req, file, cb) {
    const uploadDir = path.resolve(__dirname, '..', 'public', 'uploads', 'promo_slides');
    // Ensure directory exists
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: function(req, file, cb) {
    // Generate unique filename
    const ext = path.extname(file.originalname);
    const name = 'slide-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9) + ext;
    cb(null, name);
  }
});

const promoUpload = multer({
  storage: promoSlidesStorage,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB max
  fileFilter: function(req, file, cb) {
    const allowedMimes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Hanya file gambar (JPEG, PNG, GIF, WebP) yang diperbolehkan'), false);
    }
  }
});
const backupSvc = require('../services/backupService');
const monitoringSvc = require('../services/monitoringService');
const inventorySvc = require('../services/inventoryService');
const auditSvc = require('../services/auditTrailService');
const whatsappService = require('../services/whatsappService');
const { parseMikhmonOnLogin } = require('../utils/mikhmonParser');
const diagnosticsSvc = require('../services/diagnosticsService');
const attendanceSvc = require('../services/attendanceService');
const payrollSvc = require('../services/payrollService');
const sidebarMenuSvc = require('../services/sidebarMenuService');
const areaSvc = require('../services/areaService');
const axios = require('axios');
const crypto = require('crypto');
const _jimpMod = require('jimp');
const Jimp = _jimpMod.Jimp || _jimpMod;
const jsQR = require('jsqr');
const qrisUtil = require('../utils/qrisUtil');
const { MultiFormatReader, BarcodeFormat, DecodeHintType, BinaryBitmap, HybridBinarizer, RGBLuminanceSource } = require('@zxing/library');
const QRCode = require('qrcode');
const acsPortal = require('./acsPortal');
const { uploadAttendance, removeAttendanceFile } = require('../middleware/attendanceUpload');
const telegramAi = require('../services/telegramAiService');
const voiceTts = require('../services/voiceTtsService');

const DIGIFLAZZ_URL = 'https://api.digiflazz.com/v1';
const digiflazzApi = axios.create({
  baseURL: DIGIFLAZZ_URL,
  timeout: 30000,
  headers: { 'Content-Type': 'application/json' }
});

function digiflazzCreds() {
  const username = String(getSetting('digiflazz_username', '') || '').trim();
  const apiKey = String(getSetting('digiflazz_api_key', '') || '').trim();
  return { username, apiKey };
}

function digiflazzConfigured() {
  const { username, apiKey } = digiflazzCreds();
  return Boolean(username && apiKey);
}

function digiflazzSign(refId) {
  const { username, apiKey } = digiflazzCreds();
  if (!username || !apiKey) throw new Error('Digiflazz belum dikonfigurasi');
  return crypto.createHash('md5').update(username + apiKey + String(refId || '')).digest('hex');
}

async function extractQrTextFromImageBuffer(buffer) {
  const buf = buffer && Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (!buf.length) return '';
  return await qrisUtil.decodeQrisPayloadFromBuffer(buf);
}

async function digiflazzCekSaldo() {
  const { username } = digiflazzCreds();
  const sign = digiflazzSign('depo');
  const response = await digiflazzApi.post('/cek-saldo', { cmd: 'deposit', username, sign });
  const data = response?.data?.data;
  if (data?.rc) throw new Error(String(data?.message || 'Gagal cek saldo Digiflazz'));
  return data;
}

async function digiflazzPriceListAll() {
  const { username } = digiflazzCreds();
  const sign = digiflazzSign('pricelist');
  const response = await digiflazzApi.post('/price-list', { cmd: 'prepaid', username, sign });
  const data = response?.data?.data;
  if (!Array.isArray(data)) {
    const msg = response?.data?.data?.message || response?.data?.message || 'Gagal mengambil price list Digiflazz';
    throw new Error(String(msg));
  }
  return data;
}

const pppoeTrafficSamples = new Map();
function prunePppoeTrafficSamples(now) {
  for (const [k, v] of pppoeTrafficSamples.entries()) {
    if (!v || !v.t || (now - v.t) > 15000) pppoeTrafficSamples.delete(k);
  }
}

function numField(obj, keys) {
  if (!obj) return 0;
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') {
      const n = Number(obj[k]);
      if (Number.isFinite(n)) return n;
    }
    if (obj[String(k).toLowerCase()] !== undefined && obj[String(k).toLowerCase()] !== null && obj[String(k).toLowerCase()] !== '') {
      const n = Number(obj[String(k).toLowerCase()]);
      if (Number.isFinite(n)) return n;
    }
  }
  return 0;
}

function strField(obj, keys) {
  if (!obj) return '';
  for (const k of keys) {
    const v = obj[k] !== undefined ? obj[k] : obj[String(k).toLowerCase()];
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

async function invokeRouterOsMenuCommand(menu, command, args) {
  if (!menu) return null;
  if (typeof menu.call === 'function') return await menu.call(command, args);
  if (typeof menu.command === 'function') return await menu.command(command, args);
  if (typeof menu.run === 'function') return await menu.run(command, args);
  return null;
}

// ─── AUTH ──────────────────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  if (req.session?.isAdmin || req.session?.isCashier || req.session?.isStaff) return next();
  const adminKey = getSetting('admin_api_key', '');
  const providedKey = req.headers['x-admin-key'] || req.query.key;
  if (adminKey && providedKey === adminKey) return next();
  return res.status(401).json({ error: 'Unauthorized - Admin/Staff access required' });
}

function requireAdminSession(req, res, next) {
  if (req.session?.isAdmin || req.session?.isCashier || req.session?.isStaff) return next();
  return res.redirect('/admin/login');
}

function resolvePaidByName(req, fallback) {
  const fb = String(fallback || '').trim();
  if (req.session?.isCashier) {
    const nm = String(req.session.cashierName || '').trim();
    const un = String(req.session.cashierUsername || '').trim();
    if (nm && un) return `Kasir ${nm} (@${un})`;
    if (nm) return `Kasir ${nm}`;
    return 'Kasir';
  }
  if (req.session?.isAdmin) return fb || 'Admin';
  return fb || 'Admin';
}

function routerContextMiddleware(req, res, next) {
  try {
    const multiRouterMode = getSetting('multi_router_mode', 'disabled') === 'active';
    const activeRouters = mikrotikService.getAllRouters() || [];

    if (req.query.router_id !== undefined) {
      if (req.query.router_id === 'all' || req.query.router_id === '0' || req.query.router_id === '') {
        req.session.selected_router_id = null;
      } else {
        const rid = parseInt(req.query.router_id, 10);
        req.session.selected_router_id = isNaN(rid) ? null : rid;
      }
    }

    let selectedRouterId = req.session.selected_router_id ?? null;
    if (selectedRouterId && !activeRouters.some(r => r.id === selectedRouterId)) {
      selectedRouterId = null;
      req.session.selected_router_id = null;
    }

    res.locals.multiRouterMode = multiRouterMode;
    res.locals.allActiveRouters = activeRouters;
    res.locals.selectedRouterId = selectedRouterId;
    req.selectedRouterId = selectedRouterId;
  } catch (e) {
    res.locals.multiRouterMode = false;
    res.locals.allActiveRouters = [];
    res.locals.selectedRouterId = null;
    req.selectedRouterId = null;
  }
  next();
}

router.use(routerContextMiddleware);

router.get('/set-active-router', requireAdminSession, (req, res) => {
  const routerId = req.query.router_id;
  if (routerId === 'all' || routerId === '0' || !routerId) {
    req.session.selected_router_id = null;
  } else {
    const parsed = parseInt(routerId, 10);
    req.session.selected_router_id = isNaN(parsed) ? null : parsed;
  }
  const referer = req.headers.referer || '/admin';
  return res.redirect(referer);
});

async function trySendWhatsappPayment(customerPhone, message) {
  try {
    if (!getSetting('whatsapp_enabled', false)) return false;
    const to = String(customerPhone || '').trim();
    if (!to) return false;
    const { sendWA, whatsappStatus } = await import('../services/whatsappBot.mjs');
    if (!whatsappStatus || whatsappStatus.connection !== 'open') return false;
    await sendWA(to, String(message || '').trim());
    return true;
  } catch {
    return false;
  }
}

// ==================== AWAL PERBAIKAN FUNGSI NOTIFIKASI WA & TELEGRAM ====================
async function sendPaymentSuccessWA(customerPhone, customerName, periodText, amountText, paidBy, extraOpts = {}) {
  try {
    const isEnabled = extraOpts.bypassEnabledCheck ? true : (db.getAppSetting('whatsapp_payment_success_enabled', '1') === '1');
    if (!isEnabled && !extraOpts.sendTelegram) {
      return false;
    }

    const defaultTemplate = whatsappService.DEFAULT_PAYMENT_SUCCESS_TEMPLATE;
    let template = db.getAppSetting('whatsapp_payment_success_message', defaultTemplate) || defaultTemplate;

    // AUTO-CORRECT TEMPLATE: Jika di database baris Paket Layanan tertukar menjadi {{metode}} atau {{admin}}, paksa betulkan ke {{paket}}
    template = template.replace(/Paket\s*Layanan\s*:\s*{{(?:metode|admin|kasir|petugas)}}/gi, 'Paket Layanan: {{paket}}');

    const settings = getSettings();
    const appUrl = (settings.public_base_url || '').replace(/\/$/, '');
    const portalUrl = appUrl ? `${appUrl}/customer` : '';

    let periodMonth = '';
    let periodYear = '';
    if (periodText && String(periodText).includes('/')) {
      const p = String(periodText).split('/');
      periodMonth = p[0];
      periodYear = p[1];
    }

    const custId = extraOpts.customerId || extraOpts.customer_id;

    // AMBIL NAMA PAKET DENGAN BENAR LANGSUNG DARI DATABASE MASTER
    let resolvedPackageName = String(extraOpts.packageName || '').trim();
    if (!resolvedPackageName || resolvedPackageName === '-' || resolvedPackageName.toLowerCase() === 'admin') {
      resolvedPackageName = '';
      if (custId) {
        const custData = db.prepare('SELECT package_id FROM customers WHERE id = ?').get(custId);
        if (custData && custData.package_id) {
          const pkgRow = db.prepare('SELECT name FROM packages WHERE id = ?').get(custData.package_id);
          if (pkgRow && pkgRow.name) resolvedPackageName = pkgRow.name;
        }
      }
    }
    if (!resolvedPackageName || resolvedPackageName.toLowerCase() === 'admin') {
      resolvedPackageName = 'Reguler';
    }

    const formattedMsg = whatsappService.formatPaymentSuccessMessage({
      customerId: custId || null,
      customerName: customerName || 'Pelanggan',
      invoiceId: extraOpts.invoiceId || '',
      customerUsername: extraOpts.username || custId || '-',
      packageName: resolvedPackageName,
      periodMonth: periodMonth || periodText,
      periodYear: periodYear || '',
      amount: String(amountText || '0').replace(/[^\d]/g, ''),
      paymentMethod: paidBy || 'Kasir / Admin',
      paidAt: extraOpts.paidAt || new Date(),
      companyName: company(),
      companyPhone: settings.company_phone || '',
      portalUrl,
      customTemplate: template,
      remainingUnpaidInvoices: extraOpts.remainingUnpaidInvoices || null
    });

    // 1. Kirim WhatsApp ke Pelanggan
    let waSent = false;
    if (isEnabled && customerPhone) {
      waSent = await trySendWhatsappPayment(customerPhone, formattedMsg);
    }

    // 2. Kirim Notifikasi ke Telegram Admin
    if (extraOpts.sendTelegram) {
      try {
        const token = settings.telegram_bot_token || '';
        const chatId = settings.telegram_admin_id || '';
        if (token && chatId) {
          await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, { chat_id: chatId, text: formattedMsg });
          logger.info(`[Telegram] Notifikasi pembayaran invoice ${extraOpts.invoiceId || ''} berhasil dikirim.`);
        }
      } catch (tgErr) {
        logger.error('[Telegram Pay Error]: ' + tgErr.message);
      }
    }

    return waSent;
  } catch (e) {
    logger.error('[sendPaymentSuccessWA Error]: ' + e.message);
    return false;
  }
}
// ==================== AKHIR PERBAIKAN FUNGSI NOTIFIKASI WA & TELEGRAM ====================

// Middleware strictly for Admin
function restrictToAdmin(req, res, next) {
  if (req.session?.isAdmin) return next();
  req.session._msg = { type: 'error', text: 'Hanya Admin yang dapat mengakses halaman ini.' };
  return res.redirect('/admin');
}

function company() { return getSetting('company_header', 'ISP Admin'); }

function flashMsg(req) {
  const m = req.session._msg;
  delete req.session._msg;
  return m || null;
}

function safeAdminPath(rawPath, fallback = '/admin/sidebar-settings') {
  const candidate = String(rawPath || '').trim();
  if (!candidate.startsWith('/admin')) return fallback;
  if (candidate.startsWith('/admin/logout')) return fallback;
  return candidate;
}

function requireSidebarMenuAccess(menuKey) {
  return (req, res, next) => {
    const access = sidebarMenuSvc.evaluateMenuAccess(menuKey, req.session);
    if (access.allowed) return next();

    if (access.reason === 'hidden') {
      req.session._msg = { type: 'error', text: `Menu "${access.menu.labelDefault}" sedang disembunyikan dari sidebar.` };
      return res.redirect('/admin');
    }

    if (access.reason === 'locked') {
      req.session._msg = { type: 'error', text: `Menu "${access.menu.labelDefault}" terkunci. Hubungi ${sidebarMenuSvc.FEATURE_CONTACT_PHONE} untuk mendapatkan password.` };
      return res.redirect('/admin/sidebar-settings');
    }

    req.session._msg = { type: 'error', text: 'Anda tidak memiliki akses ke menu ini.' };
    return res.redirect('/admin');
  };
}

function popUpdateLog(req) {
  const l = req.session._updateLog;
  delete req.session._updateLog;
  return l || '';
}

function readTextFileSafe(filePath) {
  try {
    return String(fs.readFileSync(filePath, 'utf8')).trim();
  } catch (e) {
    return '';
  }
}

function runCmd(cmd, args, cwd) {
  try {
    const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
    return { ok: r.status === 0, code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
  } catch (e) {
    return { ok: false, code: -1, stdout: '', stderr: String(e?.message || e) };
  }
}

function copyDirSync(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const ent of entries) {
    const src = path.join(srcDir, ent.name);
    const dst = path.join(destDir, ent.name);
    if (ent.isDirectory()) copyDirSync(src, dst);
    else if (ent.isFile()) fs.copyFileSync(src, dst);
  }
}

function getGitDefaultBranch(repoRoot) {
  let r = runCmd('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], repoRoot);
  if (r.ok) {
    const ref = String(r.stdout || '').trim();
    const m = ref.match(/refs\/remotes\/origin\/(.+)$/);
    if (m && m[1]) return m[1].trim();
  }
  r = runCmd('git', ['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot);
  if (r.ok) {
    const b = String(r.stdout || '').trim();
    if (b && b !== 'HEAD') return b;
  }
  r = runCmd('git', ['rev-parse', '--verify', 'origin/main'], repoRoot);
  if (r.ok) return 'main';
  r = runCmd('git', ['rev-parse', '--verify', 'origin/master'], repoRoot);
  if (r.ok) return 'master';

  return 'main';
}

function getUpdateInfo(repoRoot) {
  const localVersion = readTextFileSafe(path.join(repoRoot, 'version.txt')) || '-';
  const info = { localVersion, remoteVersion: '-', branch: '-', needsUpdate: false, error: '' };

  const inside = runCmd('git', ['rev-parse', '--is-inside-work-tree'], repoRoot);
  if (!inside.ok) {
    info.error = 'Folder ini belum menjadi git repository.';
    return info;
  }

  const branch = getGitDefaultBranch(repoRoot);
  info.branch = branch;

  const fetch = runCmd('git', ['fetch', '--prune'], repoRoot);
  if (!fetch.ok) {
    info.error = 'Gagal git fetch: ' + (fetch.stderr || fetch.stdout || '').trim();
    return info;
  }

  const remote = runCmd('git', ['show', `origin/${branch}:version.txt`], repoRoot);
  if (!remote.ok) {
    info.error = `Tidak bisa membaca version.txt dari GitHub (origin/${branch}).`;
    return info;
  }

  const remoteVersion = String(remote.stdout || '').trim() || '-';
  info.remoteVersion = remoteVersion;
  info.needsUpdate = Boolean(remoteVersion && remoteVersion !== '-' && remoteVersion !== localVersion);
  return info;
}


function genCode(len, charset) {
  const n = Math.max(4, Math.min(16, Number(len) || 6));
  let chars = '0123456789';
  if (charset === 'letters') chars = 'abcdefghjkmnpqrstuvwxyz';
  else if (charset === 'mixed') chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < n; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  // Avoid starting with 0 if it's only numbers
  if (charset === 'numbers' && out[0] === '0') out = '1' + out.slice(1);
  return out;
}

async function createVoucherBatchAsync(batchId) {
  const batch = db.prepare('SELECT * FROM voucher_batches WHERE id = ?').get(batchId);
  if (!batch) return;

  const routerId = batch.router_id ?? null;
  const vouchers = db.prepare('SELECT id, code, profile_name FROM vouchers WHERE batch_id = ? ORDER BY id ASC').all(batchId);

  const updateVoucher = db.prepare('UPDATE vouchers SET code=?, password=?, comment=?, status=?, created_at=created_at WHERE id=?');
  const markVoucherCreated = db.prepare('UPDATE vouchers SET status=? WHERE id=?');
  const incCreated = db.prepare("UPDATE voucher_batches SET qty_created = qty_created + 1, updated_at = (NOW_LOCAL()) WHERE id=?");
  const incFailed = db.prepare("UPDATE voucher_batches SET qty_failed = qty_failed + 1, updated_at = (NOW_LOCAL()) WHERE id=?");
  const setBatchStatus = db.prepare("UPDATE voucher_batches SET status=?, updated_at = (NOW_LOCAL()) WHERE id=?");

  const existsCode = db.prepare('SELECT 1 FROM vouchers WHERE router_id IS ? AND code = ? LIMIT 1');

  const makeUniqueCode = () => {
    const prefix = String(batch.prefix || '').trim();
    const coreLen = Math.max(4, Math.min(16, (Number(batch.code_length) || 6) - prefix.length));
    const userCode = prefix + genCode(coreLen, batch.charset || 'numbers');
    
    let passCode = userCode;
    if (batch.mode === 'member') {
      passCode = genCode(coreLen, batch.charset || 'numbers');
    }
    
    return { userCode, passCode };
  };

  const poolLimit = 8;
  let idx = 0;

  const worker = async () => {
    while (idx < vouchers.length) {
      const current = vouchers[idx++];
      let generated = { userCode: current.code, passCode: current.password || current.code };
      let attempt = 0;
      while (attempt < 10) {
        attempt++;

        if (existsCode.get(routerId, generated.userCode) && generated.userCode !== current.code) {
          generated = makeUniqueCode();
          continue;
        }

        try {
          const comment = current.comment || `vc-${batch.created_by || 'admin'}`;
          const userData = {
            server: 'all',
            name: generated.userCode,
            password: generated.passCode,
            profile: batch.profile_name,
            comment
          };
          if (batch.validity) userData['limit-uptime'] = batch.validity;

          await mikrotikService.addHotspotUser(userData, routerId);

          if (generated.userCode !== current.code || generated.passCode !== current.password) {
            updateVoucher.run(generated.userCode, generated.passCode, comment, 'created', current.id);
          } else {
            markVoucherCreated.run('created', current.id);
          }
          incCreated.run(batchId);
          break;
        } catch (e) {
          const msg = String(e?.message || e || '');
          const isDup = msg.toLowerCase().includes('already') || msg.toLowerCase().includes('exist') || msg.toLowerCase().includes('duplicate');
          if (isDup) {
            generated = makeUniqueCode();
            continue;
          }
          markVoucherCreated.run('failed', current.id);
          incFailed.run(batchId);
          break;
        }
      }
      if (attempt >= 10) {
        markVoucherCreated.run('failed', current.id);
        incFailed.run(batchId);
      }
    }
  };

  setBatchStatus.run('creating', batchId);
  const workers = Array.from({ length: poolLimit }, () => worker());
  await Promise.all(workers);

  const final = db.prepare('SELECT qty_total, qty_created, qty_failed FROM voucher_batches WHERE id=?').get(batchId);
  if (final.qty_created >= final.qty_total && final.qty_failed === 0) setBatchStatus.run('ready', batchId);
  else if (final.qty_created > 0) setBatchStatus.run('partial', batchId);
  else setBatchStatus.run('failed', batchId);
}

// Global locals middleware
router.use((req, res, next) => {
  res.locals.session = req.session;
  res.locals.sidebarSections = sidebarMenuSvc.getSidebarSections(req.session);
  res.locals.sidebarBottomNavItems = sidebarMenuSvc.getBottomNavItems(req.session);
  res.locals.settings = getSettings();
  res.locals.company = company();
  res.locals.formatDateLocal = formatDateLocal;
  res.locals.formatTimeLocal = formatTimeLocal;
  res.locals.parseDateInTimezone = parseDateInTimezone;
  res.locals.getNowLocal = getNowLocal;
  res.locals.getCurrentTimeInfo = getCurrentTimeInfo;
  next();
});

let loginRateLimiter = (req, res, next) => next();
try {
  const rlMod = require('../middleware/rateLimiter');
  if (rlMod && typeof rlMod.loginRateLimiter === 'function') {
    loginRateLimiter = rlMod.loginRateLimiter;
  }
} catch (e) {}

// ─── AUTH ROUTES ───────────────────────────────────────────────────────────
router.get('/login', (req, res) => {
  if (req.session?.isAdmin || req.session?.isCashier) return res.redirect('/admin');
  res.render('admin/login', { title: 'Admin Login', company: company(), error: null });
});

router.post('/login', loginRateLimiter, express.urlencoded({ extended: true }), (req, res) => {
  const { username, password } = req.body;
  if (username === getSetting('admin_username', 'admin') && password === getSetting('admin_password', 'admin123')) {
    req.session.isAdmin = true;
    req.session.adminUser = username;
    return res.redirect('/admin');
  }
  
  // Check Cashier
  const cashier = adminSvc.authenticateCashier(username, password);
  if (cashier) {
    req.session.isCashier = true;
    req.session.cashierId = cashier.id;
    req.session.cashierName = cashier.name;
    req.session.cashierUsername = cashier.username;
    req.session.cashierSite = cashier.site || 'all';
    req.session.staffSite = cashier.site || 'all'; // 👈 Biar otomatis terhubung ke filter site yang sudah kita buat!
    return res.redirect('/admin');
  }

  // Check Staff / Admin Mitra
  const staff = staffSvc.authenticateStaff(username, password);
  if (staff) {
    req.session.isStaff = true;
    req.session.staffId = staff.id;
    req.session.staffName = staff.name;
    req.session.staffUsername = staff.username;
    req.session.staffSite = staff.site;
    req.session.canAddCustomer = staff.can_add_customer === 1;
    req.session.canEditCustomer = staff.can_edit_customer === 1;
    req.session.canDeleteCustomer = staff.can_delete_customer === 1;
    return res.redirect('/admin');
  }

  res.render('admin/login', { title: 'Admin Login', company: company(), error: 'Username atau password salah' });
  });

router.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/admin/login'); });

// ─── OLT MANAGEMENT ────────────────────────────────────────────────────────
router.get('/olts', requireAdminSession, async (req, res) => {
  const olts = oltSvc.getAllOlts();
  
  res.render('admin/olts', { 
    title: 'Manajemen OLT', 
    company: company(), 
    activePage: 'olts', 
    olts, 
    msg: flashMsg(req) 
  });
});

router.get('/olts/all/stats', requireAdminSession, async (req, res) => {
  try {
    const stats = await oltSvc.getAllOltsStats(req.query.full === 'true');
    res.json(stats);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/olts/:id/stats', requireAdminSession, async (req, res) => {
  try {
    const stats = await oltSvc.getOltStats(req.params.id, req.query.full === 'true');
    res.json(stats);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

//menu detail perangkat

router.get('/olts/:id/onu/:index/detail', requireAdminSession, async (req, res) => {
  try {
    const { id, index } = req.params;
    const detail = await oltSvc.getOnuDetailStats(id, index);
    res.json({ success: true, data: detail });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
//akhir menu detail perangkat

router.post('/olts/test-connection', requireAdminSession, restrictToAdmin, express.json(), async (req, res) => {
  try {
    const result = await oltSvc.testOltConnection(req.body);
    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.post('/olts/:id/test-connection', requireAdminSession, restrictToAdmin, async (req, res) => {
  try {
    const olt = oltSvc.getOltById(req.params.id);
    if (!olt) return res.status(404).json({ success: false, message: 'OLT tidak ditemukan' });
    const result = await oltSvc.testOltConnection(olt);
    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.post('/olts/:id/onu/:index/reboot', requireAdminSession, restrictToAdmin, async (req, res) => {
  try {
    await oltSvc.rebootOnu(req.params.id, req.params.index);
    res.json({ success: true, message: 'Perintah reboot berhasil dikirim.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/olts/:id/onu/:index/rename', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) throw new Error('Nama tidak boleh kosong');
    await oltSvc.renameOnu(req.params.id, req.params.index, name);
    res.json({ success: true, message: 'Nama ONU berhasil diubah.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// authorize onu
router.post('/olts/:id/onu/authorize', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    // Parameter yang dikirim dari form atau JSON
    const { index, sn, name } = req.body; 
    
    // Gunakan service baru yang 100% SNMP
    const result = await oltSvc.authorizeOnuBySnmp(req.params.id, { index, sn, name });
    
    res.json({ success: true, message: result.message, data: result.data });
  } catch (e) {
    logger.error('[Authorize] Error:', e);
    res.status(400).json({ success: false, error: e.message });
  }
});

router.post('/olts/:id/onu/configure-wan', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const { method, sn } = req.body;
    let output;
    if (method === 'tr069') {
      output = await oltSvc.configureWanViaAcs(sn, req.body);
    } else {
      output = await oltSvc.configureOnuWan(req.params.id, req.body);
    }
    res.json({ success: true, message: 'Konfigurasi WAN berhasil.', output });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/olts', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), (req, res) => {
  try {
    oltSvc.createOlt(req.body);
    req.session._msg = { type: 'success', text: 'OLT berhasil ditambahkan.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/olts');
});

router.post('/olts/:id/update', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), (req, res) => {
  try {
    oltSvc.updateOlt(req.params.id, req.body);
    req.session._msg = { type: 'success', text: 'OLT berhasil diperbarui.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/olts');
});

router.post('/olts/:id/delete', requireAdminSession, restrictToAdmin, (req, res) => {
  try {
    oltSvc.deleteOlt(req.params.id);
    req.session._msg = { type: 'success', text: 'OLT berhasil dihapus.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/olts');
});

// ─── ODP & MAP MANAGEMENT ───────────────────────────────────────────────────
router.get('/map', requireAdminSession, requireSidebarMenuAccess('map'), (req, res) => {
  let mapSite = '';
  if (req.session?.isStaff && req.session?.staffSite && req.session.staffSite !== 'all') {
    mapSite = req.session.staffSite;
  }

  // Hanya ambil pelanggan dari site yang diizinkan untuk peta
  const customers = customerSvc.getAllCustomers('', null, '', '', mapSite);
  const odps = odpSvc.getAllOdps();
  
  res.render('admin/map', { 
    title: 'Peta Jaringan', 
    company: company(), 
    activePage: 'map', 
    customers, 
    odps,
    msg: flashMsg(req),
    settings: getSettings()
  });
});

router.get('/api/customers/live-sessions', requireAdminSession, async (req, res) => {
  try {
    const force = req.query.force === '1' || req.query.force === 'true';
    const activeMap = await mikrotikService.getAllActiveSessionsMap(force);
    const sessionsObj = {};
    for (const [uname, session] of activeMap.entries()) {
      sessionsObj[uname] = session;
    }
    return res.json({ ok: true, sessions: sessionsObj });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});


/* >>> AWAL PENAMBAHAN: ENDPOINT API REALTIME OPTICAL DARI OLT UNTUK PETA <<<  */
router.get('/api/customers/:id/olt-optical', requireAdminSession, async (req, res) => {
  try {
    const customerId = Number(req.params.id);
    if (!customerId) return res.status(400).json({ ok: false, error: 'ID tidak valid' });

    const customer = customerSvc.getCustomerById(customerId);
    if (!customer) return res.status(404).json({ ok: false, error: 'Pelanggan tidak ditemukan' });

    const opticalData = await oltSvc.getCustomerOptical(customer);
    return res.json({ ok: true, data: opticalData });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});
/* >>> AKHIR PENAMBAHAN: ENDPOINT API REALTIME OPTICAL DARI OLT UNTUK PETA <<< */


// ==================== AWAL PERBAIKAN: LIVE TRAFFIC & THROUGHPUT ROS6 / ROS7 (PPPOE & HOTSPOT QUEUE) ====================
router.get('/api/customers/:id/pppoe-traffic', requireAdminSession, async (req, res) => {
  const customerId = Number(req.params.id);
  if (!customerId) return res.json({ ok: false, error: 'invalid_customer' });

  const customer = customerSvc.getCustomerById(customerId);
  if (!customer) return res.json({ ok: false, error: 'not_found' });

  let routerId = customer.router_id ? Number(customer.router_id) : null;
  if (!routerId || routerId <= 0) {
    const defaultRouter = mikrotikService.getAllRouters()?.[0];
    routerId = defaultRouter ? defaultRouter.id : null;
  }

  const pppUser = String(customer.pppoe_username || '').trim();
  const hsUser = String(customer.hotspot_username || '').trim();
  const staticIp = String(customer.static_ip || '').trim();
  const macAddr = String(customer.mac_address || '').trim();

  // Jika tidak ada parameter koneksi sama sekali
  if (!pppUser && !hsUser && !staticIp && !macAddr) {
    const dbCust = db.prepare('SELECT bytes_in, bytes_out, bytes_in_daily, bytes_out_daily FROM customers WHERE id = ?').get(customerId);
    return res.json({ 
      ok: true, available: false, online: false, username: null, 
      dailyRxBytes: dbCust?.bytes_in_daily || 0, dailyTxBytes: dbCust?.bytes_out_daily || 0,
      monthlyRxBytes: dbCust?.bytes_in || 0, monthlyTxBytes: dbCust?.bytes_out || 0,
      rxMbps: 0, txMbps: 0 
    });
  }

  const now = Date.now();
  prunePppoeTrafficSamples(now);
  const targetKey = pppUser || hsUser || staticIp || `cust_${customerId}`;
  const key = `${routerId || 'default'}_${targetKey}`;
  const prev = pppoeTrafficSamples.get(key);

  let conn = null;
  try {
    conn = routerId ? await mikrotikService.getConnection(routerId) : await mikrotikService.getConnection();

    let isOnline = false;
    let rawDownloadBytes = 0; // Download (bytes_in)
    let rawUploadBytes = 0;   // Upload (bytes_out)
    let liveDownloadMbps = 0;
    let liveUploadMbps = 0;
    let hasLiveRateFromQueue = false;

    // ──────────────────────────────────────────────────────────
    // KASUS 1: PELANGGAN PPPOE (Router Utama / ROS 7)
    // ──────────────────────────────────────────────────────────
    if (pppUser && conn && conn.client) {
      let interfaces = [];
      try {
        interfaces = await conn.client.menu('/interface').where('name', `<pppoe-${pppUser}>`).get();
      } catch {}
      if (!interfaces || interfaces.length === 0) {
        try {
          interfaces = await conn.client.menu('/interface').where('name', pppUser).get();
        } catch {}
      }
      if (!interfaces || interfaces.length === 0) {
        try {
          const allIfaces = await conn.client.menu('/interface').get().catch(() => []);
          interfaces = (allIfaces || []).filter(i => String(i.name || '').toLowerCase().includes(pppUser.toLowerCase()));
        } catch {}
      }

      if (interfaces && interfaces.length > 0) {
        isOnline = true;
        const iface = interfaces[0];
        rawDownloadBytes = numField(iface, ['tx-byte', 'txBytes', 'bytes-out', 'bytesOut']); 
        rawUploadBytes   = numField(iface, ['rx-byte', 'rxBytes', 'bytes-in', 'bytesIn']);   
      }
    }

    // ──────────────────────────────────────────────────────────
    // KASUS 2: PELANGGAN HOTSPOT (MULTI-DEVICE / SHARED USERS) & BINDING (ROS 6)
    // ──────────────────────────────────────────────────────────
    if (!isOnline && conn && conn.client) {
      let matchedQueuesCount = 0;

      // A. Ambil dari /queue/simple (Mencakup Nurhasanah, Nurhasanah-2, Nurhasanah-3 dst)
      let simpleQueues = [];
      try {
        simpleQueues = await conn.client.menu('/queue/simple').get().catch(() => []);
      } catch (qErr) {}

      for (const q of (simpleQueues || [])) {
        const qName = String(q.name || '').toLowerCase().replace(/^<|>$/g, '');
        const cleanHsUser = hsUser ? hsUser.toLowerCase() : '';
        const targetRaw = String(q.target || q['target'] || '').toLowerCase();
        const targetIp = targetRaw.split('/')[0].trim();

        const matchIp = staticIp && (targetIp === staticIp.toLowerCase() || qName === staticIp.toLowerCase());
        
        // Pengecekan regex presisi: cocok "nurhasanah", "nurhasanah-2", "hotspot-nurhasanah-3"
        let matchUser = false;
        if (cleanHsUser) {
          const escapedUser = cleanHsUser.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const pattern = new RegExp(`^(hotspot-)?${escapedUser}(-[0-9]+)?$`, 'i');
          matchUser = pattern.test(qName);
        }

        const matchComment = staticIp && String(q.comment || '').toLowerCase().includes(staticIp.toLowerCase());

        if (matchIp || matchUser || matchComment) {
          isOnline = true;
          matchedQueuesCount++;

          // 1. Akumulasi Bytes: jumlahkan (SUM) semua HP
          const bytesStr = String(q.bytes || q['bytes'] || '').trim();
          if (bytesStr.includes('/')) {
            const bParts = bytesStr.split('/');
            rawUploadBytes += (Number(bParts[0]) || 0);   // Tambahkan Upload
            rawDownloadBytes += (Number(bParts[1]) || 0); // Tambahkan Download
          }

          // 2. Akumulasi Live Throughput: jumlahkan (SUM) speed semua HP
          const rateStr = String(q.rate || q['rate'] || '').trim();
          if (rateStr && rateStr.includes('/')) {
            const rParts = rateStr.split('/');
            const upBps = Number(rParts[0]) || 0;
            const downBps = Number(rParts[1]) || 0;

            liveUploadMbps += Number((upBps / 1000000).toFixed(3));
            liveDownloadMbps += Number((downBps / 1000000).toFixed(3));
            hasLiveRateFromQueue = true;
          }
        }
      }

      // B. Cek di /ip hotspot active (Tambahan jika ada sesi aktif yang belum masuk queue)
      try {
        const actives = await conn.client.menu('/ip/hotspot/active').get().catch(() => []);
        const matchedActives = (actives || []).filter(a => {
          const u = String(a.user || '').toLowerCase();
          const ip = String(a.address || '').toLowerCase();
          return (hsUser && u === hsUser.toLowerCase()) || (staticIp && ip === staticIp.toLowerCase());
        });

        if (matchedActives.length > 0) {
          isOnline = true;
          if (matchedQueuesCount === 0) {
            for (const act of matchedActives) {
              rawUploadBytes += Number(act['bytes-in'] || 0);
              rawDownloadBytes += Number(act['bytes-out'] || 0);
            }
          }
        }
      } catch (actErr) {}

      // C. Cek IP-Binding jika masih belum terdeteksi online
      if (!isOnline && staticIp) {
        try {
          const bindings = await conn.client.menu('/ip/hotspot/ip-binding').get().catch(() => []);
          const foundBind = (bindings || []).find(b => {
            const toIp = String(b['to-address'] || b.toAddress || '').toLowerCase();
            const bIp = String(b.address || '').toLowerCase();
            const isDisabled = (b.disabled === 'true' || b.disabled === true);
            return !isDisabled && (toIp === staticIp.toLowerCase() || bIp === staticIp.toLowerCase());
          });
          if (foundBind) isOnline = true;
        } catch {}
      }
    }

    if (!isOnline) {
      pppoeTrafficSamples.delete(key);
      const dbCust = db.prepare('SELECT bytes_in, bytes_out, bytes_in_daily, bytes_out_daily FROM customers WHERE id = ?').get(customerId);
      return res.json({ 
        ok: true, available: true, online: false, username: targetKey, 
        dailyRxBytes: dbCust?.bytes_in_daily || 0, dailyTxBytes: dbCust?.bytes_out_daily || 0,
        monthlyRxBytes: dbCust?.bytes_in || 0, monthlyTxBytes: dbCust?.bytes_out || 0,
        rxMbps: 0, txMbps: 0 
      });
    }

    // Hitung delta bytes
    let deltaDownload = 0;
    let deltaUpload = 0;

    if (prev) {
      deltaDownload = rawDownloadBytes >= prev.rawDownload ? (rawDownloadBytes - prev.rawDownload) : rawDownloadBytes;
      deltaUpload = rawUploadBytes >= prev.rawUpload ? (rawUploadBytes - prev.rawUpload) : rawUploadBytes;
    }

    pppoeTrafficSamples.set(key, { rawDownload: rawDownloadBytes, rawUpload: rawUploadBytes, t: now });

    // Jika queue ROS 6 belum menyediakan string rate, hitung delta waktu
    if (!hasLiveRateFromQueue && prev && prev.t) {
      const dtSec = Math.max(1, (now - prev.t) / 1000);
      liveDownloadMbps = Number(((deltaDownload * 8) / dtSec / 1000000).toFixed(3));
      liveUploadMbps = Number(((deltaUpload * 8) / dtSec / 1000000).toFixed(3));
    }

    // Akumulasikan ke database jika ada penambahan delta byte
    const dbCust = db.prepare('SELECT bytes_in, bytes_out, bytes_in_daily, bytes_out_daily FROM customers WHERE id = ?').get(customerId);
    const currentBytesIn = Number(dbCust?.bytes_in || 0);
    const currentBytesOut = Number(dbCust?.bytes_out || 0);
    const currentDailyIn = Number(dbCust?.bytes_in_daily || 0);
    const currentDailyOut = Number(dbCust?.bytes_out_daily || 0);

    if (deltaDownload > 0 || deltaUpload > 0) {
      db.prepare(`
        UPDATE customers 
        SET bytes_in_daily = ?,  
            bytes_out_daily = ?,
            bytes_in = ?,              
            bytes_out = ?              
        WHERE id = ?
      `).run(
        currentDailyIn + deltaDownload,
        currentDailyOut + deltaUpload,
        currentBytesIn + deltaDownload,
        currentBytesOut + deltaUpload,
        customerId
      );
    }

    const updatedCust = db.prepare('SELECT bytes_in, bytes_out, bytes_in_daily, bytes_out_daily FROM customers WHERE id = ?').get(customerId);

    return res.json({
      ok: true,
      available: true,
      online: true,
      username: targetKey,
      dailyRxBytes: updatedCust?.bytes_in_daily || (currentDailyIn + deltaDownload),   
      dailyTxBytes: updatedCust?.bytes_out_daily || (currentDailyOut + deltaUpload), 
      monthlyRxBytes: updatedCust?.bytes_in || (currentBytesIn + deltaDownload),       
      monthlyTxBytes: updatedCust?.bytes_out || (currentBytesOut + deltaUpload),      
      rxMbps: Number.isFinite(liveDownloadMbps) ? liveDownloadMbps : 0, 
      txMbps: Number.isFinite(liveUploadMbps) ? liveUploadMbps : 0     
    });

  } catch (e) {
    const dbCust = db.prepare('SELECT bytes_in, bytes_out, bytes_in_daily, bytes_out_daily FROM customers WHERE id = ?').get(customerId);
    return res.json({ 
      ok: true, available: true, online: false, 
      dailyRxBytes: dbCust?.bytes_in_daily || 0, dailyTxBytes: dbCust?.bytes_out_daily || 0,
      monthlyRxBytes: dbCust?.bytes_in || 0, monthlyTxBytes: dbCust?.bytes_out || 0,
      rxMbps: 0, txMbps: 0 
    });
  } finally {
    if (conn && conn.api) { try { conn.api.close(); } catch {} }
  }
});
// ==================== AKHIR PERBAIKAN: LIVE TRAFFIC & THROUGHPUT ROS6 / ROS7 ====================

// Scheduler: Mereset trafik harian jam 23:59 untuk kebutuhan Peta
const cron = require('node-cron');
cron.schedule('59 23 * * *', () => {
  try {
    db.prepare(`UPDATE customers SET bytes_in_daily = 0, bytes_out_daily = 0`).run();
    logger.info('[Scheduler] Berhasil mereset trafik harian (bytes_in_daily & bytes_out_daily) ke 0.');
  } catch (e) {
    logger.error('[Scheduler] Gagal mereset trafik harian: ' + e.message);
  }
});

// 1. Ambil detail ONU, Redaman Optik & WiFi dari GenieACS / OLT untuk modal detail
// ==================== [AWAL: DEVICE-INFO PRIORITAS 100% OLT UNTUK REDAMAN & JARAK] ====================
router.get('/api/customers/:id/device-info', requireAdminSession, async (req, res) => {
  try {
    const custId = Number(req.params.id);
    const customer = customerSvc.getCustomerById(custId);
    if (!customer) return res.status(404).json({ ok: false, error: 'Pelanggan tidak ditemukan' });

    let deviceInfo = {
      rxPower: '-',
      rxStatus: 'unknown',
      distance: '-',
      model: '-',
      ssid: '-',
      wifiPassword: '-',
      oltId: customer.olt_id || null,
      oltName: customer.olt_name || '-',
      onuIndex: null,
      odpName: customer.odp_name || '-',
      ponPort: customer.pon_port || '-',
      tag: customer.genieacs_tag || customer.phone || '-',
      serialNumber: '-'
    };

    // 1. PRIORITAS UTAMA: AMBIL REDAMAN & JARAK LANGSUNG DARI OLT (SNMP REAL-TIME)
    let oltAvailable = false;
    try {
      const opticalData = await oltSvc.getCustomerOptical(customer);
      if (opticalData && opticalData.available) {
        oltAvailable = true;
        if (opticalData.index) deviceInfo.onuIndex = opticalData.index;
        if (opticalData.rxPower && opticalData.rxPower !== 'N/A') {
          deviceInfo.rxPower = opticalData.rxPower;
          const numRx = parseFloat(opticalData.rxPower);
          if (!isNaN(numRx)) {
            if (numRx >= -23.0 && numRx <= -14.0) deviceInfo.rxStatus = 'good'; // Bagus (-14 s/d -23)
            else if (numRx < -23.0 && numRx >= -27.0) deviceInfo.rxStatus = 'warning'; // Warning (-23 s/d -27)
            else deviceInfo.rxStatus = 'critical'; // Bahaya / Drop
          }
        }
        if (opticalData.distance && opticalData.distance !== '-') {
          deviceInfo.distance = opticalData.distance;
        }
      }
    } catch (oltErr) {
      logger.debug('[device-info] OLT direct optical error: ' + oltErr.message);
    }

    // 2. AMBIL WIFI (SSID & PASSWORD) DARI GENIEACS (DAN REDAMAN CADANGAN JIKA OLT OFFLINE)
    const queryTag = customer.genieacs_tag || customer.pppoe_username || customer.phone;
    if (queryTag) {
      try {
        const acsData = await customerDevice.getCustomerDeviceData(queryTag);
        if (acsData && acsData.status !== 'Tidak ditemukan') {
          deviceInfo.model = acsData.model || acsData.productClass || '-';
          deviceInfo.ssid = acsData.ssid || '-';
          deviceInfo.serialNumber = acsData.serialNumber || '-';

          // Hanya gunakan redaman GenieACS jika OLT tidak memberikan nilai
          if ((deviceInfo.rxPower === '-' || deviceInfo.rxPower === 'N/A') && acsData.rxPower && acsData.rxPower !== 'N/A') {
            deviceInfo.rxPower = acsData.rxPower;
            const numRx = parseFloat(deviceInfo.rxPower);
            if (!isNaN(numRx)) {
              if (numRx >= -23.0 && numRx <= -14.0) deviceInfo.rxStatus = 'good';
              else if (numRx < -23.0 && numRx >= -27.0) deviceInfo.rxStatus = 'warning';
              else deviceInfo.rxStatus = 'critical';
            }
          }
        }
      } catch (acsErr) {
        logger.debug('[device-info] GenieACS fetch error: ' + acsErr.message);
      }
    }

    return res.json({ ok: true, data: deviceInfo });
// ==================== [AKHIR: DEVICE-INFO PRIORITAS 100% OLT UNTUK REDAMAN & JARAK] ====================
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// 2. Blokir Akses Manual MikroTik (Disable PPPoE Secret / Hotspot User)
router.post('/customers/:id/block-secret', requireAdminSession, async (req, res) => {
  try {
    const custId = Number(req.params.id);
    const customer = customerSvc.getCustomerById(custId);
    if (!customer) throw new Error('Pelanggan tidak ditemukan');

    const routerId = customerSvc.getEffectiveRouterId(customer.router_id);
    let conn = null;
    try {
      conn = routerId ? await mikrotikService.getConnection(routerId) : await mikrotikService.getConnection();
      if (conn && conn.client) {
        if (customer.pppoe_username) {
          const secrets = await conn.client.menu('/ppp/secret').where('name', customer.pppoe_username).get();
          for (const s of secrets) {
            const sid = s['.id'] || s.id;
            await conn.client.menu('/ppp/secret').set(sid, { disabled: 'yes' });
          }
          await mikrotikService.kickPppoeUser(customer.pppoe_username, routerId);
        } else if (customer.hotspot_username) {
          await mikrotikService.setHotspotUserDisabled(customer.hotspot_username, true, routerId);
        }
      }
    } finally {
      if (conn && conn.api) conn.api.close();
    }

    db.prepare("UPDATE customers SET status = 'suspended' WHERE id = ?").run(custId);
    req.session._msg = { type: 'success', text: `Akses MikroTik untuk "${customer.name}" berhasil DIBLOKIR / DINONAKTIFKAN.` };
  } catch (err) {
    req.session._msg = { type: 'error', text: 'Gagal memblokir: ' + err.message };
  }
  res.redirect('back');
});

/* ==================== [AWAL: REBOOT PELANGGAN LANGSUNG DARI OLT ASLI] ==================== */
router.post('/api/customers/:id/reboot-onu-olt', requireAdminSession, restrictToAdmin, async (req, res) => {
  try {
    const custId = Number(req.params.id);
    const customer = customerSvc.getCustomerById(custId);
    if (!customer) return res.status(404).json({ success: false, message: 'Pelanggan tidak ditemukan' });

    // 1. Tentukan OLT ID milik pelanggan
    let oltId = customer.olt_id ? Number(customer.olt_id) : null;
    if (!oltId && customer.odp_id) {
      const odp = db.prepare('SELECT olt_id FROM odps WHERE id = ?').get(customer.odp_id);
      if (odp && odp.olt_id) oltId = Number(odp.olt_id);
    }
    if (!oltId) {
      const allActive = oltSvc.getActiveOlts();
      if (allActive && allActive.length > 0) oltId = allActive[0].id;
    }

    if (!oltId) {
      return res.status(400).json({ success: false, message: 'Pelanggan ini belum dihubungkan ke OLT' });
    }

    // 2. Ambil data ONU dari OLT untuk mencocokkan index (seperti index 4718626)
    const stats = await oltSvc.getOltStats(oltId, true);
    if (!stats || !Array.isArray(stats.onus) || stats.onus.length === 0) {
      return res.status(400).json({ success: false, message: 'Gagal membaca daftar ONU di OLT atau OLT offline' });
    }

    const snClean = String(customer.genieacs_tag || customer.mac_address || '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
    const pppoeClean = String(customer.pppoe_username || '').trim().toLowerCase();
    const nameClean = String(customer.name || '').trim().toLowerCase();

    let targetIndex = null;
    let targetName = customer.name;

    for (const onu of stats.onus) {
      const onuSn = String(onu.sn || '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
      const onuName = String(onu.name || '').trim().toLowerCase();

      // Cocokkan berdasarkan SN/Tag, Username PPPoE, atau Nama (Sama persis seperti di menu OLT)
      if (snClean && snClean.length >= 4 && (onuSn === snClean || onuSn.includes(snClean) || snClean.includes(onuSn))) {
        targetIndex = onu.index || onu.id;
        targetName = onu.name;
        break;
      }
      if (pppoeClean && onuName === pppoeClean) {
        targetIndex = onu.index || onu.id;
        targetName = onu.name;
        break;
      }
      if (nameClean && onuName === nameClean) {
        targetIndex = onu.index || onu.id;
        targetName = onu.name;
        break;
      }
    }

    if (!targetIndex) {
      return res.status(404).json({ success: false, message: 'Modem pelanggan tidak ditemukan di daftar ONU OLT' });
    }

    // 3. Panggil fungsi reboot bawaan OLT yang SUDAH TERBUKTI SUKSES
    await oltSvc.rebootOnu(oltId, targetIndex);
    logger.info(`[Customer-Reboot-OLT] Berhasil reboot modem pelanggan ${customer.name} (Index OLT: ${targetIndex})`);

    return res.json({ 
      success: true, 
      message: `Perintah reboot berhasil dikirim via OLT ke modem [${targetName}] (Index: ${targetIndex}).` 
    });
  } catch (err) {
    logger.error('[Customer-Reboot-OLT Error]:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// === JALUR PELANGGAN ===
router.post('/api/customers/:id/cable-path', requireAdminSession, (req, res) => {
  try {
    const id = Number(req.params.id);
    const { path } = req.body;
    if (!id) throw new Error('ID pelanggan tidak valid');
    customerSvc.updateCustomerCablePath(id, path);
    res.json({ ok: true });
  } catch (e) {
    console.error('[API] Save Cable Path Error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// === [KODE BARU: API SIMPAN JALUR KABEL TRUNK ANTAR ODP] ===
router.post('/api/odps/:id/cable-path', requireAdminSession, (req, res) => {
  try {
    const id = Number(req.params.id);
    const { path: cablePath } = req.body;
    if (!id) throw new Error('ID ODP tidak valid');
    db.prepare('UPDATE odps SET cable_path = ? WHERE id = ?').run(String(cablePath || ''), id);
    res.json({ ok: true });
  } catch (e) {
    console.error('[API] Save ODP Cable Path Error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});
// ==========================================================

router.post('/odps', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), (req, res) => {
  try {
    odpSvc.createOdp(req.body);
    req.session._msg = { type: 'success', text: 'ODP berhasil ditambahkan.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/map');
});

router.post('/odps/:id/update', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), (req, res) => {
  try {
    odpSvc.updateOdp(req.params.id, req.body);
    req.session._msg = { type: 'success', text: 'ODP berhasil diperbarui.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/map');
});

router.post('/odps/:id/delete', requireAdminSession, restrictToAdmin, (req, res) => {
  try {
    odpSvc.deleteOdp(req.params.id);
    req.session._msg = { type: 'success', text: 'ODP berhasil dihapus.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/map');
});

// --- [KODE BARU: API HITUNG REDAMAN JALUR KABEL KE ODP/PELANGGAN] ---
const { calculateLinkBudget } = require('../utils/opticCalculator'); // Sesuaikan path jika letak file opticCalculator.js berbeda

// === [KODE BARU: KALKULASI REDAMAN LINK BUDGET LENGKAP KE PELANGGAN] ===
router.post('/api/odps/calculate-budget', requireAdminSession, express.json(), (req, res) => {
  try {
    const { odpId, distanceMeters, spliceCount, connNear, connFar, customInputDbm } = req.body;
    
    if (!odpId) throw new Error('ODP ID wajib disertakan');

    const odp = odpSvc.getOdpById(odpId);
    if (!odp) throw new Error('Data ODP tidak ditemukan');

    // Daya masuk ODP (sudah merupakan daya riil sampai di box ODP ini)
    let inputPower = customInputDbm !== undefined ? parseFloat(customInputDbm) : parseFloat(odp.input_power_dbm || -9.0);

    // 1. Loss konektor ujung pangkal (di box ODP)
    const nearLoss = connNear === 'FASTCON' ? 1.00 : 0.30;

    // 2. Loss konektor ujung akhir (di modem/roset pelanggan)
    const farLoss = connFar === 'PIGTAIL' ? 0.30 : 1.00;

    // 3. Loss kabel fiber optik (standar G.652: 0.35 dB/km)
    const meters = parseFloat(distanceMeters || 0);
    const fiberLoss = parseFloat(((meters / 1000) * 0.35).toFixed(2));

    // 4. Loss titik sambungan las (splice tengah jika ada)
    const splices = parseInt(spliceCount || 0, 10);
    const midSpliceLoss = parseFloat((splices * 0.20).toFixed(2));

    // Total Loss di sepanjang kabel drop core sampai modem
    const totalDropLoss = parseFloat((fiberLoss + nearLoss + farLoss + midSpliceLoss).toFixed(2));
    const finalPowerDbm = parseFloat((inputPower - totalDropLoss).toFixed(2));

    let status = 'BAGUS';
    if (finalPowerDbm < -24.0) status = 'WARNING';
    if (finalPowerDbm < -27.0) status = 'CRITICAL_LOS';

    res.json({ 
      ok: true, 
      budget: {
        distanceMeters: meters,
        fiberLoss,
        nearLoss,
        farLoss,
        spliceCount: splices,
        midSpliceLoss,
        totalLoss: totalDropLoss,
        finalPowerDbm,
        status
      }, 
      odpName: odp.name 
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});
// =======================================================================
// ------------------------------------------------------------------

/* === AWAL PERUBAHAN: ROUTE TEKNISI DENGAN TAB PENDAFTARAN / INSTALASI === */
// --- TECHNICIAN MANAGEMENT ---
router.get('/technicians', requireAdminSession, requireSidebarMenuAccess('technicians'), restrictToAdmin, (req, res) => {
  const technicians = adminSvc.getAllTechnicians();
  const masterAreas = areaSvc.getAllAreas();

  // Ambil daftar pendaftaran baru dari database
  let registrations = [];
  try {
    registrations = db.prepare(`
      SELECT r.*, p.name as package_name, p.price as package_price, t.name as current_tech_name
      FROM registrations r
      LEFT JOIN packages p ON r.package_id = p.id
      LEFT JOIN technicians t ON r.technician_id = t.id
      ORDER BY r.id DESC
    `).all() || [];
  } catch (err) {
    registrations = [];
  }

  const packages = customerSvc.getAllPackages() || [];
  res.render('admin/technicians', { 
    title: 'Manajemen Teknisi & Pemasangan', 
    company: company(), 
    activePage: 'technicians', 
    technicians, 
    registrations,
    packages, // <-- Pastikan packages dikirim ke view
    masterAreas, 
    msg: flashMsg(req) 
  });
});

// Update/Tugaskan Teknisi dari Web Dashboard
router.post('/registrations/:id/assign', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const regId = Number(req.params.id);
    const { technician_id, install_date, status } = req.body;

    const tech = db.prepare('SELECT * FROM technicians WHERE id = ?').get(technician_id);
    const techName = tech ? tech.name : '';

    db.prepare(`
      UPDATE registrations 
      SET technician_id = ?, technician_name = ?, install_date = ?, status = ?, updated_at = (datetime('now', '+7 hours'))
      WHERE id = ?
    `).run(technician_id ? Number(technician_id) : null, techName, install_date || '', status || 'assigned', regId);

    // Kirim notifikasi WA ke teknisi jika dipilih dan berstatus assigned
    const settings = getSettings();
    if (settings.whatsapp_enabled && tech && tech.phone && (status === 'assigned' || !status)) {
      try {
        const { sendWA } = await import('../services/whatsappBot.mjs');
        const reg = db.prepare('SELECT r.*, p.name as package_name FROM registrations r LEFT JOIN packages p ON r.package_id = p.id WHERE r.id = ?').get(regId);
        const formattedId = String(regId).padStart(3, '0');
        const mapLine = (reg.lat && reg.lng) ? `\n🗺️ *Maps:* https://maps.google.com/?q=${encodeURIComponent(reg.lat)},${encodeURIComponent(reg.lng)}` : '';

        const { formatRegTechMessage } = require('../services/whatsappService');
        const techMsg = formatRegTechMessage({
          id: formattedId,
          installDate: install_date || '-',
          name: reg.name,
          phone: reg.phone,
          address: reg.address,
          packageName: reg.package_name || 'Reguler',
          mapLine: (reg.lat && reg.lng) ? `https://maps.google.com/?q=${encodeURIComponent(reg.lat)},${encodeURIComponent(reg.lng)}` : ''
        });

        let techPhoneDigits = String(tech.phone).replace(/\D/g, '');
        if (techPhoneDigits.startsWith('0')) techPhoneDigits = '62' + techPhoneDigits.slice(1);
        await sendWA(techPhoneDigits, techMsg);
      } catch (waErr) {
        logger.error('[Web Assign WA Error]: ' + waErr.message);
      }
    }

    req.session._msg = { type: 'success', text: `Pendaftaran #${String(regId).padStart(3, '0')} berhasil diperbarui.` };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal memperbarui: ' + e.message };
  }
  res.redirect('/admin/technicians?tab=registrations');
});

// Hapus pendaftaran
router.post('/registrations/:id/delete', requireAdminSession, restrictToAdmin, (req, res) => {
  try {
    db.prepare('DELETE FROM registrations WHERE id = ?').run(Number(req.params.id));
    req.session._msg = { type: 'success', text: 'Data pendaftaran berhasil dihapus.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal hapus: ' + e.message };
  }
  res.redirect('/admin/technicians?tab=registrations');
});
/* === AKHIR PERUBAHAN: ROUTE TEKNISI DENGAN TAB PENDAFTARAN / INSTALASI === */

// === AWAL PENAMBAHAN: EDIT DATA PENDAFTARAN OLEH ADMIN ===
router.post('/registrations/:id/update', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), (req, res) => {
  try {
    const regId = Number(req.params.id);
    const { name, phone, email, address, package_id, notes } = req.body;

    if (!name || !phone || !address) {
      throw new Error('Nama, nomor WhatsApp, dan alamat wajib diisi.');
    }

    db.prepare(`
      UPDATE registrations 
      SET name = ?, phone = ?, email = ?, address = ?, package_id = ?, notes = ?, updated_at = (datetime('now', '+7 hours'))
      WHERE id = ?
    `).run(
      String(name).trim(),
      String(phone).trim(),
      String(email || '').trim(),
      String(address).trim(),
      package_id ? Number(package_id) : null,
      String(notes || '').trim(),
      regId
    );

    req.session._msg = { type: 'success', text: `Data pendaftaran #${String(regId).padStart(3, '0')} berhasil diperbarui.` };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal update pendaftaran: ' + e.message };
  }
  res.redirect('/admin/technicians?tab=registrations');
});

// === AWAL PENAMBAHAN: REJECT PENDAFTARAN & KIRIM WA BOT ===
router.post('/registrations/:id/reject', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const regId = Number(req.params.id);
    const { reason } = req.body;
    const cleanReason = String(reason || 'Wilayah di luar jangkauan jaringan atau kapasitas ODP penuh.').trim();

    const reg = db.prepare('SELECT * FROM registrations WHERE id = ?').get(regId);
    if (!reg) throw new Error('Data pendaftaran tidak ditemukan.');

    const formattedId = String(regId).padStart(3, '0');
    const updateNotes = reg.notes ? `${reg.notes} | Ditolak: ${cleanReason}` : `Ditolak: ${cleanReason}`;

    // 1. Update status jadi rejected di database
    db.prepare(`
      UPDATE registrations 
      SET status = 'rejected', notes = ?, updated_at = (datetime('now', '+7 hours'))
      WHERE id = ?
    `).run(updateNotes, regId);

    // 2. Kirim pesan permohonan maaf ke WhatsApp pemohon
    const settings = getSettings();
    let waSent = false;
    if (settings.whatsapp_enabled && reg.phone) {
      try {
        const { sendWA } = await import('../services/whatsappBot.mjs');
        const { formatRegRejectMessage } = require('../services/whatsappService');
        const rejectMsg = formatRegRejectMessage({
          id: formattedId,
          name: reg.name,
          reason: cleanReason,
          company: settings.company_header || company()
        });

        let digits = String(reg.phone).replace(/\D/g, '');
        if (digits.startsWith('0')) digits = '62' + digits.slice(1);
        else if (digits.startsWith('8')) digits = '62' + digits;

        waSent = await sendWA(digits, rejectMsg);
      } catch (errWA) {
        logger.error('[Reject WA Error]: ' + errWA.message);
      }
    }

    req.session._msg = { 
      type: 'success', 
      text: `Pendaftaran #${formattedId} telah DITOLAK (Status: REJECTED).${waSent ? ' Pesan permohonan maaf berhasil dikirim ke WhatsApp pemohon.' : ''}` 
    };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal menolak pendaftaran: ' + e.message };
  }
  res.redirect('/admin/technicians?tab=registrations');
});
// === AKHIR PENAMBAHAN ===

router.post('/technicians', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), (req, res) => {
  try {
    adminSvc.createTechnician(req.body);
    req.session._msg = { type: 'success', text: 'Teknisi berhasil ditambahkan.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/technicians');
});

router.post('/technicians/:id/update', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), (req, res) => {
  try {
    adminSvc.updateTechnician(req.params.id, req.body);
    req.session._msg = { type: 'success', text: 'Data teknisi diperbarui.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/technicians');
});

router.post('/technicians/:id/delete', requireAdminSession, restrictToAdmin, (req, res) => {
  adminSvc.deleteTechnician(req.params.id);
  req.session._msg = { type: 'success', text: 'Teknisi berhasil dihapus.' };
  res.redirect('/admin/technicians');
});

// --- CASHIER MANAGEMENT ---
router.get('/cashiers', requireAdminSession, requireSidebarMenuAccess('cashiers'), restrictToAdmin, (req, res) => {
  const cashiers = adminSvc.getAllCashiers();
  res.render('admin/cashiers', { title: 'Manajemen Kasir', company: company(), activePage: 'cashiers', cashiers, msg: flashMsg(req) });
});

router.post('/cashiers', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), (req, res) => {
  try {
    adminSvc.createCashier(req.body);
    req.session._msg = { type: 'success', text: 'Kasir berhasil ditambahkan.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/cashiers');
});

router.post('/cashiers/:id/update', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), (req, res) => {
  try {
    adminSvc.updateCashier(req.params.id, req.body);
    req.session._msg = { type: 'success', text: 'Data kasir diperbarui.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/cashiers');
});

router.post('/cashiers/:id/delete', requireAdminSession, restrictToAdmin, (req, res) => {
  adminSvc.deleteCashier(req.params.id);
  req.session._msg = { type: 'success', text: 'Kasir berhasil dihapus.' };
  res.redirect('/admin/cashiers');
});

// --- STAFF / ADMIN MITRA MANAGEMENT ---
router.get('/staff', requireAdminSession, restrictToAdmin, (req, res) => {
  const staffList = staffSvc.getAllStaff();
  res.render('admin/staff', {
    title: 'Manajemen Admin Mitra & Staf',
    company: company(),
    activePage: 'staff',
    staffList,
    msg: flashMsg(req)
  });
});

router.post('/staff', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), (req, res) => {
  try {
    staffSvc.createStaff(req.body);
    req.session._msg = { type: 'success', text: 'Akun staf/mitra baru berhasil ditambahkan.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal menambah staf: ' + e.message };
  }
  res.redirect('/admin/staff');
});

router.post('/staff/:id/update', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), (req, res) => {
  try {
    staffSvc.updateStaff(req.params.id, req.body);
    req.session._msg = { type: 'success', text: 'Data staf/mitra berhasil diperbarui.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal memperbarui staf: ' + e.message };
  }
  res.redirect('/admin/staff');
});

router.post('/staff/:id/delete', requireAdminSession, restrictToAdmin, (req, res) => {
  try {
    staffSvc.deleteStaff(req.params.id);
    req.session._msg = { type: 'success', text: 'Akun staf/mitra berhasil dihapus.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal menghapus staf: ' + e.message };
  }
  res.redirect('/admin/staff');
});


// --- COLLECTOR MANAGEMENT ---
router.get('/collectors', requireAdminSession, requireSidebarMenuAccess('collectors'), restrictToAdmin, (req, res) => {
  const collectors = adminSvc.getAllCollectors();
  const masterAreas = areaSvc.getAllAreas();
  res.render('admin/collectors', { title: 'Manajemen Kolektor', company: company(), activePage: 'collectors', collectors, masterAreas, msg: flashMsg(req) });
});

router.post('/collectors', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), (req, res) => {
  try {
    adminSvc.createCollector(req.body);
    req.session._msg = { type: 'success', text: 'Kolektor berhasil ditambahkan.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/collectors');
});

router.post('/collectors/:id/update', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), (req, res) => {
  try {
    adminSvc.updateCollector(req.params.id, req.body);
    req.session._msg = { type: 'success', text: 'Data kolektor diperbarui.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/collectors');
});

router.post('/collectors/:id/delete', requireAdminSession, restrictToAdmin, (req, res) => {
  adminSvc.deleteCollector(req.params.id);
  req.session._msg = { type: 'success', text: 'Kolektor berhasil dihapus.' };
  res.redirect('/admin/collectors');
});

// --- AREA MANAGEMENT ---
router.get('/areas', requireAdminSession, requireSidebarMenuAccess('areas'), (req, res) => {
  const areas = areaSvc.getAllAreas();
  res.render('admin/areas', { title: 'Manajemen Area', company: company(), activePage: 'areas', areas, msg: flashMsg(req) });
});

router.post('/areas', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    areaSvc.createArea(req.body);
    req.session._msg = { type: 'success', text: 'Area berhasil ditambahkan.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/areas');
});

router.post('/areas/:id/update', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    areaSvc.updateArea(req.params.id, req.body);
    req.session._msg = { type: 'success', text: 'Data area berhasil diperbarui.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/areas');
});

router.post('/areas/:id/delete', requireAdminSession, (req, res) => {
  try {
    areaSvc.deleteArea(req.params.id);
    req.session._msg = { type: 'success', text: 'Area berhasil dihapus.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/areas');
});

router.get('/collector-payments', requireAdminSession, requireSidebarMenuAccess('collector_payments'), (req, res) => {
  const status = String(req.query.status || 'pending').trim() || 'pending';
  const rows = db.prepare(`
    SELECT r.*,
           col.name as collector_name, col.username as collector_username,
           i.period_month, i.period_year, i.amount as invoice_amount, i.status as invoice_status,
           c.name as customer_name, c.phone as customer_phone, c.address as customer_address, c.lat, c.lng
    FROM collector_payment_requests r
    JOIN collectors col ON col.id = r.collector_id
    JOIN invoices i ON i.id = r.invoice_id
    JOIN customers c ON c.id = r.customer_id
    WHERE r.status = ?
    ORDER BY r.id DESC
    LIMIT 500
  `).all(status);

  res.render('admin/collector_payments', {
    title: 'Approval Pembayaran Kolektor',
    company: company(),
    activePage: 'collector_payments',
    status,
    rows,
    msg: flashMsg(req)
  });
});

router.post('/collector-payments/:id/approve', requireAdminSession, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const id = Number(req.params.id || 0);
    if (!Number.isFinite(id) || id <= 0) throw new Error('ID tidak valid');
    const decidedNote = String(req.body.decided_note || '').trim();

    const row = db.prepare(`
      SELECT r.*, col.name as collector_name, col.username as collector_username
      FROM collector_payment_requests r
      JOIN collectors col ON col.id = r.collector_id
      WHERE r.id = ?
    `).get(id);
    if (!row) throw new Error('Request tidak ditemukan');
    if (String(row.status) !== 'pending') throw new Error('Request sudah diproses');

    const inv = billingSvc.getInvoiceById(row.invoice_id);
    if (!inv) throw new Error('Invoice tidak ditemukan');
    if (String(inv.status) === 'paid') {
      db.prepare(`
        UPDATE collector_payment_requests
        SET status='rejected', decided_by_role=?, decided_by_name=?, decided_note=?, decided_at=(NOW_LOCAL())
        WHERE id=?
      `).run(req.session.isCashier ? 'cashier' : 'admin', resolvePaidByName(req, 'Admin'), 'Invoice sudah lunas', id);
      req.session._msg = { type: 'error', text: 'Invoice sudah lunas, request ditolak.' };
      return res.redirect('back');
    }

    const collectorLabel =
      (`Kolektor ${(String(row.collector_name || '').trim())}` +
        (String(row.collector_username || '').trim() ? ` (@${String(row.collector_username).trim()})` : '')).trim();

    const approver = resolvePaidByName(req, 'Admin');
    const notesParts = [
      'Via Kolektor',
      collectorLabel,
      `Approved oleh ${approver}`,
    ];
    if (row.note) notesParts.push(String(row.note));
    if (decidedNote) notesParts.push(`Approval: ${decidedNote}`);
    const notes = notesParts.join(' | ');

    billingSvc.markAsPaid(Number(row.invoice_id), collectorLabel, notes);

    db.prepare(`
      UPDATE collector_payment_requests
      SET status='approved', decided_by_role=?, decided_by_name=?, decided_note=?, decided_at=(NOW_LOCAL())
      WHERE id=?
    `).run(req.session.isCashier ? 'cashier' : 'admin', approver, decidedNote, id);

    const customer = customerSvc.getCustomerById(inv.customer_id);
    if (customer && customer.phone) {
      const pkg = customer.package_id ? customerSvc.getPackageById(customer.package_id) : null;
      await sendPaymentSuccessWA(
        customer.phone,
        customer.name,
        `${inv.period_month}/${inv.period_year}`,
        Number(inv.amount || 0).toLocaleString('id-ID'),
        collectorLabel,
        {
          customerId: customer.id,
          invoiceId: inv.id,
          username: customer.pppoe_username || customer.id,
          packageName: pkg?.name || customer.package_name || '-',
          paidAt: new Date()
        }
      );
    }

    const freshCustomer = customerSvc.getAllCustomers().find(c => Number(c.id) === Number(inv.customer_id));
    if (freshCustomer && freshCustomer.status === 'suspended' && freshCustomer.unpaid_count === 0) {
      await customerSvc.activateCustomer(inv.customer_id);
    }

    req.session._msg = { type: 'success', text: 'Request disetujui dan invoice dilunasi.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + (e.message || String(e)) };
  }
  res.redirect('back');
});

router.post('/collector-payments/:id/reject', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    const id = Number(req.params.id || 0);
    if (!Number.isFinite(id) || id <= 0) throw new Error('ID tidak valid');
    const decidedNote = String(req.body.decided_note || '').trim();
    const row = db.prepare(`SELECT * FROM collector_payment_requests WHERE id=?`).get(id);
    if (!row) throw new Error('Request tidak ditemukan');
    if (String(row.status) !== 'pending') throw new Error('Request sudah diproses');
    const approver = resolvePaidByName(req, 'Admin');
    db.prepare(`
      UPDATE collector_payment_requests
      SET status='rejected', decided_by_role=?, decided_by_name=?, decided_note=?, decided_at=(NOW_LOCAL())
      WHERE id=?
    `).run(req.session.isCashier ? 'cashier' : 'admin', approver, decidedNote, id);
    req.session._msg = { type: 'success', text: 'Request ditolak.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + (e.message || String(e)) };
  }
  res.redirect('back');
});
// ─── CASHIER ATTENDANCE ──────────────────────────────────────────────────────
router.get('/cashiers/attendance', requireAdminSession, requireSidebarMenuAccess('cashier_attendance'), (req, res) => {
  try {
    const cashierId = req.session.cashierId || null;
    const cashierName = req.session.cashierName || req.session.username || 'Kasir';
    
    if (!cashierId) {
      req.session._msg = { type: 'error', text: 'Session kasir tidak valid' };
      return res.redirect('/admin');
    }

    const todayAttendance = attendanceSvc.getTodayAttendance('cashier', cashierId);
    const history = attendanceSvc.getAttendanceHistory('cashier', cashierId, 10);
    
    const now = getCurrentDateInTimezone();
    const summary = attendanceSvc.getMonthlyAttendanceSummary(
      'cashier', 
      cashierId, 
      now.getFullYear(), 
      now.getMonth() + 1
    );
    
    res.render('admin/cashier_attendance', {
      title: 'Absensi Saya',
      company: company(),
      activePage: 'cashier_attendance',
      session: req.session,
      cashierName,
      todayAttendance,
      history,
      summary,
      msg: flashMsg(req),
      t: (key, defaultVal) => defaultVal || key
    });
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal memuat absensi: ' + e.message };
    res.redirect('/admin');
  }
});

router.post('/cashiers/attendance/checkin', requireAdminSession, uploadAttendance.single('photo'), (req, res) => {
  try {
    const cashierId = req.session.cashierId;
    const cashierName = req.session.cashierName || req.session.username;
    
    if (!cashierId) {
      return res.json({ success: false, message: 'Session kasir tidak valid' });
    }

    if (!req.file) {
      return res.json({ success: false, message: 'Foto check-in wajib diunggah' });
    }
    
    const today = attendanceSvc.getTodayAttendance('cashier', cashierId);
    if (today) {
      removeAttendanceFile(req.file);
      return res.json({ success: false, message: 'Anda sudah melakukan check-in hari ini' });
    }
    
    const result = attendanceSvc.checkIn({
      employee_type: 'cashier',
      employee_id: cashierId,
      employee_name: cashierName,
      lat: req.body.lat || '',
      lng: req.body.lng || '',
      note: req.body.note || '',
      photo: req.file ? '/uploads/attendance/' + req.file.filename : ''
    });
    
    res.json({ success: true, message: 'Check-in berhasil!', id: result.lastInsertRowid });
  } catch (e) {
    removeAttendanceFile(req.file);
    res.json({ success: false, message: 'Gagal check-in: ' + e.message });
  }
});

router.post('/cashiers/attendance/checkout', requireAdminSession, uploadAttendance.single('photo'), (req, res) => {
  try {
    const cashierId = req.session.cashierId;
    
    if (!cashierId) {
      return res.json({ success: false, message: 'Session kasir tidak valid' });
    }

    if (!req.file) {
      return res.json({ success: false, message: 'Foto check-out wajib diunggah' });
    }
    
    const today = attendanceSvc.getTodayAttendance('cashier', cashierId);
    if (!today) {
      removeAttendanceFile(req.file);
      return res.json({ success: false, message: 'Anda belum check-in hari ini' });
    }
    
    if (today.status === 'checked_out') {
      removeAttendanceFile(req.file);
      return res.json({ success: false, message: 'Anda sudah check-out hari ini' });
    }
    
    attendanceSvc.checkOut(today.id, {
      lat: req.body.lat || '',
      lng: req.body.lng || '',
      note: req.body.note || '',
      photo: req.file ? '/uploads/attendance/' + req.file.filename : ''
    });
    
    res.json({ success: true, message: 'Check-out berhasil!' });
  } catch (e) {
    removeAttendanceFile(req.file);
    res.json({ success: false, message: 'Gagal check-out: ' + e.message });
  }
});


router.get('/cashiers/reports', requireAdminSession, requireSidebarMenuAccess('cashiers_reports'), (req, res) => {
  const allCashiers = adminSvc.getAllCashiers();
  const isAdmin = Boolean(req.session?.isAdmin);
  const isCashier = Boolean(req.session?.isCashier);

  const requested = req.query.cashierId != null && String(req.query.cashierId).trim() !== ''
    ? Number(req.query.cashierId)
    : null;

  const cashierId =
    isCashier && !isAdmin
      ? Number(req.session.cashierId || 0) || null
      : requested;

  const selectedCashier = cashierId
    ? (allCashiers || []).find(c => Number(c.id) === Number(cashierId)) || null
    : null;

  const paidByExact = selectedCashier
    ? (`Kasir ${(String(selectedCashier.name || '').trim())}` + (String(selectedCashier.username || '').trim() ? ` (@${String(selectedCashier.username).trim()})` : '')).trim()
    : null;

  const invWhere = [];
  const invParams = [];
  invWhere.push(`i.status='paid'`);
  invWhere.push(`i.paid_by_name LIKE 'Kasir %'`);
  if (paidByExact) {
    invWhere.push(`i.paid_by_name = ?`);
    invParams.push(paidByExact);
  }

  const invoiceRows = db.prepare(`
    SELECT i.id as ref_id,
           i.paid_at as at,
           i.paid_by_name as actor_name,
           i.amount as amount,
           i.notes as notes,
           i.period_month,
           i.period_year,
           c.name as customer_name,
           c.phone as customer_phone,
           p.name as package_name
    FROM invoices i
    JOIN customers c ON i.customer_id = c.id
    LEFT JOIN packages p ON c.package_id = p.id
    WHERE ${invWhere.join(' AND ')}
    ORDER BY datetime(i.paid_at) DESC, i.id DESC
    LIMIT 500
  `).all(...invParams).map(r => ({
    kind: 'invoice',
    at: r.at,
    actor_name: r.actor_name,
    amount: Number(r.amount || 0),
    notes: r.notes || '',
    ref_id: r.ref_id,
    customer_name: r.customer_name || '',
    customer_phone: r.customer_phone || '',
    period_month: r.period_month,
    period_year: r.period_year,
    package_name: r.package_name || ''
  }));

  const topupWhere = [];
  const topupParams = [];
  topupWhere.push(`t.type='topup'`);
  topupWhere.push(`t.note LIKE 'Kasir %:%'`);
  if (paidByExact) {
    topupWhere.push(`t.note LIKE ?`);
    topupParams.push(`${paidByExact}:%`);
  }

  const topupRows = db.prepare(`
    SELECT t.id as ref_id,
           t.created_at as at,
           t.amount_buy as amount,
           t.note as notes,
           a.name as agent_name,
           a.username as agent_username
    FROM agent_transactions t
    JOIN agents a ON t.agent_id = a.id
    WHERE ${topupWhere.join(' AND ')}
    ORDER BY datetime(t.created_at) DESC, t.id DESC
    LIMIT 500
  `).all(...topupParams).map(r => {
    const rawNote = String(r.notes || '');
    const idx = rawNote.indexOf(':');
    const actor = idx > 0 ? rawNote.slice(0, idx).trim() : '';
    const rest = idx > 0 ? rawNote.slice(idx + 1).trim() : rawNote.trim();
    return {
      kind: 'agent_topup',
      at: r.at,
      actor_name: actor || 'Kasir',
      amount: Number(r.amount || 0),
      notes: rest,
      ref_id: r.ref_id,
      agent_name: r.agent_name || '',
      agent_username: r.agent_username || ''
    };
  });

  const rows = [...invoiceRows, ...topupRows].sort((a, b) => {
    const atA = a && a.at ? String(a.at) : '';
    const atB = b && b.at ? String(b.at) : '';
    if (atA !== atB) return atB.localeCompare(atA);
    return Number(b?.ref_id || 0) - Number(a?.ref_id || 0);
  }).slice(0, 800);

  const invSumRow = db.prepare(`
    SELECT COUNT(1) as cnt, SUM(i.amount) as total
    FROM invoices i
    WHERE ${invWhere.join(' AND ')}
  `).get(...invParams);

  const topupSumRow = db.prepare(`
    SELECT COUNT(1) as cnt, SUM(t.amount_buy) as total
    FROM agent_transactions t
    WHERE ${topupWhere.join(' AND ')}
  `).get(...topupParams);

  const safeCashiers = isAdmin
    ? allCashiers
    : selectedCashier
      ? [selectedCashier]
      : [];

  res.render('admin/cashier_reports', {
    title: 'Laporan Kasir',
    company: company(),
    activePage: 'cashiers_reports',
    cashiers: safeCashiers,
    cashierId: cashierId || '',
    paidByExact: paidByExact || '',
    rows,
    summary: {
      count: Number(invSumRow?.cnt || 0) + Number(topupSumRow?.cnt || 0),
      total: Number(invSumRow?.total || 0) + Number(topupSumRow?.total || 0),
      invoice_count: Number(invSumRow?.cnt || 0),
      invoice_total: Number(invSumRow?.total || 0),
      topup_count: Number(topupSumRow?.cnt || 0),
      topup_total: Number(topupSumRow?.total || 0)
    },
    msg: flashMsg(req)
  });
});

// --- AGENT MANAGEMENT ---
router.get('/agents', requireAdminSession, requireSidebarMenuAccess('agents'), (req, res) => {
  const agents = agentSvc.getAllAgents();
  const routers = mikrotikService.getAllRouters();
  res.render('admin/agents', {
    title: 'Manajemen Agent',
    company: company(),
    activePage: 'agents',
    agents,
    routers,
    msg: flashMsg(req)
  });
});

router.post('/agents', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), (req, res) => {
  try {
    agentSvc.createAgent(req.body);
    req.session._msg = { type: 'success', text: 'Agent berhasil ditambahkan.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/agents');
});

router.post('/agents/:id/update', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), (req, res) => {
  try {
    agentSvc.updateAgent(req.params.id, req.body);
    req.session._msg = { type: 'success', text: 'Data agent diperbarui.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/agents');
});

router.post('/agents/:id/delete', requireAdminSession, restrictToAdmin, (req, res) => {
  try {
    agentSvc.deleteAgent(req.params.id);
    req.session._msg = { type: 'success', text: 'Agent berhasil dihapus.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/agents');
});

router.post('/agents/:id/topup', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    const amount = Number(req.body.amount || 0);
    const note = String(req.body.note || '').trim();
    const actorName = req.session?.isCashier ? resolvePaidByName(req, 'Kasir') : (req.session.adminUser || 'Admin');
    agentSvc.topupAgent(req.params.id, amount, note, actorName);
    req.session._msg = { type: 'success', text: 'Topup saldo berhasil.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal topup: ' + e.message };
  }
  res.redirect('/admin/agents');
});

/* ========================================================================= */
/* [AWAL GANTI: ROUTE LAPORAN AGENT DENGAN FILTER BULAN, TAHUN & REKAP SETORAN] */
/* Fungsi: Menghitung total uang tunai yang dipegang agen, keuntungan agen,   */
/* uang wajib setor ke admin, dan sisa saldo untuk model talangan/konsinyasi. */
/* ========================================================================= */
router.get('/agents/reports', requireAdminSession, requireSidebarMenuAccess('agents_reports'), restrictToAdmin, (req, res) => {
  const agents = agentSvc.getAllAgents();
  const agentId = req.query.agentId ? Number(req.query.agentId) : null;
  
  // Waktu filter (Default ke bulan dan tahun berjalan)
  const now = new Date();
  const filterMonth = req.query.month ? Number(req.query.month) : (now.getMonth() + 1);
  const filterYear = req.query.year ? Number(req.query.year) : now.getFullYear();

  // Format string 'YYYY-MM' untuk query database SQLite
  const padMonth = String(filterMonth).padStart(2, '0');
  const monthPattern = `${filterYear}-${padMonth}%`;

  // Query transaksi agen pada bulan & tahun yang dipilih
  const whereClauses = [];
  const params = [];

  if (agentId) {
    whereClauses.push('t.agent_id = ?');
    params.push(agentId);
  }

  // Filter tanggal berdasarkan format ISO (created_at LIKE 'YYYY-MM%')
  whereClauses.push("t.created_at LIKE ?");
  params.push(monthPattern);

  const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

  const txs = db.prepare(`
    SELECT t.*, a.name AS agent_name, a.username AS agent_username, c.name AS customer_name, r.name AS router_name
    FROM agent_transactions t
    JOIN agents a ON a.id = t.agent_id
    LEFT JOIN customers c ON c.id = t.customer_id
    LEFT JOIN routers r ON r.id = t.router_id
    ${whereSql}
    ORDER BY t.id DESC
  `).all(...params);

  // Perhitungan Keuangan Model Talangan (Model B):
  let totalCashCollected = 0; // Total uang cash warga di tangan agen
  let totalAgentProfit = 0;    // Total keuntungan / upah hak agen
  let totalAdminDeposit = 0;   // UANG YANG WAJIB DISETOR KE ADMIN
  let totalTopupAmount = 0;    // Total saldo yang pernah di-push admin bulan ini

  txs.forEach(t => {
    const sell = Number(t.amount_sell || 0);
    const buy = Number(t.amount_buy || 0);
    const fee = Number(t.fee || 0);

    if (t.type === 'voucher_sale' || t.type === 'pulsa') {
      totalCashCollected += sell;
      totalAdminDeposit += buy;
      totalAgentProfit += (fee > 0 ? fee : Math.max(0, sell - buy));
    } else if (t.type === 'invoice_payment') {
      const invAmt = Number(t.amount_invoice || sell);
      totalCashCollected += invAmt;
      totalAdminDeposit += buy; // Di agentService, buy adalah (invAmt - fee)
      totalAgentProfit += fee;
    } else if (t.type === 'topup') {
      totalTopupAmount += buy;
    }
  });

  // Ambil data agen terpilih (untuk melihat sisa saldo saat ini)
  const selectedAgent = agentId ? agents.find(a => Number(a.id) === agentId) : null;

  res.render('admin/agent_reports', {
    title: 'Laporan Agent',
    company: company(),
    activePage: 'agents_reports',
    agents,
    agentId,
    selectedAgent,
    filterMonth,
    filterYear,
    summary: {
      totalCashCollected,
      totalAgentProfit,
      totalAdminDeposit,
      totalTopupAmount,
      currentBalance: selectedAgent ? Number(selectedAgent.balance || 0) : 0
    },
    txs,
    msg: flashMsg(req)
  });
});
/* ========================================================================= */
/* [AKHIR GANTI: ROUTE LAPORAN AGENT]                                        */
/* ========================================================================= */

/* ========================================================================= */
/* [AWAL ROUTE: BATALKAN/HAPUS VOUCHER DARI LAPORAN & MIKROTIK]              */
/* Fungsi: Endpoint untuk Admin menghapus voucher salah buat, memutus sesi,  */
/* menghapus user di MikroTik, serta me-refund saldo agen secara instan.    */
/* ========================================================================= */
router.post('/agents/reports/voucher/:id/delete', requireAdminSession, restrictToAdmin, async (req, res) => {
  try {
    const txId = Number(req.params.id || 0);
    const actorName = req.session?.adminUser || 'Admin';

    const result = await agentSvc.cancelAndRefundVoucher(txId, actorName);

    req.session._msg = {
      type: 'success',
      text: `Voucher "${result.voucherCode}" berhasil dihapus dari MikroTik. Saldo agen ${result.agentName} telah dikembalikan sebesar Rp ${result.refundAmount.toLocaleString('id-ID')}.`
    };
  } catch (e) {
    req.session._msg = {
      type: 'error',
      text: 'Gagal menghapus voucher: ' + (e?.message || e)
    };
  }

  // Redirect kembali ke halaman laporan dengan parameter filter yang sedang aktif
  const referer = req.get('Referer') || '/admin/agents/reports';
  res.redirect(referer);
});
/* ========================================================================= */
/* [AKHIR ROUTE: BATALKAN/HAPUS VOUCHER]                                     */
/* ========================================================================= */

// Middleware auth khusus JSON API Agen
function requireAdminForAgentApi(req, res, next) {
  if (req.session?.isAdmin) return next();
  const adminKey = getSetting('admin_api_key', '');
  const providedKey = req.headers['x-admin-key'] || req.query.key;
  if (adminKey && providedKey === adminKey) return next();
  return res.status(403).json({ success: false, error: 'Akses ditolak: Hanya Admin yang dapat mengelola harga agent.' });
}

router.get('/api/agents/:id/prices', requireAdminForAgentApi, (req, res) => {
  try {
    const agentId = Number(req.params.id);
    const agent = agentSvc.getAgentById(agentId);
    if (!agent) {
      return res.status(404).json({ success: false, error: 'Agent tidak ditemukan' });
    }
    const rows = agentSvc.getAgentPrices(agentId, { includeInactive: true });
    res.json({
      success: true,
      agent: {
        id: agent.id,
        name: agent.name,
        username: agent.username,
        phone: agent.phone,
        balance: agent.balance,
        billing_fee: agent.billing_fee,
        router_id: agent.router_id,
        router_name: agent.router_name
      },
      prices: rows
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.post('/api/agents/:id/prices', requireAdminForAgentApi, express.json(), (req, res) => {
  try {
    const agentId = Number(req.params.id);
    const result = agentSvc.upsertAgentHotspotPrice(agentId, req.body);
    res.json({ success: true, message: 'Harga paket berhasil disimpan', result });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

router.post('/api/agents/:id/prices/batch', requireAdminForAgentApi, express.json(), (req, res) => {
  try {
    const agentId = Number(req.params.id);
    const agent = agentSvc.getAgentById(agentId);
    if (!agent) {
      return res.status(404).json({ success: false, error: 'Agent tidak ditemukan' });
    }

    const { billing_fee, items } = req.body || {};

    if (billing_fee !== undefined && billing_fee !== null && billing_fee !== '') {
      const feeNum = Math.max(0, Number(billing_fee) || 0);
      agentSvc.updateAgent(agentId, { billing_fee: feeNum });
    }

    let updatedCount = 0;
    if (Array.isArray(items)) {
      for (const item of items) {
        if (!item || !item.profile_name) continue;
        agentSvc.upsertAgentHotspotPrice(agentId, item);
        updatedCount++;
      }
    }

    const updatedAgent = agentSvc.getAgentById(agentId);
    const updatedPrices = agentSvc.getAgentPrices(agentId, { includeInactive: true });

    res.json({
      success: true,
      message: 'Semua pengaturan harga dan fee agen berhasil disimpan',
      updatedCount,
      agent: updatedAgent,
      prices: updatedPrices
    });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

router.post('/api/agents/:id/prices/reset', requireAdminForAgentApi, express.json(), (req, res) => {
  try {
    const agentId = Number(req.params.id);
    const agent = agentSvc.getAgentById(agentId);
    if (!agent) {
      return res.status(404).json({ success: false, error: 'Agent tidak ditemukan' });
    }

    agentSvc.resetAgentHotspotPrices(agentId);
    const updatedPrices = agentSvc.getAgentPrices(agentId, { includeInactive: true });

    res.json({
      success: true,
      message: 'Harga voucher hotspot agen berhasil dikembalikan ke master default',
      prices: updatedPrices
    });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

router.post('/api/agents/:id/prices/:priceId/delete', requireAdminForAgentApi, (req, res) => {
  try {
    const agentId = Number(req.params.id);
    const priceId = Number(req.params.priceId);
    const result = agentSvc.deleteAgentHotspotPrice(agentId, priceId);
    res.json({ success: true, message: 'Kustomisasi harga berhasil dihapus', result });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

// ─── DASHBOARD ─────────────────────────────────────────────────────────────
router.get('/', requireAdminSession, requireSidebarMenuAccess('dashboard'), async (req, res) => {
  try {
    // Jika login sebagai staf dan punya site khusus, kunci site-nya!
    let filterSite = String(req.query.site || '').trim();
    if (req.session?.isStaff && req.session?.staffSite && req.session.staffSite !== 'all') {
      filterSite = req.session.staffSite;
    }
    const billing = billingSvc.getDashboardStats(filterSite);
    
    // Hitung statistik pelanggan per site jika ada filter
    let custStats = customerSvc.getCustomerStats();
    if (filterSite) {
      custStats = {
        total: db.prepare('SELECT COUNT(*) as c FROM customers WHERE site=?').get(filterSite)?.c || 0,
        active: db.prepare("SELECT COUNT(*) as c FROM customers WHERE site=? AND status IN ('active', 'ditangguhkan')").get(filterSite)?.c || 0,
        ditangguhkan: db.prepare("SELECT COUNT(*) as c FROM customers WHERE site=? AND status='ditangguhkan'").get(filterSite)?.c || 0,
        suspended: db.prepare("SELECT COUNT(*) as c FROM customers WHERE site=? AND status='suspended'").get(filterSite)?.c || 0,
        inactive: db.prepare("SELECT COUNT(*) as c FROM customers WHERE site=? AND status='inactive'").get(filterSite)?.c || 0,
      };
    }

    const settings = getSettings();
    res.render('admin/dashboard', {
      title: 'Dashboard', company: company(), version: '2.0.0',
      activePage: 'dashboard', billing, custStats, settings, filterSite
    });
  } catch (e) {
    logger.error('Admin dashboard error:', e);
    res.status(500).send('Error loading dashboard: ' + e.message);
  }
});

// ─── DEVICE ROUTES (existing) ───────────────────────────────────────────────
router.get('/devices', requireAdminSession, (req, res) => {
  const settings = getSettings();
  res.render('admin/dashboard', { title: 'Monitoring ONU', company: company(), version: '2.0.0', activePage: 'devices', billing: null, custStats: null, settings });
});

router.get('/bulk', requireAdminSession, (req, res) => {
  const settings = getSettings();
  res.render('admin/dashboard', { title: 'Konfigurasi Massal', company: company(), version: '2.0.0', activePage: 'bulk', billing: null, custStats: null, settings });
});

// ─── ONU MODEM STICKER PRINT ───────────────────────────────────────────────
router.get('/onu-stickers', requireAdminSession, requireSidebarMenuAccess('onu_stickers'), async (req, res) => {
  try {
    const settings = getSettings();
    const mode = req.query.mode === 'customers' ? 'customers' : 'blank';
    const count = Math.max(1, Math.min(100, Number(req.query.count || 10)));
    const searchQuery = String(req.query.q || '').trim();
    const selectedRouterId = req.selectedRouterId || (req.query.router_id ? Number(req.query.router_id) : null);
    const csPhone = req.query.cs_phone || settings.company_phone || settings.company_whatsapp || '08xxxxxxxxxx';
    const serverBaseUrl = `${req.protocol}://${req.get('host')}`;

    const routers = mikrotikService.getAllRouters();
    let stickers = [];

    if (mode === 'blank') {
      const qrPayload = `${serverBaseUrl}/app/connect`;
      const qrCodeDataUrl = await QRCode.toDataURL(qrPayload, {
        margin: 1,
        width: 250,
        errorCorrectionLevel: 'M'
      });

      for (let i = 0; i < count; i++) {
        stickers.push({
          name: '',
          id_display: '',
          package_name: '',
          qrCodeDataUrl
        });
      }
    } else {
      const customers = customerSvc.getAllCustomers(searchQuery, selectedRouterId, 'active');
      const targetCusts = (customers || []).slice(0, 100);

      for (const c of targetCusts) {
        const qrPayload = `${serverBaseUrl}/app/connect?cid=${encodeURIComponent(c.pppoe_username || c.id)}`;
        const qrCodeDataUrl = await QRCode.toDataURL(qrPayload, {
          margin: 1,
          width: 250,
          errorCorrectionLevel: 'M'
        });

        stickers.push({
          name: c.name,
          id_display: `${c.pppoe_username || ('ID:' + c.id)}`,
          package_name: c.package_name || 'Reguler',
          qrCodeDataUrl
        });
      }
    }

    res.render('admin/onu_stickers', {
      company: company(),
      companyLogo: settings.company_logo || '',
      csPhone,
      mode,
      count,
      searchQuery,
      selectedRouterId,
      routers,
      stickers
    });
  } catch (e) {
    logger.error(`[ONU Stickers] Error: ${e.message}`);
    res.status(500).send(`Gagal memuat stiker: ${e.message}`);
  }
});

router.get('/customers/:id/sticker-onu', requireAdminSession, async (req, res) => {
  try {
    const settings = getSettings();
    const customer = customerSvc.getCustomerById(req.params.id);
    if (!customer) return res.status(404).send('Pelanggan tidak ditemukan');

    const csPhone = settings.company_phone || settings.company_whatsapp || '08xxxxxxxxxx';
    const serverBaseUrl = `${req.protocol}://${req.get('host')}`;

    const qrPayload = `${serverBaseUrl}/app/connect?cid=${encodeURIComponent(customer.pppoe_username || customer.id)}`;
    const qrCodeDataUrl = await QRCode.toDataURL(qrPayload, {
      margin: 1,
      width: 250,
      errorCorrectionLevel: 'M'
    });

    const stickers = [{
      name: customer.name,
      id_display: `${customer.pppoe_username || ('ID:' + customer.id)}`,
      package_name: customer.package_name || 'Reguler',
      qrCodeDataUrl
    }];

    res.render('admin/onu_stickers', {
      company: company(),
      companyLogo: settings.company_logo || '',
      csPhone,
      mode: 'customers',
      count: 1,
      searchQuery: '',
      selectedRouterId: null,
      routers: [],
      stickers
    });
  } catch (e) {
    res.status(500).send(`Gagal memuat stiker: ${e.message}`);
  }
});

// ─── CUSTOMERS ─────────────────────────────────────────────────────────────
router.get('/customers', requireAdminSession, requireSidebarMenuAccess('customers'), async (req, res) => {
  const { search = '', status: filterStatus = '', area: filterArea = '', open_detail_id = '' } = req.query;
  const selectedRouterId = req.selectedRouterId || (req.query.router_id ? Number(req.query.router_id) : null);
  
  // Kunci site otomatis jika yang login adalah akun staf
  let effectiveSite = String(req.query.site || '').trim();
  if (req.session?.isStaff && req.session?.staffSite && req.session.staffSite !== 'all') {
    effectiveSite = req.session.staffSite;
  }
  
  let customers = customerSvc.getAllCustomers(search, selectedRouterId, filterStatus, filterArea, effectiveSite);
  
  // --- [KODE BARU: PASTIKAN BYTES_IN & BYTES_OUT SELALU READY DI SERVER] ---
  customers = customers.map(c => {
    const usage = db.prepare('SELECT bytes_in, bytes_out FROM customers WHERE id = ?').get(c.id);
    return {
      ...c,
      bytes_in: usage ? (usage.bytes_in || 0) : (c.bytes_in || 0),
      bytes_out: usage ? (usage.bytes_out || 0) : (c.bytes_out || 0)
    };
  });
  // ----------------------------------------------------------------------

  if (open_detail_id && !search && !filterStatus && !filterArea) {
    const targetIdNum = Number(open_detail_id);
    const exists = customers.some(c => Number(c.id) === targetIdNum);
    if (!exists) {
      const specificCust = customerSvc.getCustomerById(targetIdNum);
      if (specificCust) customers.unshift(specificCust);
    }
  }

  const stats = customerSvc.getCustomerStats(effectiveSite);
  const packages = customerSvc.getAllPackages(selectedRouterId);
  const routers = mikrotikService.getAllRouters();
  const olts = oltSvc.getAllOlts();
  const odps = odpSvc.getAllOdps();
  const collectors = adminSvc.getAllCollectors();
  const areas = customerSvc.getAllCustomerAreas();
  const masterAreas = areaSvc.getAllAreas();

  let activeSessionsMap = new Map();
  try {
    activeSessionsMap = await mikrotikService.getAllActiveSessionsMap();
  } catch (e) {
    logger.warn('[Customers] Failed to fetch active sessions map:', e.message);
  }

  res.render('admin/customers', {
    title: 'Data Pelanggan', company: company(), activePage: 'customers',
    customers, stats, packages, routers, olts, odps, collectors, areas, masterAreas, activeSessionsMap, search, filterStatus, filterArea, selectedRouterId, msg: flashMsg(req),
    settings: getSettings()
  });
});

router.post('/customers', requireAdminSession, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    // KHUSUS STAF: Jika bukan admin utama dan role-nya staff, cek izin
    if (!req.session?.isAdmin && req.session?.isStaff && !req.session?.canAddCustomer) {
      throw new Error('Akses ditolak: Anda tidak memiliki izin untuk menambah pelanggan.');
    }
    // Jika staf menambah pelanggan, kunci site-nya
    if (!req.session?.isAdmin && req.session?.isStaff && req.session?.staffSite && req.session.staffSite !== 'all') {
      req.body.site = req.session.staffSite;
    }

    const connectionType = String(req.body.connection_type || 'pppoe').trim().toLowerCase() || 'pppoe';
    req.body.connection_type = connectionType;

    if (connectionType !== 'pppoe') req.body.pppoe_username = '';
    if (connectionType !== 'static') req.body.static_ip = '';
    if (connectionType !== 'hotspot') {
      req.body.hotspot_username = '';
      req.body.hotspot_password = '';
      req.body.hotspot_profile = '';
    }

    const multiRouterMode = getSetting('multi_router_mode', 'disabled') === 'active';
    const defaultRouterId = multiRouterMode ? null : getSetting('default_router_id', null);

    if (connectionType === 'pppoe') {
      const routerId = req.body.router_id ? Number(req.body.router_id) : null;
      const username = String(req.body.pppoe_username || '').trim();
      const password = String(req.body.pppoe_password || '').trim();
      const remoteAddress = String(req.body.pppoe_remote_address || '').trim();
      
      req.body.pppoe_username = username;
      req.body.pppoe_password = password;
      req.body.pppoe_remote_address = remoteAddress;
      
      if (!username) throw new Error('PPPoE Username tidak boleh kosong');
      
      // Router validation - required only if multi-router mode is active
      const effectiveRouterId = multiRouterMode ? routerId : (routerId || customerSvc.getEffectiveRouterId(null));
      if (!effectiveRouterId || effectiveRouterId <= 0) {
        if (multiRouterMode) {
          throw new Error('Router MikroTik WAJIB dipilih untuk koneksi PPPoE (fungsi isolir & profile management membutuhkan router)');
        } else {
          throw new Error('Router MikroTik tidak tersedia. Pastikan ada minimal 1 router aktif yang di-setting atau set default router di halaman Pengaturan');
        }
      }
      
      const existing = db.prepare('SELECT id, name FROM customers WHERE router_id IS ? AND pppoe_username = ? LIMIT 1').get(effectiveRouterId, username);
      if (existing) throw new Error(`PPPoE Username sudah dipakai pelanggan lain: ${existing.name}`);

      // Only validate against MikroTik if password is not provided (meaning it's from MikroTik list)
      if (!password) {
        let conn = null;
        try {
          conn = await mikrotikService.getConnection(effectiveRouterId);
          const results = await conn.client.menu('/ppp/secret')
            .where('service', 'pppoe')
            .where('name', username)
            .get();
          if (!Array.isArray(results) || results.length === 0) throw new Error('PPPoE Username tidak ditemukan di MikroTik');
        } finally {
          if (conn && conn.api) conn.api.close();
        }
      }
      
      // Set effective router ID
      req.body.router_id = effectiveRouterId;
    }

    if (connectionType === 'static') {
      const routerId = req.body.router_id ? Number(req.body.router_id) : null;
      const staticIp = String(req.body.static_ip || '').trim();
      req.body.static_ip = staticIp;
      if (!staticIp) throw new Error('Static IP tidak boleh kosong');
      
      // Router validation - required only if multi-router mode is active
      const effectiveRouterId = multiRouterMode ? routerId : (routerId || customerSvc.getEffectiveRouterId(null));
      if (!effectiveRouterId || effectiveRouterId <= 0) {
        if (multiRouterMode) {
          throw new Error('Router MikroTik WAJIB dipilih untuk koneksi Static IP (untuk management & isolir)');
        } else {
          throw new Error('Router MikroTik tidak tersedia. Pastikan ada minimal 1 router aktif yang di-setting atau set default router di halaman Pengaturan');
        }
      }
      
      const existing = db.prepare('SELECT id, name FROM customers WHERE router_id IS ? AND static_ip = ? LIMIT 1').get(effectiveRouterId, staticIp);
      if (existing) throw new Error(`Static IP sudah dipakai pelanggan lain: ${existing.name}`);
      
      // Set effective router ID
      req.body.router_id = effectiveRouterId;
    }

    if (connectionType === 'hotspot') {
      const routerId = req.body.router_id ? Number(req.body.router_id) : null;
      const username = String(req.body.hotspot_username || '').trim();
      req.body.hotspot_username = username;
      if (!username) throw new Error('Hotspot Username tidak boleh kosong');
      
      // Router validation - required only if multi-router mode is active
      const effectiveRouterId = multiRouterMode ? routerId : (routerId || customerSvc.getEffectiveRouterId(null));
      if (!effectiveRouterId || effectiveRouterId <= 0) {
        if (multiRouterMode) {
          throw new Error('Router MikroTik WAJIB dipilih untuk koneksi Hotspot (untuk user management & isolir)');
        } else {
          throw new Error('Router MikroTik tidak tersedia. Pastikan ada minimal 1 router aktif yang di-setting atau set default router di halaman Pengaturan');
        }
      }
      
      const existing = db.prepare('SELECT id, name FROM customers WHERE router_id IS ? AND hotspot_username = ? LIMIT 1').get(effectiveRouterId, username);
      if (existing) throw new Error(`Hotspot Username sudah dipakai pelanggan lain: ${existing.name}`);

      const password = String(req.body.hotspot_password || '').trim() || username;
      req.body.hotspot_password = password;

      let profile = String(req.body.hotspot_profile || '').trim();
      if (!profile && req.body.package_id) {
        const pkg = customerSvc.getPackageById(req.body.package_id);
        if (pkg) profile = String(pkg.name || '').trim();
      }
      req.body.hotspot_profile = profile;
      if (!profile) throw new Error('Hotspot User Profile tidak boleh kosong');

      const profs = await mikrotikService.getHotspotUserProfiles(effectiveRouterId);
      const ok = Array.isArray(profs) && profs.some(p => String(p?.name || '').trim() === profile);
      if (!ok) throw new Error(`Hotspot User Profile "${profile}" tidak ditemukan di MikroTik`);
      
      // Set effective router ID
      req.body.router_id = effectiveRouterId;
    }

    const radiusEnabled = getSetting('radius_enabled', '0') === '1';
    // Ketika RADIUS offline, paksa is_radius = 0 (MikroTik mode) agar secret SELALU dibuat ke MikroTik
    const isRadius = radiusEnabled ? (req.body.is_radius !== undefined ? (Number(req.body.is_radius) === 1 ? 1 : 0) : 0) : 0;
    req.body.is_radius = isRadius;

    // Pastikan site terisi, default 'site-1' jika kosong
    req.body.site = req.body.site ? String(req.body.site).trim() : 'site-1';

    customerSvc.createCustomer(req.body);
    
    // ========================================================================
    // SYNC KE MIKROTIK - PENTING: SECRET TIDAK PERNAH DIHAPUS!
    // ========================================================================
    // Logika:
    // - Jika RADIUS OFFLINE: SELALU create/update secret ke MikroTik
    // - Jika RADIUS AKTIF tapi is_radius=0: Hybrid mode, tetap ke MikroTik
    // - Jika RADIUS AKTIF dan is_radius=1: Full RADIUS mode, skip MikroTik
    // 
    // CATATAN: Kode ini TIDAK PERNAH menghapus secret dari MikroTik!
    //          Hanya CREATE (jika belum ada) atau UPDATE PROFILE (jika sudah ada)
    // ========================================================================
    const shouldSyncToMikrotik = !radiusEnabled || !isRadius;
    if (connectionType === 'pppoe' && req.body.pppoe_username && shouldSyncToMikrotik) {
      const password = String(req.body.pppoe_password || '').trim();
      const remoteAddress = String(req.body.pppoe_remote_address || '').trim();
      
      // If manual input (password provided), create PPPoE secret in MikroTik
      if (password) {
        let targetProfile = '';
        if (req.body.status === 'suspended') {
          targetProfile = req.body.isolir_profile || 'isolir';
        } else if (req.body.package_id) {
          const pkg = customerSvc.getPackageById(req.body.package_id);
          if (pkg) targetProfile = pkg.name;
        }
        
        if (targetProfile) {
          try {
            await mikrotikService.createPppoeSecret({
              username: req.body.pppoe_username,
              password: password,
              profile: targetProfile,
              remoteAddress: remoteAddress,
              routerId: req.body.router_id
            });
            logger.info(`[Add Customer] Created PPPoE secret "${req.body.pppoe_username}" in MikroTik (RADIUS ${radiusEnabled ? 'ON' : 'OFF'})`);
          } catch (mErr) {
            logger.error('Mikrotik create PPPoE secret error:', mErr);
          }
        }
      } else {
        // If from MikroTik list (no password input), just update profile
        let targetProfile = '';
        if (req.body.status === 'suspended') {
          targetProfile = req.body.isolir_profile || 'isolir';
        } else if (req.body.package_id) {
          const pkg = customerSvc.getPackageById(req.body.package_id);
          if (pkg) targetProfile = pkg.name;
        }
        if (targetProfile) {
          try {
            await mikrotikService.setPppoeProfile(req.body.pppoe_username, targetProfile, req.body.router_id);
            logger.info(`[Add Customer] Updated PPPoE profile for "${req.body.pppoe_username}" to "${targetProfile}"`);
          } catch (mErr) {
            logger.error('Mikrotik sync error (create):', mErr);
          }
        }
      }
    }
    if (connectionType === 'hotspot' && req.body.hotspot_username) {
      const disabled = String(req.body.status || 'active').toLowerCase() !== 'active';
      try {
        await mikrotikService.upsertHotspotUser({
          username: String(req.body.hotspot_username || '').trim(),
          password: String(req.body.hotspot_password || '').trim(),
          profile: String(req.body.hotspot_profile || '').trim(),
          macAddress: String(req.body.mac_address || '').trim(),
          disabled
        }, req.body.router_id ? Number(req.body.router_id) : null);
      } catch (mErr) {
        console.error('Mikrotik sync error (create hotspot):', mErr);
      }
    }

    req.session._msg = { type: 'success', text: `Pelanggan "${req.body.name}" berhasil ditambahkan.` };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal menambahkan pelanggan: ' + e.message };
  }
  res.redirect('/admin/customers');
});

router.post('/customers/:id/update', requireAdminSession, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    // KHUSUS STAF: Jika bukan admin utama dan role-nya staff, cek izin
    if (!req.session?.isAdmin && req.session?.isStaff && !req.session?.canEditCustomer) {
      throw new Error('Akses ditolak: Anda tidak memiliki izin untuk mengubah data pelanggan.');
    }
    // Jika staf edit, jangan biarkan dia ganti site pelanggan
    if (!req.session?.isAdmin && req.session?.isStaff && req.session?.staffSite && req.session.staffSite !== 'all') {
      req.body.site = req.session.staffSite;
    }
	
    const customerId = Number(req.params.id);
    const connectionType = String(req.body.connection_type || 'pppoe').trim().toLowerCase() || 'pppoe';
    req.body.connection_type = connectionType;

    if (connectionType !== 'pppoe') req.body.pppoe_username = '';
    if (connectionType !== 'static') req.body.static_ip = '';
    if (connectionType !== 'hotspot') {
      req.body.hotspot_username = '';
      req.body.hotspot_password = '';
      req.body.hotspot_profile = '';
    }

    const multiRouterMode = getSetting('multi_router_mode', 'disabled') === 'active';
    const defaultRouterId = multiRouterMode ? null : getSetting('default_router_id', null);

    if (connectionType === 'pppoe') {
      const routerId = req.body.router_id ? Number(req.body.router_id) : null;
      const username = String(req.body.pppoe_username || '').trim();
      req.body.pppoe_username = username;
      if (!username) throw new Error('PPPoE Username tidak boleh kosong');
      
      // Router validation - required only if multi-router mode is active
      const effectiveRouterId = multiRouterMode ? routerId : (routerId || customerSvc.getEffectiveRouterId(null));
      if (!effectiveRouterId || effectiveRouterId <= 0) {
        if (multiRouterMode) {
          throw new Error('Router MikroTik WAJIB dipilih untuk koneksi PPPoE (fungsi isolir & profile management membutuhkan router)');
        } else {
          throw new Error('Router MikroTik tidak tersedia. Pastikan ada minimal 1 router aktif yang di-setting atau set default router di halaman Pengaturan');
        }
      }
      
      const existing = db.prepare('SELECT id, name FROM customers WHERE router_id IS ? AND pppoe_username = ? AND id != ? LIMIT 1').get(effectiveRouterId, username, customerId);
      if (existing) throw new Error(`PPPoE Username sudah dipakai pelanggan lain: ${existing.name}`);

      let conn = null;
      try {
        conn = await mikrotikService.getConnection(effectiveRouterId);
        const results = await conn.client.menu('/ppp/secret')
          .where('service', 'pppoe')
          .where('name', username)
          .get();
        if (!Array.isArray(results) || results.length === 0) throw new Error('PPPoE Username tidak ditemukan di MikroTik');
      } finally {
        if (conn && conn.api) conn.api.close();
      }
      
      // Set effective router ID
      req.body.router_id = effectiveRouterId;
    }

    if (connectionType === 'static') {
      const routerId = req.body.router_id ? Number(req.body.router_id) : null;
      const staticIp = String(req.body.static_ip || '').trim();
      req.body.static_ip = staticIp;
      if (!staticIp) throw new Error('Static IP tidak boleh kosong');
      
      // Router validation - required only if multi-router mode is active
      const effectiveRouterId = multiRouterMode ? routerId : (routerId || customerSvc.getEffectiveRouterId(null));
      if (!effectiveRouterId || effectiveRouterId <= 0) {
        if (multiRouterMode) {
          throw new Error('Router MikroTik WAJIB dipilih untuk koneksi Static IP (untuk management & isolir)');
        } else {
          throw new Error('Router MikroTik tidak tersedia. Pastikan ada minimal 1 router aktif yang di-setting atau set default router di halaman Pengaturan');
        }
      }
      
      const existing = db.prepare('SELECT id, name FROM customers WHERE router_id IS ? AND static_ip = ? AND id != ? LIMIT 1').get(effectiveRouterId, staticIp, customerId);
      if (existing) throw new Error(`Static IP sudah dipakai pelanggan lain: ${existing.name}`);
      
      // Set effective router ID
      req.body.router_id = effectiveRouterId;
    }

    if (connectionType === 'hotspot') {
      const routerId = req.body.router_id ? Number(req.body.router_id) : null;
      const username = String(req.body.hotspot_username || '').trim();
      req.body.hotspot_username = username;
      if (!username) throw new Error('Hotspot Username tidak boleh kosong');
      
      // Router validation - required only if multi-router mode is active
      const effectiveRouterId = multiRouterMode ? routerId : (routerId || customerSvc.getEffectiveRouterId(null));
      if (!effectiveRouterId || effectiveRouterId <= 0) {
        if (multiRouterMode) {
          throw new Error('Router MikroTik WAJIB dipilih untuk koneksi Hotspot (untuk user management & isolir)');
        } else {
          throw new Error('Router MikroTik tidak tersedia. Pastikan ada minimal 1 router aktif yang di-setting atau set default router di halaman Pengaturan');
        }
      }
      
      const existing = db.prepare('SELECT id, name FROM customers WHERE router_id IS ? AND hotspot_username = ? AND id != ? LIMIT 1').get(effectiveRouterId, username, customerId);
      if (existing) throw new Error(`Hotspot Username sudah dipakai pelanggan lain: ${existing.name}`);

      const password = String(req.body.hotspot_password || '').trim() || username;
      req.body.hotspot_password = password;

      let profile = String(req.body.hotspot_profile || '').trim();
      if (!profile && req.body.package_id) {
        const pkg = customerSvc.getPackageById(req.body.package_id);
        if (pkg) profile = String(pkg.name || '').trim();
      }
      req.body.hotspot_profile = profile;
      if (!profile) throw new Error('Hotspot User Profile tidak boleh kosong');

      const profs = await mikrotikService.getHotspotUserProfiles(effectiveRouterId);
      const ok = Array.isArray(profs) && profs.some(p => String(p?.name || '').trim() === profile);
      if (!ok) throw new Error(`Hotspot User Profile "${profile}" tidak ditemukan di MikroTik`);
      
      // Set effective router ID
      req.body.router_id = effectiveRouterId;
    }

    const radiusEnabled = getSetting('radius_enabled', '0') === '1';
    // Ketika RADIUS offline, paksa is_radius = 0 (MikroTik mode) agar secret SELALU ada di MikroTik
    const isRadius = radiusEnabled ? (req.body.is_radius !== undefined ? (Number(req.body.is_radius) === 1 ? 1 : 0) : 0) : 0;
    req.body.is_radius = isRadius;

    // Pastikan site terisi, default 'site-1' jika kosong
    req.body.site = req.body.site ? String(req.body.site).trim() : 'site-1';

    // Get old customer data to detect username changes
    const oldCustomer = customerSvc.getCustomerById(customerId);
    
    customerSvc.updateCustomer(req.params.id, req.body);
    
    // ========================================================================
    // SYNC KE MIKROTIK SAAT EDIT - PENTING: SECRET TIDAK PERNAH DIHAPUS!
    // ========================================================================
    // Logika:
    // - Jika RADIUS OFFLINE: SELALU sync ke MikroTik
    // - Jika RADIUS AKTIF tapi is_radius=0: Hybrid mode, tetap sync ke MikroTik  
    // - Jika RADIUS AKTIF dan is_radius=1: Full RADIUS mode, skip MikroTik
    //
    // Proses:
    // 1. Cek apakah secret sudah ada di MikroTik
    // 2. Jika sudah ada: UPDATE PROFILE saja (TIDAK HAPUS!)
    // 3. Jika belum ada: CREATE secret baru (jika ada password)
    // 
    // CATATAN: Kode ini TIDAK PERNAH menghapus secret dari MikroTik!
    // ========================================================================
    const shouldSyncToMikrotik = !radiusEnabled || !isRadius;
    if (connectionType === 'pppoe' && req.body.pppoe_username && shouldSyncToMikrotik) {
      try {
        const newUsername = String(req.body.pppoe_username || '').trim();
        const newPassword = String(req.body.pppoe_password || '').trim();
        const remoteAddress = String(req.body.pppoe_remote_address || '').trim();
        
        let targetProfile = '';
        if (req.body.status === 'suspended') {
          targetProfile = req.body.isolir_profile || 'isolir';
        } else if (req.body.package_id) {
          const pkg = customerSvc.getPackageById(req.body.package_id);
          if (pkg) targetProfile = pkg.name;
        }
        
        if (targetProfile) {
          try {
            // Cek apakah secret sudah ada di MikroTik
            const secrets = await mikrotikService.getPppoeSecrets(req.body.router_id);
            const existingSecret = secrets.find(s => String(s.name || '').trim() === newUsername);
            
            if (existingSecret) {
              // Secret sudah ada, hanya update profile
              await mikrotikService.setPppoeProfile(newUsername, targetProfile, req.body.router_id);
              logger.info(`[Edit Customer] Updated PPPoE profile for "${newUsername}" to "${targetProfile}"`);
            } else if (newPassword) {
              // Secret belum ada DAN ada password, create secret baru ke MikroTik
              await mikrotikService.createPppoeSecret({
                username: newUsername,
                password: newPassword,
                profile: targetProfile,
                remoteAddress: remoteAddress,
                routerId: req.body.router_id
              });
              logger.info(`[Edit Customer] Created NEW PPPoE secret for "${newUsername}" in MikroTik`);
            } else {
              logger.warn(`[Edit Customer] Cannot create PPPoE secret for "${newUsername}" - password not provided`);
            }
          } catch (mErr) {
            logger.error('Mikrotik sync error (update PPPoE):', mErr.message);
          }
        }
      } catch (syncErr) {
        logger.warn(`[Update] MikroTik API sync skipped/failed for customer ${customerId}: ${syncErr.message}`);
      }
    }
    if (connectionType === 'hotspot' && req.body.hotspot_username) {
      try {
        const oldUsername = oldCustomer ? String(oldCustomer.hotspot_username || '').trim() : '';
        const newUsername = String(req.body.hotspot_username || '').trim();
        const oldRouterIdForOldUser = oldCustomer ? oldCustomer.router_id : null;
        const oldEffectiveRouterId = oldCustomer ? customerSvc.getEffectiveRouterId(oldRouterIdForOldUser) : null;
        
        // If username changed, handle old one first
        if (oldUsername && oldUsername !== newUsername && oldEffectiveRouterId) {
          try {
            logger.info(`[Update] Hotspot username changed: "${oldUsername}" → "${newUsername}" for customer ${customerId}`);
            const oldUser = await mikrotikService.getHotspotUserByName(oldUsername, oldEffectiveRouterId);
            if (oldUser && (oldUser.id || oldUser['.id'])) {
              const userId = oldUser['.id'] || oldUser.id;
              await mikrotikService.deleteHotspotUser(userId, oldEffectiveRouterId);
              logger.info(`[Update] Deleted old Hotspot user: ${oldUsername} from router ${oldEffectiveRouterId}`);
            }
          } catch (err) {
            logger.warn(`[Update] Failed to delete old Hotspot user ${oldUsername}: ${err.message}`);
          }
        }
        
        // Now handle new username
        const disabled = String(req.body.status || 'active').toLowerCase() !== 'active';
        await mikrotikService.upsertHotspotUser({
          username: newUsername,
          password: String(req.body.hotspot_password || '').trim(),
          profile: String(req.body.hotspot_profile || '').trim(),
          macAddress: String(req.body.mac_address || '').trim(),
          disabled
        }, req.body.router_id ? Number(req.body.router_id) : null);
      } catch (mErr) {
        logger.warn(`[Update] Mikrotik sync error (update hotspot): ${mErr.message}`);
      }
    }

    req.session._msg = { type: 'success', text: 'Data pelanggan berhasil diperbarui.' };
    return res.redirect('/admin/customers?highlight=' + customerId);
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal memperbarui: ' + e.message };
    return res.redirect('/admin/customers');
  }
});

router.post('/customers/delete-bulk', requireAdminSession, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const { customer_ids } = req.body;
    const ids = Array.isArray(customer_ids) ? customer_ids : [customer_ids];
    const clean = ids
      .map(x => Number(x))
      .filter(n => Number.isFinite(n) && n > 0);
    if (!clean || clean.length === 0) throw new Error('Tidak ada pelanggan yang dipilih.');

    const deleted = await customerSvc.bulkDeleteCustomers(clean);
    req.session._msg = { type: 'success', text: `${deleted} data pelanggan berhasil dihapus (Akun PPPoE di MikroTik tetap aman).` };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal hapus massal: ' + e.message };
  }
  res.redirect('/admin/customers');
});

router.post('/customers/:id/delete', requireAdminSession, async (req, res) => {
  try {
    // KHUSUS STAF: Jika bukan admin utama dan role-nya staff, cek izin
    if (!req.session?.isAdmin && req.session?.isStaff && !req.session?.canDeleteCustomer) {
      throw new Error('Akses ditolak: Anda tidak memiliki izin untuk menghapus data pelanggan.');
    }
	
    await customerSvc.deleteCustomer(req.params.id);
    req.session._msg = { type: 'success', text: 'Pelanggan berhasil dihapus.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/customers');
});

router.post('/customers/:id/topup', requireAdminSession, async (req, res) => {
  try {
    const custId = Number(req.params.id);
    const amount = Number(req.body.amount);
    const actionType = req.body.action_type === 'deduct' ? 'deduct' : 'add';
    const note = req.body.note ? String(req.body.note).trim() : '';
    const sendWhatsApp = req.body.send_wa === 'on' || req.body.send_wa === 'true' || req.body.send_wa === true;
    const actorName = req.session?.isCashier ? resolvePaidByName(req, 'Kasir') : (req.session.adminUser || 'Admin');

    if (!custId || isNaN(amount) || amount <= 0) {
      throw new Error('Nominal saldo harus lebih dari 0.');
    }

    const result = await customerSvc.topupCustomerBalance(custId, amount, note, actorName, actionType, sendWhatsApp);
    const actionText = actionType === 'deduct' ? 'dipotong' : 'ditambahkan';
    req.session._msg = {
      type: 'success',
      text: `Saldo pelanggan ${result.customer?.name || ''} berhasil ${actionText} Rp ${amount.toLocaleString('id-ID')}. Sisa saldo: Rp ${result.after.toLocaleString('id-ID')}`
    };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal kelola saldo: ' + e.message };
  }
  res.redirect('/admin/customers');
});


router.post('/customers/:id/disconnect', requireAdminSession, async (req, res) => {
  try {
    const custId = Number(req.params.id);
    const customer = customerSvc.getCustomerById(custId);
    if (!customer) throw new Error('Pelanggan tidak ditemukan');

    const pppoeUser = String(customer.pppoe_username || '').trim();
    const hotspotUser = String(customer.hotspot_username || '').trim();
    const username = pppoeUser || hotspotUser || String(customer.name || '').trim();

    let kicked = false;
    if (pppoeUser) {
      kicked = await mikrotikService.kickPppoeUser(pppoeUser, customer.router_id);
    } else if (hotspotUser) {
      kicked = await mikrotikService.kickHotspotUser(hotspotUser, customer.router_id);
    } else if (username) {
      kicked = await mikrotikService.kickPppoeUser(username, customer.router_id) || await mikrotikService.kickHotspotUser(username, customer.router_id);
    }

    if (kicked) {
      req.session._msg = { type: 'success', text: `Sesi koneksi aktif untuk "${customer.name}" berhasil diputus dari MikroTik.` };
    } else {
      req.session._msg = { type: 'error', text: `Sesi aktif untuk "${customer.name}" tidak ditemukan di MikroTik atau gagal diputus.` };
    }
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal memutus koneksi: ' + (e.message || String(e)) };
  }
  res.redirect('/admin/customers');
});

// ─── EXPORT/IMPORT CUSTOMERS ──────────────────────────────────────
router.get('/customers/export', requireAdminSession, (req, res) => {
  try {
    let exportSite = '';
    if (req.session?.isStaff && req.session?.staffSite && req.session.staffSite !== 'all') {
      exportSite = req.session.staffSite;
    }
    const customers = customerSvc.getAllCustomers('', null, '', '', exportSite);
    const data = customers.map(c => ({
      'ID': c.id,
      'NIK': c.nik || '',
      'Nama': c.name,
      'Telepon': c.phone,
      'Email': c.email || '',
      'Alamat': c.address,
      'Area': c.area || '',
      'Paket': c.package_name || '-',
      'Router': c.router_name || '-',
      'Tipe Koneksi': c.connection_type || 'pppoe',
      'Tag ONU': c.genieacs_tag,
      'PPPoE Username': c.pppoe_username,
      'Hotspot Username': c.hotspot_username || '',
      'Static IP': c.static_ip || '',
      'Isolir Profile': c.isolir_profile,
      'Status': c.status,
      'Tanggal Pasang': c.install_date,
      'Auto Isolir': c.auto_isolate === 1 ? 'YA' : 'TIDAK',
      'Tgl Isolir': c.isolate_day,
      'ODP': c.odp_name || '-',
      'Latitude': c.lat || '',
      'Longitude': c.lng || '',
      'Catatan': c.notes
    }));

    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Pelanggan');
    
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', 'attachment; filename=daftar_pelanggan.xlsx');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (e) {
    logger.error('Export error:', e);
    res.status(500).send('Gagal export data.');
  }
});

router.post('/customers/import', requireAdminSession, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) throw new Error('File tidak ditemukan');
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws);
    logger.info(`[Import] Found ${rows.length} rows in Excel file.`);
    
    const packages = customerSvc.getAllPackages();
    const odps = odpSvc.getAllOdps();
    const routers = mikrotikService.getAllRouters();
    let count = 0;

    for (let row of rows) {
      // Normalize row keys (trim whitespace)
      const cleanRow = {};
      Object.keys(row).forEach(key => {
        cleanRow[key.trim()] = row[key];
      });

      const name = cleanRow['Nama'] || cleanRow['name'] || cleanRow['Name'];
      if (!name) {
        logger.debug('[Import] Skipping row - Name is empty.');
        continue; 
      }

      const pkgName = cleanRow['Paket'] || cleanRow['package'] || cleanRow['Package'];
      const pkg = packages.find(p => p.name === pkgName);

      const odpName = cleanRow['ODP'] || cleanRow['odp'] || cleanRow['ODP Name'];
      const odp = odps.find(o => o.name === odpName);
      
      // ✅ Handle Router field
      const routerName = cleanRow['Router'] || cleanRow['router'] || cleanRow['Router Name'];
      const router = routers.find(r => r.name === routerName);
      
      // ✅ NEW: Handle Connection Type
      const connType = String(cleanRow['Tipe Koneksi'] || cleanRow['connection_type'] || cleanRow['Connection Type'] || 'pppoe').trim().toLowerCase() || 'pppoe';
      
      const data = {
        nik: cleanRow['NIK'] || cleanRow['nik'] || cleanRow['No KTP'] || cleanRow['No. KTP'] || '',
        name: name,
        phone: cleanRow['Telepon'] || cleanRow['phone'] || cleanRow['Phone'],
        email: cleanRow['Email'] || cleanRow['email'] || cleanRow['email_address'],
        address: cleanRow['Alamat'] || cleanRow['address'] || cleanRow['Address'],
        area: cleanRow['Area'] || cleanRow['area'] || cleanRow['Wilayah'] || '',
        package_id: pkg ? pkg.id : null,
        router_id: router ? router.id : null,
        odp_id: odp ? odp.id : null,
        lat: cleanRow['Latitude'] || cleanRow['latitude'] || cleanRow['Lat'] || '',
        lng: cleanRow['Longitude'] || cleanRow['longitude'] || cleanRow['Lng'] || '',
        genieacs_tag: cleanRow['Tag ONU'] || cleanRow['genieacs_tag'],
        pppoe_username: connType === 'pppoe' ? (cleanRow['PPPoE Username'] || cleanRow['pppoe_username'] || '') : '',
        hotspot_username: connType === 'hotspot' ? (cleanRow['Hotspot Username'] || cleanRow['hotspot_username'] || '') : '',
        static_ip: connType === 'static' ? (cleanRow['Static IP'] || cleanRow['static_ip'] || '') : '',
        connection_type: connType,
        isolir_profile: cleanRow['Isolir Profile'] || cleanRow['isolir_profile'] || 'isolir',
        status: (cleanRow['Status'] || cleanRow['status'] || 'active').toLowerCase(),
        install_date: cleanRow['Tanggal Pasang'] || cleanRow['install_date'],
        auto_isolate: (cleanRow['Auto Isolir'] === 'TIDAK' || cleanRow['auto_isolate'] === 0) ? 0 : 1,
        isolate_day: parseInt(cleanRow['Tgl Isolir'] || cleanRow['isolate_day']) || 10,
        notes: cleanRow['Catatan'] || cleanRow['notes']
      };
      
      const id = cleanRow['ID'] || cleanRow['id'];
      if (id && !isNaN(id) && id !== '') {
        logger.info(`[Import] Updating customer ID: ${id}`);
        customerSvc.updateCustomer(id, data);
      } else {
        logger.info(`[Import] Creating new customer: ${name}`);
        customerSvc.createCustomer(data);
      }
      count++;
    }
    
    logger.info(`[Import] Finished. Total processed: ${count}`);
    req.session._msg = { type: 'success', text: `Berhasil mengimpor ${count} data pelanggan.` };
  } catch (e) {
    logger.error('Import error:', e);
    req.session._msg = { type: 'error', text: 'Gagal impor: ' + e.message };
  }
  res.redirect('/admin/customers');
});

router.post('/customers/:id/isolate', requireAdminSession, async (req, res) => {
  try {
    await customerSvc.suspendCustomer(req.params.id);
    const customer = customerSvc.getCustomerById(req.params.id);
    req.session._msg = { type: 'success', text: `Pelanggan "${customer.name}" berhasil di-isolir manual.` };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal isolir: ' + e.message };
  }
  res.redirect('back');
});

// ==================== AWAL PERBAIKAN BUKA ISOLIR MANUAL (DISPENSASI AMAN) ====================
router.post('/customers/:id/unisolate', requireAdminSession, async (req, res) => {
  try {
    const customer = customerSvc.getCustomerById(req.params.id);
    if (!customer) throw new Error('Pelanggan tidak ditemukan');
    
    const unpaid = db.prepare("SELECT COUNT(*) as cnt FROM invoices WHERE customer_id=? AND status='unpaid'").get(req.params.id)?.cnt || 0;
    
    if (unpaid > 0) {
      // Pelanggan belum lunas tapi dibuka manual:
      // KUNCI status ke 'ditangguhkan' dan MATIKAN auto_isolate agar tidak terblokir cron jam 23:59!
      await customerSvc.activateCustomer(req.params.id, 'ditangguhkan');
      db.prepare("UPDATE customers SET auto_isolate = 0 WHERE id = ?").run(req.params.id);
      
      req.session._msg = { 
        type: 'success', 
        text: `Layanan "${customer.name}" dibuka manual (DISPENSASI). Auto-isolir dimatikan sementara agar pelanggan bebas internetan sampai bayar di bulan berikutnya.` 
      };
    } else {
      // Pelanggan memang sudah lunas
      await customerSvc.activateCustomer(req.params.id, 'active');
      db.prepare("UPDATE customers SET auto_isolate = 1 WHERE id = ?").run(req.params.id);
      
      req.session._msg = { 
        type: 'success', 
        text: `Layanan "${customer.name}" berhasil diaktifkan kembali (NORMAL / LUNAS).` 
      };
    }
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal aktivasi: ' + e.message };
  }
  res.redirect('back');
});
// ==================== AKHIR PERBAIKAN BUKA ISOLIR MANUAL ====================

router.post('/customers/:id/billing/generate', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    const { month, year } = req.body;
    const result = billingSvc.generateInvoiceForCustomer(req.params.id, parseInt(month), parseInt(year));
    if (result.created) {
      req.session._msg = { type: 'success', text: `Tagihan berhasil dibuat untuk "${result.customerName}" periode ${month}/${year}.` };
    } else {
      req.session._msg = { type: 'success', text: `Tagihan sudah ada untuk "${result.customerName}" periode ${month}/${year}.` };
    }
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal generate tagihan: ' + e.message };
  }
  res.redirect('back');
});

router.post('/customers/:id/billing/reset-promo-cycles', requireAdminSession, restrictToAdmin, (req, res) => {
  try {
    const r = customerSvc.resetPromoCyclesUsed(req.params.id);
    if (!r.changes) {
      req.session._msg = { type: 'error', text: 'Pelanggan tidak ditemukan.' };
    } else {
      const c = customerSvc.getCustomerById(req.params.id);
      req.session._msg = { type: 'success', text: `Counter promo untuk "${c ? c.name : req.params.id}" di-reset (siklus promo dihitung ulang dari awal).` };
    }
  } catch (e) {
    req.session._msg = { type: 'error', text: e.message || String(e) };
  }
  res.redirect('back');
});

router.post('/customers/:id/billing/install-prorata', requireAdminSession, restrictToAdmin, (req, res) => {
  try {
    const out = billingSvc.createInstallProrataCatchUpInvoice(req.params.id);
    req.session._msg = {
      type: 'success',
      text: `Tagihan susulan prorata untuk "${out.customerName}" periode ${String(out.periodMonth).padStart(2, '0')}/${out.periodYear} sebesar Rp ${Number(out.amount).toLocaleString('id-ID')} (${out.billableDays}/${out.daysInMonth} hari).`
    };
  } catch (e) {
    req.session._msg = { type: 'error', text: e.message || String(e) };
  }
  res.redirect('back');
});

// ==================== AWAL ROUTE BAYAR DARI MENU PELANGGAN ====================
router.post('/customers/:id/billing/pay', requireAdminSession, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const custId = Number(req.params.id);
    const { month, months, year, paid_by_name, notes } = req.body;
    const y = parseInt(year);
    const paidBy = resolvePaidByName(req, paid_by_name);
    const customer = customerSvc.getCustomerById(custId);

    if (!customer) throw new Error('Data pelanggan tidak ditemukan');

    // Pastikan mengambil nama paket yang benar
    let actualPackageName = '';
    if (customer.package_id) {
      const pkgRow = db.prepare('SELECT name FROM packages WHERE id = ?').get(customer.package_id);
      if (pkgRow && pkgRow.name) actualPackageName = pkgRow.name;
    }
    if (!actualPackageName && customer.package_name && customer.package_name.toLowerCase() !== 'admin') {
      actualPackageName = customer.package_name;
    }
    if (!actualPackageName) {
      actualPackageName = 'Reguler';
    }

    // Ambil opsi checkbox dari form
    const shouldSendWA = req.body.send_wa === '1' || req.body.send_wa === 'on' || req.body.send_wa === true;
    const shouldSendTG = req.body.send_tg === '1' || req.body.send_tg === 'on' || req.body.send_tg === true;
    const shouldSendPDF = req.body.send_pdf === '1' || req.body.send_pdf === 'on' || req.body.send_pdf === true;

    let targetInvoiceIds = [];

    if (months != null) {
      const sum = billingSvc.payInvoicesForCustomerMonths(custId, y, months, paidBy, notes);
      const done = sum.paidMonths.length;
      const already = sum.alreadyPaidMonths.length;
      const created = sum.createdMonths.length;
      const total = Number(sum.totalAmount) || 0;
      req.session._msg = { type: 'success', text: `Pembayaran berhasil untuk "${sum.customerName}" tahun ${sum.year}. Total: Rp ${total.toLocaleString('id-ID')} (${sum.totalMonths || 0} bulan).` };

      const selectedMonthNums = (Array.isArray(months) ? months : [months]).map(m => parseInt(m, 10));
      const placeholders = selectedMonthNums.map(() => '?').join(',');
      const rows = db.prepare(`SELECT id FROM invoices WHERE customer_id = ? AND period_year = ? AND period_month IN (${placeholders}) AND status = 'paid'`).all(custId, y, ...selectedMonthNums);
      targetInvoiceIds = rows.map(r => r.id);

      if (customer && done > 0) {
        const monthsText = (sum.paidMonths || []).join(', ');
        const invIdStr = targetInvoiceIds.map(id => String(id).padStart(4, '0')).join(', ');

        // Kirim WA & Telegram via helper terpusat
        await sendPaymentSuccessWA(
          customer.phone,
          customer.name,
          `${monthsText} / ${sum.year}`,
          Number(total || 0).toLocaleString('id-ID'),
          paidBy,
          {
            customerId: customer.id,
            invoiceId: invIdStr,
            username: customer.pppoe_username || customer.id,
            packageName: actualPackageName,
            paidAt: new Date(),
            bypassEnabledCheck: shouldSendWA,
            sendTelegram: shouldSendTG
          }
        );
      }
    } else {
      const m = parseInt(month, 10);
      const result = billingSvc.payInvoiceForCustomerPeriod(custId, m, y, paidBy, notes);
      const verb = result.created ? 'dibuat & dilunasi' : 'dilunasi';
      req.session._msg = { type: 'success', text: `Tagihan periode ${m}/${y} untuk "${result.customerName}" berhasil ${verb}.` };

      const singleRow = db.prepare(`SELECT id, amount FROM invoices WHERE customer_id = ? AND period_year = ? AND period_month = ? AND status = 'paid' ORDER BY id DESC LIMIT 1`).get(custId, y, m);
      if (singleRow) targetInvoiceIds = [singleRow.id];

      if (customer) {
        const invs = billingSvc.getInvoicesByAny(String(custId)) || [];
        const inv = (Array.isArray(invs) ? invs : []).find(i => Number(i?.period_month) === Number(m) && Number(i?.period_year) === Number(y)) || null;
        const amount = inv ? Number(inv.amount || 0) : (singleRow ? Number(singleRow.amount || 0) : 0);
        const invIdStr = inv ? String(inv.id).padStart(4, '0') : (singleRow ? String(singleRow.id).padStart(4, '0') : '');

        // Kirim WA & Telegram via helper terpusat
        await sendPaymentSuccessWA(
          customer.phone,
          customer.name,
          `${m}/${y}`,
          amount.toLocaleString('id-ID'),
          paidBy,
          {
            customerId: customer.id,
            invoiceId: invIdStr,
            username: customer.pppoe_username || customer.id,
            packageName: actualPackageName,
            paidAt: new Date(),
            bypassEnabledCheck: shouldSendWA,
            sendTelegram: shouldSendTG
          }
        );
      }
    }

    // Kirim Dokumen PDF Invoice via WhatsApp jika dicentang
    if (shouldSendPDF && customer && customer.phone && targetInvoiceIds.length > 0) {
      try {
        const { sendWADocument, whatsappStatus } = await import('../services/whatsappBot.mjs');
        if (whatsappStatus && whatsappStatus.connection === 'open') {
          const settings = getSettings();
          const mns = ['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agt','Sep','Okt','Nov','Des'];

          for (const invId of targetInvoiceIds) {
            const fullInv = billingSvc.getInvoiceById(invId);
            if (fullInv) {
              fullInv.package_name = actualPackageName;
              const periodStr = `${mns[(fullInv.period_month || 1) - 1]} ${fullInv.period_year}`;
              const safeName = (customer.name || 'Pelanggan').replace(/[^a-zA-Z0-9]/g, '_');
              const filename = `Invoice_${fullInv.id}_${safeName}.pdf`;
              const caption = `📄 *INVOICE PEMBAYARAN INTERNET*\n\nYth. *${customer.name}*,\nBerikut kami lampirkan dokumen resmi Invoice Pembayaran Internet untuk periode *${periodStr}*.\n\n📦 *Paket:* ${actualPackageName}\n💰 *Total Tagihan:* Rp ${Number(fullInv.amount || 0).toLocaleString('id-ID')}\n📌 *Status:* *LUNAS*\n\nTerima kasih telah menggunakan layanan *${settings.company_header || company()}*!`;
              const pdfBuffer = await pdfSvc.generateInvoicePdfBuffer(fullInv, customer, settings);
              await sendWADocument(customer.phone, pdfBuffer, filename, caption);
            }
          }
        }
      } catch (pdfErr) {
        logger.error('[PDF Send Error]: ' + pdfErr.message);
      }
    }

    // Auto buka isolir jika semua tagihan lunas
    const freshCustomer = customerSvc.getAllCustomers().find(c => String(c.id) === String(req.params.id));
    if (freshCustomer && freshCustomer.status === 'suspended' && freshCustomer.unpaid_count === 0) {
      await customerSvc.activateCustomer(req.params.id);
    }
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal bayar: ' + e.message };
  }
  res.redirect('back');
});
// ==================== AKHIR ROUTE BAYAR DARI MENU PELANGGAN ====================

// ─── PACKAGES ──────────────────────────────────────────────────────────────
router.get('/packages', requireAdminSession, requireSidebarMenuAccess('packages'), (req, res) => {
  const selectedRouterId = req.selectedRouterId || (req.query.router_id ? Number(req.query.router_id) : null);
  const routers = mikrotikService.getAllRouters();
  const packages = customerSvc.getAllPackages(selectedRouterId);
  res.render('admin/packages', {
    title: 'Paket Internet', company: company(), activePage: 'packages',
    packages, routers, selectedRouterId, msg: flashMsg(req)
  });
});

router.post('/packages', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    // Sanitasi tipe layanan dan router target
    req.body.service_type = req.body.service_type || 'pppoe';
    req.body.router_id = req.body.router_id ? Number(req.body.router_id) : null;
    
    // Pastikan kecepatan terhitung dalam Kbps (standar sistem)
    if (req.body.speed_down) req.body.speed_down = Math.round(Number(req.body.speed_down) * 1000);
    if (req.body.speed_up) req.body.speed_up = Math.round(Number(req.body.speed_up) * 1000);
    if (req.body.speed_down_upto) req.body.speed_down_upto = Math.round(Number(req.body.speed_down_upto) * 1000);
    if (req.body.speed_up_upto) req.body.speed_up_upto = Math.round(Number(req.body.speed_up_upto) * 1000);

    customerSvc.createPackage(req.body);
    req.session._msg = { type: 'success', text: `Paket "${req.body.name}" berhasil ditambahkan.` };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/packages');
});

router.post('/packages/:id/update', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    req.body.service_type = req.body.service_type || 'pppoe';
    req.body.router_id = req.body.router_id ? Number(req.body.router_id) : null;
    
    if (req.body.speed_down) req.body.speed_down = Math.round(Number(req.body.speed_down) * 1000);
    if (req.body.speed_up) req.body.speed_up = Math.round(Number(req.body.speed_up) * 1000);
    if (req.body.speed_down_upto) req.body.speed_down_upto = Math.round(Number(req.body.speed_down_upto) * 1000);
    if (req.body.speed_up_upto) req.body.speed_up_upto = Math.round(Number(req.body.speed_up_upto) * 1000);

    customerSvc.updatePackage(req.params.id, req.body);
    req.session._msg = { type: 'success', text: 'Paket berhasil diperbarui.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/packages');
});

router.post('/packages/:id/delete', requireAdminSession, (req, res) => {
  try {
    customerSvc.deletePackage(req.params.id);
    req.session._msg = { type: 'success', text: 'Paket berhasil dihapus.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/packages');
});

// ─── VOUCHER PACKAGES (ON-DEMAND REAL-TIME CONFIGURATION) ────────────────────
router.get('/vouchers/packages', requireAdminSession, requireSidebarMenuAccess('voucher_packages'), (req, res) => {
  const selectedRouterId = req.selectedRouterId || (req.query.router_id ? Number(req.query.router_id) : null);
  const routers = db.prepare('SELECT id, name FROM routers WHERE is_active = 1').all();
  res.render('admin/vouchers_packages', {
    title: 'Paket Voucher Hotspot', company: company(), activePage: 'voucher_packages',
    routers, selectedRouterId, msg: flashMsg(req)
  });
});

router.get('/api/vouchers/packages', requireAdminSession, (req, res) => {
  try {
    const selectedRouterId = req.selectedRouterId || (req.query.router_id ? Number(req.query.router_id) : null);
    let rows;
    if (selectedRouterId && selectedRouterId > 0) {
      rows = db.prepare(`
        SELECT vp.*, r.name AS router_name
        FROM voucher_packages vp
        LEFT JOIN routers r ON r.id = vp.router_id
        WHERE vp.router_id = ?
        ORDER BY vp.price ASC
      `).all(selectedRouterId);
    } else {
      rows = db.prepare(`
        SELECT vp.*, r.name AS router_name
        FROM voucher_packages vp
        LEFT JOIN routers r ON r.id = vp.router_id
        ORDER BY vp.price ASC
      `).all();
    }
    res.json({ ok: true, rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/api/vouchers/packages', requireAdminSession, express.json(), (req, res) => {
  try {
    const { router_id, profile_name, price, validity, prefix, code_length, charset, is_active } = req.body;
    
    // VALIDATION: router_id is REQUIRED for voucher packages
    if (!router_id || Number(router_id) <= 0) return res.status(400).json({ ok: false, error: 'Router harus dipilih' });
    
    // Verify router exists
    const router = db.prepare('SELECT id FROM routers WHERE id = ? LIMIT 1').get(Number(router_id));
    if (!router) return res.status(400).json({ ok: false, error: 'Router tidak ditemukan di database' });
    
    if (!profile_name) return res.status(400).json({ ok: false, error: 'Nama profil wajib diisi' });
    if (!price || Number(price) <= 0) return res.status(400).json({ ok: false, error: 'Harga harus lebih besar dari 0' });
    if (!validity) return res.status(400).json({ ok: false, error: 'Durasi/masa aktif wajib diisi' });

    const rId = router_id ? Number(router_id) : null;
    const prc = Math.floor(Number(price));
    const len = Math.max(4, Math.min(16, Number(code_length) || 6));
    const act = is_active === false || is_active === 0 || is_active === '0' ? 0 : 1;

    const stmt = db.prepare(`
      INSERT INTO voucher_packages (router_id, profile_name, price, validity, prefix, code_length, charset, is_active, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, (NOW_LOCAL()))
      ON CONFLICT(router_id, profile_name) DO UPDATE SET
        price=excluded.price,
        validity=excluded.validity,
        prefix=excluded.prefix,
        code_length=excluded.code_length,
        charset=excluded.charset,
        is_active=excluded.is_active,
        updated_at=(NOW_LOCAL())
    `);
    
    stmt.run(rId, profile_name, prc, String(validity).trim(), String(prefix || '').trim(), len, charset || 'mixed', act);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/api/vouchers/packages/:id/delete', requireAdminSession, (req, res) => {
  try {
    db.prepare('DELETE FROM voucher_packages WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── VOUCHER ONLINE TRANSACTIONS (PUBLIC VOUCHER ORDERS) ───────────────────
router.get('/vouchers/orders', requireAdminSession, requireSidebarMenuAccess('voucher_packages'), (req, res) => {
  const selectedRouterId = req.selectedRouterId || (req.query.router_id ? Number(req.query.router_id) : null);
  const routers = db.prepare('SELECT id, name FROM routers WHERE is_active = 1').all();
  res.render('admin/vouchers_orders', {
    title: 'Riwayat Transaksi Voucher Online',
    company: company(),
    activePage: 'voucher_packages',
    routers,
    selectedRouterId,
    msg: flashMsg(req)
  });
});

router.get('/api/vouchers/orders', requireAdminSession, (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit) || 20));
    const offset = (page - 1) * limit;
    const status = String(req.query.status || '').trim();
    const routerId = req.query.router_id ? Number(req.query.router_id) : null;
    const q = String(req.query.q || '').trim();

    const where = [];
    const params = [];

    if (status) {
      where.push('pvo.status = ?');
      params.push(status);
    }
    if (routerId && routerId > 0) {
      where.push('pvo.router_id = ?');
      params.push(routerId);
    }
    if (q) {
      where.push('(pvo.voucher_code LIKE ? OR pvo.buyer_phone LIKE ? OR pvo.profile_name LIKE ? OR CAST(pvo.id AS TEXT) LIKE ?)');
      params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
    }

    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

    // Summary statistics
    const statsRow = db.prepare(`
      SELECT 
        COUNT(*) as total_orders,
        SUM(CASE WHEN status IN ('paid', 'fulfilled') THEN price ELSE 0 END) as total_revenue,
        SUM(CASE WHEN status = 'fulfilled' THEN 1 ELSE 0 END) as fulfilled_count,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending_count,
        SUM(CASE WHEN status = 'expired' THEN 1 ELSE 0 END) as expired_count
      FROM public_voucher_orders
    `).get();

    // Total count for current filter
    const totalCount = db.prepare(`
      SELECT COUNT(*) as cnt 
      FROM public_voucher_orders pvo
      ${whereSql}
    `).get(...params).cnt;

    // Paginated list
    const rows = db.prepare(`
      SELECT pvo.*, r.name as router_name
      FROM public_voucher_orders pvo
      LEFT JOIN routers r ON r.id = pvo.router_id
      ${whereSql}
      ORDER BY pvo.id DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    // Format dates to local
    const formattedRows = rows.map(r => {
      const displayDate = r.paid_at || r.created_at;
      return {
        ...r,
        created_at: r.created_at ? formatDateLocal(r.created_at, 'YYYY-MM-DD HH:mm:ss') : null,
        paid_at: r.paid_at ? formatDateLocal(r.paid_at, 'YYYY-MM-DD HH:mm:ss') : null,
        fulfilled_at: r.fulfilled_at ? formatDateLocal(r.fulfilled_at, 'YYYY-MM-DD HH:mm:ss') : null,
        time_ago: displayDate ? formatDateLocal(displayDate, 'DD MMM YYYY, HH:mm') : '-'
      };
    });

    res.json({
      ok: true,
      rows: formattedRows,
      stats: statsRow || {},
      pagination: {
        page,
        limit,
        total: totalCount,
        totalPages: Math.ceil(totalCount / limit) || 1
      }
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/api/vouchers/orders/:id/resend-wa', requireAdminSession, async (req, res) => {
  try {
    const orderId = Number(req.params.id);
    const order = db.prepare('SELECT * FROM public_voucher_orders WHERE id = ?').get(orderId);
    if (!order) return res.status(404).json({ ok: false, error: 'Pesanan voucher tidak ditemukan' });
    if (!order.buyer_phone) return res.status(400).json({ ok: false, error: 'Nomor WhatsApp pembeli tidak tercatat' });
    if (!order.voucher_code) return res.status(400).json({ ok: false, error: 'Kode voucher belum digenerate untuk pesanan ini' });

    const { sendWA, whatsappStatus } = await import('../services/whatsappBot.mjs');
    if (whatsappStatus.connection !== 'open') {
      return res.status(400).json({ ok: false, error: 'Bot WhatsApp sedang tidak terhubung' });
    }

    const gateway = (order.payment_gateway || 'QRIS').toUpperCase();
    const { formatVoucherResend } = require('../services/whatsappService');
    const msg = formatVoucherResend({
      gateway,
      packageName: order.profile_name,
      validity: order.validity || '-',
      price: Number(order.price || 0).toLocaleString('id-ID'),
      username: order.voucher_code,
      password: order.voucher_password || order.voucher_code
    });

    await sendWA(order.buyer_phone, msg);

    db.prepare(`
      UPDATE public_voucher_orders
      SET wa_sent = 1, wa_sent_at = (NOW_LOCAL()), wa_error = '', updated_at = (NOW_LOCAL())
      WHERE id = ?
    `).run(orderId);

    res.json({ ok: true, message: 'Voucher berhasil dikirim ulang ke WhatsApp' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── BILLING ───────────────────────────────────────────────────────────────
router.get('/billing', requireAdminSession, requireSidebarMenuAccess('billing'), (req, res) => {
  const timeInfo = getCurrentTimeInfo();
  const { month: filterMonth, year: filterYear = timeInfo.year, status: filterStatus = 'all', search = '' } = req.query;
  
  // Deteksi kunci site staf
  let staffSite = '';
  if (req.session?.isStaff && req.session?.staffSite && req.session.staffSite !== 'all') {
    staffSite = req.session.staffSite;
  }

  const summary = billingSvc.getInvoiceSummary(filterMonth || timeInfo.month, filterYear, staffSite);
  const invoices = billingSvc.getAllInvoices({ month: filterMonth, year: filterYear, status: filterStatus, search, site: staffSite });
  res.render('admin/billing', {
    title: 'Tagihan', company: company(), activePage: 'billing',
    invoices, summary, filterMonth, filterYear: parseInt(filterYear), filterStatus, search, msg: flashMsg(req)
  });
});

router.get('/billing/:id/print', requireAdminSession, (req, res) => {
  const inv = billingSvc.getInvoiceById(req.params.id);
  if (!inv) return res.status(404).send('Invoice tidak ditemukan');
  
  const customer = customerSvc.getCustomerById(inv.customer_id);
  if (!customer) return res.status(404).send('Data pelanggan tidak ditemukan');

  const settings = getSettings();
  res.render('admin/print_invoice', {
    invoice: inv,
    customer,
    company: settings.company_header || 'IKDMP-CINTA',
    settings
  });
});

router.get('/billing/:id/print-thermal', requireAdminSession, (req, res) => {
  const inv = billingSvc.getInvoiceById(req.params.id);
  if (!inv) return res.status(404).send('Invoice tidak ditemukan');
  
  const customer = customerSvc.getCustomerById(inv.customer_id);
  if (!customer) return res.status(404).send('Data pelanggan tidak ditemukan');

  const settings = getSettings();
  res.render('collector/print_thermal', {
    invoice: inv,
    customer,
    company: settings.company_header || 'IKDMP-CINTA',
    settings,
    collectorName: req.session.adminUsername || 'Admin',
    formatDateLocal,
    formatTimeLocal,
    getNowLocal
  });
});

router.get('/billing/:id/pdf', requireAdminSession, async (req, res) => {
  try {
    const inv = billingSvc.getInvoiceById(req.params.id);
    if (!inv) return res.status(404).send('Invoice tidak ditemukan');
    
    const customer = customerSvc.getCustomerById(inv.customer_id);
    if (!customer) return res.status(404).send('Data pelanggan tidak ditemukan');

    const settings = getSettings();
    const pdfBuffer = await pdfSvc.generateInvoicePdfBuffer(inv, customer, settings);
    
    const safeName = (customer.name || 'Pelanggan').replace(/[^a-zA-Z0-9]/g, '_');
    const filename = `Invoice_INV-${String(inv.id).padStart(4, '0')}_${safeName}.pdf`;
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${filename}"`,
      'Content-Length': pdfBuffer.length
    });
    return res.send(pdfBuffer);
  } catch (err) {
    logger.error(`[PDF Download] Error: ${err.message}`);
    return res.status(500).send('Gagal generate PDF invoice: ' + err.message);
  }
});

router.post('/billing/:id/send-pdf-wa', requireAdminSession, async (req, res) => {
  try {
    const inv = billingSvc.getInvoiceById(req.params.id);
    if (!inv) return res.json({ success: false, message: 'Invoice tidak ditemukan' });
    
    const customer = customerSvc.getCustomerById(inv.customer_id);
    if (!customer) return res.json({ success: false, message: 'Data pelanggan tidak ditemukan' });
    if (!customer.phone) return res.json({ success: false, message: 'Nomor WhatsApp pelanggan belum terisi' });

    const settings = getSettings();
    const pdfBuffer = await pdfSvc.generateInvoicePdfBuffer(inv, customer, settings);

    const mns = ['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agt','Sep','Okt','Nov','Des'];
    const periodStr = `${mns[(inv.period_month || 1) - 1]} ${inv.period_year}`;
    const safeName = (customer.name || 'Pelanggan').replace(/[^a-zA-Z0-9]/g, '_');
    const filename = `Invoice_${inv.id}_${safeName}.pdf`;
    const statusText = inv.status === 'paid' ? 'LUNAS' : 'BELUM BAYAR';
    
    const { formatInvoicePdfCaption } = require('../services/whatsappService');
    const caption = formatInvoicePdfCaption({
      name: customer.name,
      period: periodStr,
      packageName: inv.package_name || customer.package_name || '-',
      total: Number(inv.amount || 0).toLocaleString('id-ID'),
      status: statusText,
      company: settings.company_header || company()
    });

    const { sendWADocument, whatsappStatus } = await import('../services/whatsappBot.mjs');
    if (whatsappStatus.connection !== 'open') {
      return res.json({ success: false, message: 'Bot WhatsApp belum terhubung' });
    }

    const sent = await sendWADocument(customer.phone, pdfBuffer, filename, caption);
    if (sent) {
      return res.json({ success: true, message: `Invoice PDF berhasil dikirim ke WhatsApp ${customer.name} (${customer.phone})` });
    } else {
      return res.json({ success: false, message: 'Gagal mengirim dokumen PDF ke WhatsApp' });
    }
  } catch (err) {
    logger.error(`[Send PDF WA] Error: ${err.message}`);
    return res.json({ success: false, message: 'Gagal kirim PDF: ' + err.message });
  }
});

router.post('/billing/generate', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    const { month, year } = req.body;
    const count = billingSvc.generateMonthlyInvoices(parseInt(month), parseInt(year));
    req.session._msg = { type: 'success', text: `${count} tagihan baru berhasil digenerate untuk periode ${month}/${year}.` };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal generate: ' + e.message };
  }
  res.redirect('/admin/billing');
});

router.get('/api/billing/unpaid/:customerId', requireAdmin, (req, res) => {
  try {
    const invoices = billingSvc.getUnpaidInvoicesByCustomerId(req.params.customerId);
    res.json(invoices);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/customers/:id/paid-months', requireAdmin, (req, res) => {
  try {
    const year = parseInt(req.query.year || getCurrentTimeInfo().year);
    const months = billingSvc.getPaidMonthsForCustomerYear(req.params.id, year);
    res.json({ year, months });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/customers/:id/billing-year', requireAdmin, (req, res) => {
  try {
    const year = parseInt(req.query.year || getCurrentTimeInfo().year);
    const summary = billingSvc.getCustomerBillingYearSummary(req.params.id, year);
    res.json(summary);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/billing/pay-bulk', requireAdminSession, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const { invoice_ids, paid_by_name, notes } = req.body;
    const ids = Array.isArray(invoice_ids) ? invoice_ids : [invoice_ids];
    const paidBy = resolvePaidByName(req, paid_by_name);
    
    if (!ids || ids.length === 0) throw new Error('Tidak ada tagihan yang dipilih');

    const paidByCustomer = new Map();
    const touchedCustomerIds = new Set();
    let processed = 0;
    for (const id of ids) {
      const inv = billingSvc.getInvoiceById(id);
      if (inv) {
        processed++;
        const customerId = Number(inv.customer_id || 0);
        if (Number.isFinite(customerId) && customerId > 0) touchedCustomerIds.add(customerId);
        const wasPaid = String(inv.status || '').toLowerCase() === 'paid';
        billingSvc.markAsPaid(id, paidBy, notes);
        if (!wasPaid) {
          if (!paidByCustomer.has(customerId)) paidByCustomer.set(customerId, []);
          paidByCustomer.get(customerId).push({
            id: inv.id,
            amount: Number(inv.amount || 0),
            period_month: inv.period_month,
            period_year: inv.period_year
          });
        }
      }
    }

    const customersSnapshot = customerSvc.getAllCustomers();
    for (const customerId of touchedCustomerIds) {
      const freshCustomer = customersSnapshot.find(c => Number(c.id) === Number(customerId));
      if (freshCustomer && freshCustomer.status === 'suspended' && Number(freshCustomer.unpaid_count || 0) === 0) {
        await customerSvc.activateCustomer(customerId);
      }
    }

    // ==================== NOTIFIKASI WA & TELEGRAM & PDF ====================
    const shouldSendWA = req.body.send_wa === '1' || req.body.send_wa === 'on' || req.body.send_wa === true;
    const shouldSendTG = req.body.send_tg === '1' || req.body.send_tg === 'on' || req.body.send_tg === true;
    const shouldSendPDF = req.body.send_pdf === '1' || req.body.send_pdf === 'on' || req.body.send_pdf === true;

    for (const [customerId, paidInvoices] of paidByCustomer.entries()) {
      if (!paidInvoices || paidInvoices.length === 0) continue;
      const customer = customerSvc.getCustomerById(customerId);
      if (customer) {
        const total = paidInvoices.reduce((a, b) => a + Number(b.amount || 0), 0);
        const periods = paidInvoices
          .map(x => whatsappService.formatIndonesianPeriod(x.period_month, x.period_year))
          .slice(0, 10)
          .join(', ') + (paidInvoices.length > 10 ? `, +${paidInvoices.length - 10} lainnya` : '');
        const pkg = customer.package_id ? customerSvc.getPackageById(customer.package_id) : null;

        const defaultTemplate = whatsappService.DEFAULT_PAYMENT_SUCCESS_TEMPLATE;
        const template = db.getAppSetting('whatsapp_payment_success_message', defaultTemplate);
        const settings = getSettings();
        const appUrl = (settings.public_base_url || '').replace(/\/$/, '');
        const portalUrl = appUrl ? `${appUrl}/customer` : '';

        // Format pesan resmi bawaan
        const formattedSuccessMsg = whatsappService.formatPaymentSuccessMessage({
          customerId: customer.id,
          customerName: customer.name || 'Pelanggan',
          invoiceId: paidInvoices.map(x => x.id).join(', '),
          customerUsername: customer.pppoe_username || customer.id || '-',
          packageName: pkg?.name || customer.package_name || '-',
          periodMonth: periods,
          periodYear: '',
          amount: String(total || '0').replace(/[^\d]/g, ''),
          paymentMethod: paidBy || 'Admin',
          paidAt: new Date(),
          companyName: company(),
          companyPhone: settings.company_phone || '',
          portalUrl,
          customTemplate: template
        });

        // 1. WhatsApp (Format Bawaan)
        if (shouldSendWA && customer.phone) {
          try {
            await trySendWhatsappPayment(customer.phone, formattedSuccessMsg);
            logger.info(`[WA Bulk Pay] Invoice lunas terkirim ke ${customer.phone}`);
          } catch (waErr) {
            logger.error('[WA Bulk Pay Error]: ' + waErr.message);
          }
        }

        // 2. Telegram (Format Bawaan Yang Persis Sama)
        if (shouldSendTG) {
          try {
            const token = settings.telegram_bot_token || '8326618412:AAGI-OagajN7ugnXjczOSUWYf5aKbwCcZP0';
            const chatId = settings.telegram_admin_id || '8507319451';
            if (token && chatId) {
              await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
                chat_id: chatId,
                text: formattedSuccessMsg
              });
              logger.info(`[TG Bulk Pay] Notifikasi lunas berhasil dikirim ke Telegram ID: ${chatId}`);
            }
          } catch (tgErr) {
            const errDetail = tgErr.response && tgErr.response.data ? JSON.stringify(tgErr.response.data) : tgErr.message;
            logger.error('[TG Bulk Pay Error]: ' + errDetail);
          }
        }

        // 3. PDF Invoice via WhatsApp (Format & Template Bawaan)
        if (shouldSendPDF && customer.phone) {
          try {
            const { sendWADocument, whatsappStatus } = await import('../services/whatsappBot.mjs');
            if (whatsappStatus && whatsappStatus.connection === 'open') {
              const mns = ['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agt','Sep','Okt','Nov','Des'];
              for (const pInv of paidInvoices) {
                const fullInv = billingSvc.getInvoiceById(pInv.id);
                if (fullInv) {
                  const invPeriod = `${mns[(fullInv.period_month || 1) - 1]} ${fullInv.period_year}`;
                  const safeName = (customer.name || 'Pelanggan').replace(/[^a-zA-Z0-9]/g, '_');
                  const filename = `Invoice_${fullInv.id}_${safeName}.pdf`;
                  const statusText = 'LUNAS';
				  //Ambil pesan dari template
                  const { formatInvoicePdfCaption } = require('../services/whatsappService');
                  const caption = formatInvoicePdfCaption({
                    name: customer.name,
                    period: invPeriod,
                    packageName: fullInv.package_name || customer.package_name || '-',
                    total: Number(fullInv.amount || 0).toLocaleString('id-ID'),
                    status: statusText,
                    company: settings.company_header || company()
                  });
				  
                  const pdfBuffer = await pdfSvc.generateInvoicePdfBuffer(fullInv, customer, settings);
                  await sendWADocument(customer.phone, pdfBuffer, filename, caption);
                }
              }
            }
          } catch (pdfErr) {
            logger.error('[Bulk PDF WA Error]: ' + pdfErr.message);
          }
        }
      }
    }

    req.session._msg = { type: 'success', text: `${processed} tagihan berhasil diproses.` };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal bayar massal: ' + e.message };
  }
  res.redirect(req.get('Referrer') || '/admin/billing');
});

router.post('/billing/delete-bulk', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    const { invoice_ids } = req.body;
    const ids = Array.isArray(invoice_ids) ? invoice_ids : [invoice_ids];
    const clean = ids
      .map(x => Number(x))
      .filter(n => Number.isFinite(n) && n > 0);
    if (!clean || clean.length === 0) throw new Error('Tidak ada tagihan yang dipilih');

    let deleted = 0;
    for (const id of clean) {
      try {
        billingSvc.deleteInvoice(id);
        deleted++;
      } catch {}
    }

    req.session._msg = { type: 'success', text: `${deleted} tagihan berhasil dihapus.` };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal hapus massal: ' + e.message };
  }
  res.redirect('back');
});

// ==================== AWAL ROUTE BAYAR DARI MENU BILLING ====================
router.post('/billing/:id/pay', requireAdminSession, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const inv = billingSvc.getInvoiceById(req.params.id);
    if (!inv) throw new Error('Tagihan tidak ditemukan');

    const paidBy = resolvePaidByName(req, req.body.paid_by_name);
    const wasPaid = String(inv.status || '').toLowerCase() === 'paid';
    if (!wasPaid) {
      billingSvc.markAsPaid(req.params.id, paidBy, req.body.notes);
    }
    
    // Reset kuota pemakaian saat lunas
    if (!wasPaid) {
      const targetCustId = Number(inv.customer_id);
      if (Number.isFinite(targetCustId) && targetCustId > 0) {
        db.prepare(`UPDATE customers SET bytes_in_monthly = 0, bytes_out_monthly = 0 WHERE id = ?`).run(targetCustId);
        db.prepare(`UPDATE customer_usage SET bytes_in = 0, bytes_out = 0 WHERE customer_id = ?`).run(targetCustId);
      }
    }

    const customer = customerSvc.getCustomerById(inv.customer_id);

    // Ambil opsi 3 Checkbox dari form
    const shouldSendWA = req.body.send_wa === '1' || req.body.send_wa === 'on' || req.body.send_wa === true;
    const shouldSendTG = req.body.send_tg === '1' || req.body.send_tg === 'on' || req.body.send_tg === true;
    const shouldSendPDF = req.body.send_pdf === '1' || req.body.send_pdf === 'on' || req.body.send_pdf === true;

    if (!wasPaid && customer) {
      // Pastikan ambil nama paket yang benar langsung dari tabel master packages
      let actualPkgName = '';
      if (customer.package_id) {
        const pkgData = db.prepare('SELECT name FROM packages WHERE id = ?').get(customer.package_id);
        if (pkgData && pkgData.name) actualPkgName = pkgData.name;
      }
      if (!actualPkgName && inv.package_name && inv.package_name.toLowerCase() !== 'admin') {
        actualPkgName = inv.package_name;
      }
      if (!actualPkgName && customer.package_name && customer.package_name.toLowerCase() !== 'admin') {
        actualPkgName = customer.package_name;
      }
      if (!actualPkgName) {
        actualPkgName = 'Reguler';
      }

      // Kirim WA & Telegram via helper terpusat
      await sendPaymentSuccessWA(
        customer.phone,
        customer.name,
        `${inv.period_month}/${inv.period_year}`,
        Number(inv.amount || 0).toLocaleString('id-ID'),
        paidBy,
        {
          customerId: customer.id,
          invoiceId: String(inv.id).padStart(4, '0'),
          username: customer.pppoe_username || customer.id,
          packageName: actualPkgName,
          paidAt: new Date(),
          bypassEnabledCheck: shouldSendWA,
          sendTelegram: shouldSendTG
        }
      );

      // Kirim PDF jika dicentang
      if (shouldSendPDF && customer.phone) {
        try {
          const { sendWADocument, whatsappStatus } = await import('../services/whatsappBot.mjs');
          if (whatsappStatus && whatsappStatus.connection === 'open') {
            const settings = getSettings();
            const mns = ['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agt','Sep','Okt','Nov','Des'];
            const invPeriod = `${mns[(inv.period_month || 1) - 1]} ${inv.period_year}`;
            const safeName = (customer.name || 'Pelanggan').replace(/[^a-zA-Z0-9]/g, '_');
            const filename = `Invoice_${inv.id}_${safeName}.pdf`;
			//Ambil Pesan Template PDF
            const { formatInvoicePdfCaption } = require('../services/whatsappService');
            const caption = formatInvoicePdfCaption({
              name: customer.name,
              period: invPeriod,
              packageName: actualPkgName,
              total: Number(inv.amount || 0).toLocaleString('id-ID'),
              status: 'LUNAS',
              company: settings.company_header || company()
            });
			
            inv.package_name = actualPkgName;
            const pdfBuffer = await pdfSvc.generateInvoicePdfBuffer(inv, customer, settings);
            await sendWADocument(customer.phone, pdfBuffer, filename, caption);
          }
        } catch (pdfErr) {
          logger.error('[PDF Pay WA Error]: ' + pdfErr.message);
        }
      }
    }

    if (customer && customer.status === 'suspended') {
      const unpaidCount = db.prepare("SELECT COUNT(*) as cnt FROM invoices WHERE customer_id=? AND status='unpaid'").get(inv.customer_id)?.cnt || 0;
      if (unpaidCount === 0) {
        await customerSvc.activateCustomer(inv.customer_id);
      }
    }

    req.session._msg = { type: 'success', text: wasPaid ? 'Tagihan ini memang sudah lunas sebelumnya.' : 'Tagihan berhasil ditandai lunas.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect(req.get('Referrer') || '/admin/billing');
});
// ==================== AKHIR ROUTE BAYAR DARI MENU BILLING ====================

router.post('/billing/:id/unpay', requireAdminSession, (req, res) => {
  try {
    billingSvc.markAsUnpaid(req.params.id);
    req.session._msg = { type: 'success', text: 'Status tagihan direset ke Belum Bayar.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('back');
});

router.post('/billing/:id/qris-assign', requireAdminSession, (req, res) => {
  try {
    const invId = Number(req.params.id);
    if (!Number.isFinite(invId) || invId <= 0) throw new Error('Invoice ID tidak valid');

    const force = String(req.query.force || '') === '1';
    const inv = db.prepare('SELECT id, status, amount, qris_amount_unique, customer_id FROM invoices WHERE id=?').get(invId);
    if (!inv) throw new Error('Tagihan tidak ditemukan');
    if (String(inv.status) !== 'unpaid') throw new Error('Hanya tagihan BELUM BAYAR yang bisa dibuat kode QRIS.');

    if (!force && inv.qris_amount_unique) {
      req.session._msg = { type: 'success', text: 'Kode QRIS sudah ada untuk tagihan ini.' };
      return res.redirect('back');
    }

    const { uniqueCode, amountUnique } = uniqueCodeService.ensureInvoiceQrisUnique(inv, force);
    req.session._msg = { type: 'success', text: `Kode QRIS dibuat: Rp ${Number(amountUnique).toLocaleString('id-ID')} (kode ${uniqueCode}).` };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal membuat kode QRIS: ' + e.message };
  }
  res.redirect('back');
});

router.post('/billing/:id/qris-clear', requireAdminSession, (req, res) => {
  try {
    const invId = Number(req.params.id);
    if (!Number.isFinite(invId) || invId <= 0) throw new Error('Invoice ID tidak valid');
    db.prepare(`
      UPDATE invoices
      SET qris_unique_code=NULL, qris_amount_unique=NULL, qris_assigned_at=NULL
      WHERE id=?
    `).run(invId);
    req.session._msg = { type: 'success', text: 'Kode QRIS dihapus dari tagihan.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal menghapus kode QRIS: ' + e.message };
  }
  res.redirect('back');
});

// ==================== 1. ROUTE KIRIM WA TAGIHAN BIASA + CEK QRIS ====================
router.post('/billing/:id/whatsapp', requireAdminSession, async (req, res) => {
  try {
    const inv = billingSvc.getInvoiceById(req.params.id);
    if (!inv) throw new Error('Tagihan tidak ditemukan');
    
    const customer = customerSvc.getCustomerById(inv.customer_id);
    if (!customer || !customer.phone) throw new Error('Nomor WhatsApp pelanggan tidak ditemukan atau belum diisi');

    const { sendWA, sendWAImage, whatsappStatus } = await import('../services/whatsappBot.mjs');
    if (!whatsappStatus || whatsappStatus.connection !== 'open') {
      throw new Error('Bot WhatsApp belum terhubung. Silakan hubungkan WhatsApp bot terlebih dahulu di menu WhatsApp.');
    }

    // Ambil semua tagihan unpaid pelanggan untuk total akumulasi terkini
    const unpaidInvoices = billingSvc.getUnpaidInvoicesByCustomerId(customer.id);
    const summary = whatsappService.formatUnpaidInvoicesSummary(
      (unpaidInvoices && unpaidInvoices.length > 0) ? unpaidInvoices : [inv]
    );
    const totalTagihan = summary.totalAmount > 0 ? summary.totalAmount : Number(inv.amount || 0);
    const rincianBulan = summary.periodText;
    const rincianDetail = summary.isMultiple ? `📋 *Rincian Tunggakan:*\n${summary.breakdownText}\n` : '';

    // LOGIKA QRIS PINTAR: CEK APAKAH SUDAH ADA & COCOK DENGAN TOTAL HARI INI
    let qrisAmountUnique = Number(inv.qris_amount_unique || 0) || 0;
    let qrisCode = Number(inv.qris_unique_code || 0) || 0;
    const baseAmount = totalTagihan > 0 ? totalTagihan : Number(inv.amount || 0);

    // Cek apakah kode QRIS sudah ada dan selisihnya pas dengan total tagihan
    const isQrisValidAndMatched = (qrisCode > 0 && qrisAmountUnique > 0 && (qrisAmountUnique - qrisCode === baseAmount));

    if (!isQrisValidAndMatched && String(inv.status) === 'unpaid') {
      // Jika belum ada QRIS atau nominalnya sudah tidak cocok (karena akumulasi bertambah),
      // update/timpa dengan kode QRIS baru yang akurat!
      try {
        const ensured = uniqueCodeService.ensureInvoiceQrisUnique(inv, true); // true = force update jika perlu
        qrisAmountUnique = ensured.amountUnique;
        qrisCode = ensured.uniqueCode;
        logger.info(`[Billing WA] QRIS baru/diperbarui untuk ${customer.name}: Rp ${qrisAmountUnique} (Kode: ${qrisCode})`);
      } catch (errQris) {
        logger.warn('[Billing WA] Gagal alokasi QRIS: ' + errQris.message);
      }
    } else if (isQrisValidAndMatched) {
      logger.info(`[Billing WA] Menggunakan QRIS yang sudah ada untuk ${customer.name}: Rp ${qrisAmountUnique} (Kode: ${qrisCode})`);
    }

    const qrisQrUrl = String(getSetting('qris_static_qr_url', '') || '').trim();
    const qrisPayloadSetting = String(getSetting('qris_static_payload', '') || '');
    const normalizeQrisPayload = (raw) => {
      let s = String(raw || '').replace(/[\r\n\t]+/g, '').trim();
      const idx = s.indexOf('000201');
      if (idx > 0) s = s.slice(idx);
      const lastCrc = s.lastIndexOf('6304');
      if (lastCrc >= 0 && s.length >= lastCrc + 8) s = s.slice(0, lastCrc + 8);
      return s;
    };

    let _decodedCache = global.__adminQrisDecodedCache || { file: '', mtimeMs: 0, payload: '' };
    const decodeQrisPayloadFromUploadedQr = async () => {
      const m = String(qrisQrUrl || '').match(/^\/uploads\/qris\/([^/?#]+)$/i);
      if (!m || !m[1]) return '';
      const safeName = path.basename(String(m[1]));
      const filePath = path.join(__dirname, '../public/uploads/qris', safeName);
      let st = null;
      try { st = await fs.promises.stat(filePath); } catch { return ''; }
      if (_decodedCache.file === safeName && _decodedCache.mtimeMs === st.mtimeMs && _decodedCache.payload) {
        return _decodedCache.payload;
      }
      try {
        const buf = await fs.promises.readFile(filePath);
        const img = await Jimp.read(buf);
        const rgba = new Uint8ClampedArray(img.bitmap.data.buffer, img.bitmap.data.byteOffset, img.bitmap.data.byteLength);
        const source = new RGBLuminanceSource(rgba, img.bitmap.width, img.bitmap.height);
        const bitmap = new BinaryBitmap(new HybridBinarizer(source));
        const reader = new MultiFormatReader();
        const hints = new Map();
        hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.QR_CODE]);
        reader.setHints(hints);
        const decoded = reader.decode(bitmap);
        const text = typeof decoded?.getText === 'function' ? decoded.getText() : String(decoded?.text || '');
        const payload = normalizeQrisPayload(text);
        if (!payload) return '';
        _decodedCache = { file: safeName, mtimeMs: st.mtimeMs, payload };
        global.__adminQrisDecodedCache = _decodedCache;
        return payload;
      } catch { return ''; }
    };

    const resolveQrisStaticPayload = async () => {
      const fromSetting = normalizeQrisPayload(qrisPayloadSetting);
      if (fromSetting) return fromSetting;
      return await decodeQrisPayloadFromUploadedQr();
    };

    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.get('host');
    let baseUrl = String(getSetting('app_url', '') || `${protocol}://${host}`).replace(/\/+$/, '');
    try {
      const parsed = new URL(baseUrl);
      baseUrl = parsed.origin;
    } catch {}
    const loginLink = `${baseUrl}/customer/login`;
    const qrisJpgLink = `${baseUrl}/customer/qris.jpg?amount=${qrisAmountUnique}`;

    const comp = company();
    const defaultAutoBilling = `{Halo|Selamat Pagi|Yth.} Pelanggan {{nama}},\n\n{Ini adalah|Berikut} pengingat pembayaran tagihan internet Anda.\n\n📦 *Paket:* {{paket}}\n💰 *Total Tagihan:* Rp {{tagihan}}\n📅 *Periode:* {{rincian}}\n\nSilakan lakukan pembayaran melalui portal pelanggan: {{link}}\n\nTerima kasih.\nSalam,\nAdmin ${comp}`;
    const defaultQris = `{Halo|Selamat Pagi|Yth.} Pelanggan {{nama}},\n\nBerikut rincian tagihan + QRIS Pembayaran Anda:\n\n📦 *Paket:* {{paket}}\n📅 *Periode:* {{periode}}\n💰 *Nominal:* Rp {{qris_nominal}}\n\nSilakan scan QRIS terlampir untuk melakukan pembayaran otomatis:\n{{qris_qr}}\n\nTerima kasih.`;

    const templateQris = db.getAppSetting('whatsapp_billing_qris_message', defaultQris);
    const template = db.getAppSetting('whatsapp_auto_billing_message', defaultAutoBilling);

    let pkgDisplayName = inv.package_name || customer.package_name || '';
    if (!pkgDisplayName && customer.package_id) {
      const pRow = db.prepare('SELECT name FROM packages WHERE id = ?').get(customer.package_id);
      if (pRow && pRow.name) pkgDisplayName = pRow.name;
    }
    if (!pkgDisplayName) pkgDisplayName = 'Paket Internet';

    const isQrisCase = (qrisAmountUnique > 0 && qrisCode > 0);
    const finalNominal = qrisAmountUnique > 0 ? qrisAmountUnique : totalTagihan;
    const finalNominalStr = Number(finalNominal).toLocaleString('id-ID');

    const displayPeriode = summary.isMultiple
      ? `${rincianBulan}\n\n${rincianDetail}`.trim()
      : rincianBulan;

    const qrisJpgCaption = isQrisCase
      ? templateQris
          .replace(/{{nama}}/gi, customer.name || 'Pelanggan')
          .replace(/{{rincian_detail}}/gi, rincianDetail)
          .replace(/{{periode}}/gi, displayPeriode)
          .replace(/{{rincian}}/gi, displayPeriode)
          .replace(/{{paket}}/gi, pkgDisplayName)
          .replace(/{{qris_nominal}}/gi, finalNominalStr)
          .replace(/{{tagihan}}/gi, finalNominalStr)
          .replace(/{{qris_kode}}/gi, String(qrisCode).padStart(3, '0'))
          .replace(/{{qris_qr}}/gi, `QRIS terlampir di atas.\n🌐 Portal Pelanggan: ${loginLink}`)
      : '';

    const formattedMsg = isQrisCase
      ? templateQris
          .replace(/{{nama}}/gi, customer.name || 'Pelanggan')
          .replace(/{{rincian_detail}}/gi, rincianDetail)
          .replace(/{{periode}}/gi, displayPeriode)
          .replace(/{{rincian}}/gi, displayPeriode)
          .replace(/{{paket}}/gi, pkgDisplayName)
          .replace(/{{qris_nominal}}/gi, finalNominalStr)
          .replace(/{{tagihan}}/gi, finalNominalStr)
          .replace(/{{qris_kode}}/gi, String(qrisCode).padStart(3, '0'))
          .replace(/{{qris_qr}}/gi, `🔗 Link Gambar QRIS: ${qrisJpgLink}\n🌐 Portal Pelanggan: ${loginLink}`)
      : template
          .replace(/{{nama}}/gi, customer.name || 'Pelanggan')
          .replace(/{{tagihan}}/gi, finalNominalStr)
          .replace(/{{qris_nominal}}/gi, finalNominalStr)
          .replace(/{{rincian_detail}}/gi, rincianDetail)
          .replace(/{{periode}}/gi, displayPeriode)
          .replace(/{{rincian}}/gi, displayPeriode)
          .replace(/{{paket}}/gi, pkgDisplayName)
          .replace(/{{link}}/gi, loginLink);

    let sent = false;
    if (isQrisCase) {
      try {
        const payloadNorm = await resolveQrisStaticPayload();
        if (payloadNorm) {
          const jpg = await qrisUtil.buildDynamicQrisJpgBuffer(payloadNorm, qrisAmountUnique, {
            customerName: customer.name,
            invoiceNumber: inv.invoice_number || `INV-${String(inv.id).padStart(4, '0')}`,
            packageName: pkgDisplayName
          });
          sent = await sendWAImage(customer.phone, jpg, qrisJpgCaption);
        }
      } catch (e) {
        logger.warn('[Billing WA] Gagal kirim gambar QRIS: ' + e.message);
        sent = false;
      }
    }

    if (!sent) {
      sent = await sendWA(customer.phone, formattedMsg);
    }

    if (!sent) throw new Error('Gagal mengirim pesan melalui WhatsApp Bot.');

    req.session._msg = { type: 'success', text: `Tagihan WhatsApp beserta QRIS berhasil dikirim ke ${customer.name}.` };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal kirim WA: ' + e.message };
  }
  res.redirect('back');
});

// ==================== 2. ROUTE KIRIM WA ISOLIR + SINKRONISASI QRIS ====================
router.post('/billing/:id/send-isolir-wa', requireAdminSession, async (req, res) => {
  try {
    const inv = billingSvc.getInvoiceById(req.params.id);
    if (!inv) throw new Error('Tagihan tidak ditemukan');
    
    const customer = customerSvc.getCustomerById(inv.customer_id);
    if (!customer || !customer.phone) throw new Error('Nomor WhatsApp pelanggan tidak ditemukan atau belum diisi');

    const { sendWA, sendWAImage, whatsappStatus } = await import('../services/whatsappBot.mjs');
    if (!whatsappStatus || whatsappStatus.connection !== 'open') {
      throw new Error('Bot WhatsApp belum terhubung. Silakan hubungkan WhatsApp bot terlebih dahulu.');
    }

    const unpaidInvoices = billingSvc.getUnpaidInvoicesByCustomerId(customer.id);
    const summary = whatsappService.formatUnpaidInvoicesSummary(
      (unpaidInvoices && unpaidInvoices.length > 0) ? unpaidInvoices : [inv]
    );
    const totalTagihan = summary.totalAmount > 0 ? summary.totalAmount : Number(inv.amount || 0);
    const rincianBulan = summary.periodText;
    const rincianDetail = summary.isMultiple ? `📋 *Rincian Tunggakan:*\n${summary.breakdownText}\n` : '';

    // SINKRON QRIS: GUNAKAN QRIS YANG SUDAH ADA AGAR SAMA DENGAN PESAN TAGIHAN
    let qrisAmountUnique = Number(inv.qris_amount_unique || 0) || 0;
    let qrisCode = Number(inv.qris_unique_code || 0) || 0;
    const baseAmount = totalTagihan > 0 ? totalTagihan : Number(inv.amount || 0);

    const isQrisValidAndMatched = (qrisCode > 0 && qrisAmountUnique > 0 && (qrisAmountUnique - qrisCode === baseAmount));

    if (!isQrisValidAndMatched && String(inv.status) === 'unpaid') {
      // Jika belum ada atau nominal akumulasinya berbeda, buatkan baru
      try {
        const ensured = uniqueCodeService.ensureInvoiceQrisUnique(inv, true);
        qrisAmountUnique = ensured.amountUnique;
        qrisCode = ensured.uniqueCode;
        logger.info(`[Isolir WA] QRIS baru/diperbarui untuk ${customer.name}: Rp ${qrisAmountUnique}`);
      } catch (errQris) {
        logger.warn('[Isolir WA] Gagal alokasi QRIS: ' + errQris.message);
      }
    } else if (isQrisValidAndMatched) {
      // Menggunakan QRIS yang sudah ada sebelumnya
      logger.info(`[Isolir WA] Menggunakan QRIS yang sama dengan tagihan untuk ${customer.name}: Rp ${qrisAmountUnique}`);
    }

    const qrisQrUrl = String(getSetting('qris_static_qr_url', '') || '').trim();
    const qrisPayloadSetting = String(getSetting('qris_static_payload', '') || '');
    const normalizeQrisPayload = (raw) => {
      let s = String(raw || '').replace(/[\r\n\t]+/g, '').trim();
      const idx = s.indexOf('000201');
      if (idx > 0) s = s.slice(idx);
      const lastCrc = s.lastIndexOf('6304');
      if (lastCrc >= 0 && s.length >= lastCrc + 8) s = s.slice(0, lastCrc + 8);
      return s;
    };

    let _decodedCache = global.__adminQrisDecodedCache || { file: '', mtimeMs: 0, payload: '' };
    const decodeQrisPayloadFromUploadedQr = async () => {
      const m = String(qrisQrUrl || '').match(/^\/uploads\/qris\/([^/?#]+)$/i);
      if (!m || !m[1]) return '';
      const safeName = path.basename(String(m[1]));
      const filePath = path.join(__dirname, '../public/uploads/qris', safeName);
      let st = null;
      try { st = await fs.promises.stat(filePath); } catch { return ''; }
      if (_decodedCache.file === safeName && _decodedCache.mtimeMs === st.mtimeMs && _decodedCache.payload) {
        return _decodedCache.payload;
      }
      try {
        const buf = await fs.promises.readFile(filePath);
        const img = await Jimp.read(buf);
        const rgba = new Uint8ClampedArray(img.bitmap.data.buffer, img.bitmap.data.byteOffset, img.bitmap.data.byteLength);
        const source = new RGBLuminanceSource(rgba, img.bitmap.width, img.bitmap.height);
        const bitmap = new BinaryBitmap(new HybridBinarizer(source));
        const reader = new MultiFormatReader();
        const hints = new Map();
        hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.QR_CODE]);
        reader.setHints(hints);
        const decoded = reader.decode(bitmap);
        const text = typeof decoded?.getText === 'function' ? decoded.getText() : String(decoded?.text || '');
        const payload = normalizeQrisPayload(text);
        if (!payload) return '';
        _decodedCache = { file: safeName, mtimeMs: st.mtimeMs, payload };
        global.__adminQrisDecodedCache = _decodedCache;
        return payload;
      } catch { return ''; }
    };

    const resolveQrisStaticPayload = async () => {
      const fromSetting = normalizeQrisPayload(qrisPayloadSetting);
      if (fromSetting) return fromSetting;
      return await decodeQrisPayloadFromUploadedQr();
    };

    const defaultIsolir = `Yth. Pelanggan {{nama}},\n\nLayanan internet Anda (Paket {{paket}}) saat ini ditangguhkan (Terisolir) karena belum melunasi tagihan sebesar *Rp {{tagihan}}*.\n\nSilakan scan QRIS berikut atau lakukan pembayaran melalui portal pelanggan: {{link}}\n\nTerima kasih.`;
    const templateIsolir = db.getAppSetting('whatsapp_isolir_message', defaultIsolir);

    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.get('host');
    let baseUrl = String(getSetting('app_url', '') || `${protocol}://${host}`).replace(/\/+$/, '');
    try {
      const parsed = new URL(baseUrl);
      baseUrl = parsed.origin;
    } catch {}
    const loginLink = `${baseUrl}/customer/login`;

    let pkgDisplayName = inv.package_name || customer.package_name || '';
    if (!pkgDisplayName && customer.package_id) {
      const pRow = db.prepare('SELECT name FROM packages WHERE id = ?').get(customer.package_id);
      if (pRow && pRow.name) pkgDisplayName = pRow.name;
    }
    if (!pkgDisplayName) pkgDisplayName = 'Paket Internet';

    const isQrisCase = (qrisAmountUnique > 0 && qrisCode > 0);
    const finalNominal = qrisAmountUnique > 0 ? qrisAmountUnique : totalTagihan;
    const finalNominalStr = Number(finalNominal).toLocaleString('id-ID');

    const displayPeriode = summary.isMultiple
      ? `${rincianBulan}\n\n${rincianDetail}`.trim()
      : rincianBulan;

    let formattedMsg = templateIsolir
      .replace(/{{nama}}/gi, customer.name || 'Pelanggan')
      .replace(/{{paket}}/gi, pkgDisplayName)
      .replace(/{{tagihan}}/gi, finalNominalStr)
      .replace(/{{nominal}}/gi, finalNominalStr)
      .replace(/{{rincian_detail}}/gi, summary.isMultiple ? `📋 *Rincian Tunggakan:*\n${summary.breakdownText}` : '')
      .replace(/{{rincian}}/gi, displayPeriode || '-')
      .replace(/{{periode}}/gi, displayPeriode || '-')
      .replace(/{{link}}/gi, loginLink);

    let sent = false;
    if (isQrisCase) {
      try {
        const payloadNorm = await resolveQrisStaticPayload();
        if (payloadNorm) {
          const jpg = await qrisUtil.buildDynamicQrisJpgBuffer(payloadNorm, qrisAmountUnique, {
            customerName: customer.name,
            invoiceNumber: inv.invoice_number || `INV-${String(inv.id).padStart(4, '0')}`,
            packageName: pkgDisplayName
          });
          sent = await sendWAImage(customer.phone, jpg, formattedMsg);
        }
      } catch (e) {
        logger.warn('[Isolir WA] Gagal kirim gambar QRIS: ' + e.message);
        sent = false;
      }
    }

    if (!sent) {
      sent = await sendWA(customer.phone, formattedMsg);
    }

    if (!sent) throw new Error('Gagal mengirim pesan melalui WhatsApp Bot.');

    req.session._msg = { type: 'success', text: `Pesan pemberitahuan isolir beserta QRIS berhasil dikirim ke ${customer.name}.` };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal kirim WA Isolir: ' + e.message };
  }
  res.redirect('back');
});
// ==============================================================================================
// ==================== AKHIR PERBAIKAN TOMBOL KIRIM WA BILLING + QRIS ====================

router.post('/billing/:id/delete', requireAdminSession, (req, res) => {
  try {
    billingSvc.deleteInvoice(req.params.id);
    req.session._msg = { type: 'success', text: 'Tagihan berhasil dihapus.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('back');
});

// ==============================================================================================

// ─── TICKETS ───────────────────────────────────────────────────────────────
const ticketSvc = require('../services/ticketService');

router.get('/tickets', requireAdminSession, requireSidebarMenuAccess('tickets'), (req, res) => {
  const { status = 'all' } = req.query;

  // Deteksi kunci site staf
  let staffSite = '';
  if (req.session?.isStaff && req.session?.staffSite && req.session.staffSite !== 'all') {
    staffSite = req.session.staffSite;
  }

  const tickets = ticketSvc.getAllTickets(status, staffSite);
  const stats = ticketSvc.getTicketStats();
  const customers = customerSvc.getAllCustomers();
  const techSvc = require('../services/techService');
  const technicians = techSvc.getAllTechnicians().filter(t => t.is_active === 1);
  
  res.render('admin/tickets', {
    title: 'Keluhan & Tugas Teknisi', company: company(), activePage: 'tickets',
    tickets, stats, customers, technicians, filterStatus: status, msg: flashMsg(req)
  });
});

router.post('/tickets/create', requireAdminSession, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const { customer_id, subject, message, technician_id, status } = req.body;
    if (!subject || !message) {
      req.session._msg = { type: 'error', text: 'Subjek dan Detail Pesan wajib diisi.' };
      return res.redirect('/admin/tickets');
    }

    const custId = customer_id ? parseInt(customer_id, 10) : 0;
    const techId = technician_id ? parseInt(technician_id, 10) : null;
    const ticketStatus = status || (techId ? 'in_progress' : 'open');

    const result = ticketSvc.createTicket(custId, subject, message, {
      technicianId: techId,
      status: ticketStatus
    });

    const ticketId = result.lastInsertRowid;
    req.session._msg = { type: 'success', text: 'Tiket/tugas baru berhasil dibuat!' };

    // --- WHATSAPP NOTIFICATION FOR NEW ADMIN CREATED TICKET ---
    try {
      const settings = getSettings();
      if (settings.whatsapp_enabled) {
        const { sendWA } = await import('../services/whatsappBot.mjs');
        const cust = custId ? customerSvc.getCustomerById(custId) : null;
        const techSvc = require('../services/techService');
        const tech = techId ? techSvc.getTechnicianById(techId) : null;

        const custName = cust ? cust.name : 'Tugas Umum / Maintenance Admin';
        const custPhone = cust ? cust.phone : '-';
        const custAddr = cust ? cust.address : '-';

        const waMsg = `📌 *TUGAS TEKNISI BARU DARI ADMIN*\n\n` +
                     `🎫 *ID Tiket:* #${ticketId}\n` +
                     `👤 *Pelanggan/Objek:* ${custName}\n` +
                     `📞 *Kontak:* ${custPhone}\n` +
                     `📍 *Alamat:* ${custAddr}\n` +
                     `📝 *Kendala/Tugas:* ${subject}\n` +
                     `💬 *Detail Pesan:* ${message}\n\n` +
                     `Silakan cek di portal teknisi/admin untuk menindaklanjuti.`;

        // Send to assigned technician or broadcast to all active technicians if not assigned
        if (tech && tech.phone) {
          let digits = String(tech.phone).replace(/\D/g, '');
          if (digits.startsWith('0')) digits = '62' + digits.slice(1);
          await sendWA(digits, waMsg);
        } else if (!techId) {
          const technicians = techSvc.getAllTechnicians().filter(t => t.is_active === 1 && t.phone);
          for (const t of technicians) {
            let digits = String(t.phone).replace(/\D/g, '');
            if (digits.startsWith('0')) digits = '62' + digits.slice(1);
            await sendWA(digits, waMsg);
          }
        }
      }
    } catch (waErr) {
      console.error(`[AdminPortal] WA Ticket Create Notification Error: ${waErr.message}`);
    }
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal membuat tiket: ' + e.message };
  }
  res.redirect('/admin/tickets');
});

router.post('/tickets/:id/update', requireAdminSession, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const { status, technician_id } = req.body;
    const ticketId = req.params.id;
    const oldTicket = ticketSvc.getTicketById(ticketId);
    
    const techId = (technician_id && parseInt(technician_id, 10) > 0) ? parseInt(technician_id, 10) : null;
    ticketSvc.updateTicketStatus(ticketId, status, techId);
    req.session._msg = { type: 'success', text: 'Status & penugasan keluhan berhasil diperbarui.' };

    // --- WHATSAPP NOTIFICATION IF TECHNICIAN IS ASSIGNED / CHANGED ---
    if (techId && (!oldTicket || Number(oldTicket.technician_id) !== techId)) {
      try {
        const settings = getSettings();
        if (settings.whatsapp_enabled) {
          const { sendWA } = await import('../services/whatsappBot.mjs');
          const techSvc = require('../services/techService');
          const newTech = techSvc.getTechnicianById(techId);
          const updatedTicket = ticketSvc.getTicketById(ticketId);

          if (newTech && newTech.phone && updatedTicket) {
            let digits = String(newTech.phone).replace(/\D/g, '');
            if (digits.startsWith('0')) digits = '62' + digits.slice(1);
            
            const waMsg = `📌 *PENUGASAN TIKET OLEH ADMIN*\n\n` +
                         `🎫 *ID Tiket:* #${updatedTicket.id}\n` +
                         `👤 *Pelanggan/Objek:* ${updatedTicket.customer_name}\n` +
                         `📞 *Kontak:* ${updatedTicket.customer_phone || '-'}\n` +
                         `📍 *Alamat:* ${updatedTicket.customer_address || '-'}\n` +
                         `📝 *Kendala/Tugas:* ${updatedTicket.subject}\n` +
                         `💬 *Detail Pesan:* ${updatedTicket.message}\n` +
                         `📊 *Status:* ${status}\n\n` +
                         `Silakan cek portal teknisi untuk memproses tugas ini.`;
            await sendWA(digits, waMsg);
          }
        }
      } catch (waErr) {
        console.error(`[AdminPortal] WA Assign Notification Error: ${waErr.message}`);
      }
    }

    // --- WHATSAPP NOTIFICATION FOR RESOLVED TICKET (BY ADMIN) ---
    if (status === 'resolved') {
      try {
        const settings = getSettings();
        if (settings.whatsapp_enabled) {
          const { sendWA } = await import('../services/whatsappBot.mjs');
          const ticket = ticketSvc.getTicketById(ticketId);
          
		  // Ambil Pesan Dari Template
          if (ticket) {
            const { formatTicketResolved } = require('../services/whatsappService');
            const waMsg = formatTicketResolved({
              id: ticket.id,
              name: ticket.customer_name,
              subject: ticket.subject,
              officer: 'Admin'
            });

            // Kirim ke Pelanggan
            if (ticket.customer_phone) {
              await sendWA(ticket.customer_phone, waMsg);
            }

            // Kirim ke Admin Numbers
            if (settings.whatsapp_admin_numbers && settings.whatsapp_admin_numbers.length > 0) {
              const adminMsg = `✅ *LAPORAN TIKET SELESAI (OLEH ADMIN)*\n\n` +
                               `🎫 *ID Tiket:* #${ticket.id}\n` +
                               `👤 *Pelanggan:* ${ticket.customer_name}\n` +
                               `📝 *Subjek:* ${ticket.subject}\n` +
                               `💬 *Pesan:* ${ticket.message}`;
              const seen = new Set();
              for (const adminPhone of settings.whatsapp_admin_numbers) {
                let digits = String(adminPhone || '').replace(/\D/g, '');
                if (!digits) continue;
                if (digits.startsWith('0')) digits = '62' + digits.slice(1);
                if (seen.has(digits)) continue;
                seen.add(digits);
                await sendWA(digits, adminMsg);
              }
            }
          }
        }
      } catch (waErr) {
        console.error(`[AdminPortal] WA Notification Error: ${waErr.message}`);
      }
    }
    // -------------------------------------------------------------

  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal update keluhan: ' + e.message };
  }
  res.redirect('back');
});

router.post('/tickets/:id/delete', requireAdminSession, (req, res) => {
  try {
    ticketSvc.deleteTicket(req.params.id);
    req.session._msg = { type: 'success', text: 'Keluhan berhasil dihapus.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal hapus keluhan: ' + e.message };
  }
  res.redirect('back');
});

// ─── REPORTS ───────────────────────────────────────────────────────────────
router.get('/reports', requireAdminSession, requireSidebarMenuAccess('reports'), (req, res) => {
  const now = new Date();
  const filterYear = parseInt(req.query.year) || now.getFullYear();
  const filterMonth = parseInt(req.query.month) || (now.getMonth() + 1);
  let filterSite = String(req.query.site || '').trim();

  // Jika yang login staf, paksa kunci ke site-nya!
  if (req.session?.isStaff && req.session?.staffSite && req.session.staffSite !== 'all') {
    filterSite = req.session.staffSite;
  }

  const yStr = String(filterYear);
  const mStr = String(filterMonth).padStart(2, '0');

  // Filter site klausa SQL
  const siteJoin = filterSite ? " JOIN customers c ON invoices.customer_id = c.id " : "";
  const siteInvWhere = filterSite ? " AND c.site = ? " : "";

  // 1. Data Piutang Tertinggi (Diperbaiki: CAST INTEGER DESC agar nominal besar selalu di atas)
  let topUnpaid = [];
  try {
    const topUnpaidSql = `
      SELECT c.id, c.name, c.phone, CAST(SUM(invoices.amount) AS INTEGER) as total_unpaid
      FROM invoices
      JOIN customers c ON invoices.customer_id = c.id
      WHERE invoices.status = 'unpaid' ${filterSite ? 'AND c.site = ?' : ''}
      GROUP BY c.id 
      ORDER BY CAST(SUM(invoices.amount) AS INTEGER) DESC 
      LIMIT 5
    `;
    topUnpaid = filterSite 
      ? db.prepare(topUnpaidSql).all(filterSite) 
      : db.prepare(topUnpaidSql).all();
  } catch (e) {
    topUnpaid = [];
  }

  // 2. Pelanggan aktif per site
  const activeCustomers = filterSite
    ? (db.prepare("SELECT COUNT(*) as c FROM customers WHERE site=? AND status IN ('active', 'ditangguhkan')").get(filterSite)?.c || 0)
    : (customerSvc.getCustomerStats().active);

  // 3. Tagihan & Pendapatan Bersih (Sinkron Bulan & Tahun)
  const numYear = Number(filterYear);
  const numMonth = Number(filterMonth);
  const strYear = String(filterYear);
  const strMonth = String(filterMonth).padStart(2, '0');

  // A. Piutang Tagihan KHUSUS BULAN & TAHUN YANG DIPILIH
  let pendingAmount = 0;
  try {
    if (filterSite) {
      const row = db.prepare(`
        SELECT COALESCE(SUM(i.amount), 0) as t 
        FROM invoices i
        JOIN customers c ON i.customer_id = c.id
        WHERE i.status = 'unpaid' 
          AND (i.period_year = ? OR i.period_year = ?)
          AND (i.period_month = ? OR i.period_month = ?)
          AND c.site = ?
      `).get(numYear, strYear, numMonth, strMonth, filterSite);
      pendingAmount = Number(row?.t || 0);
    } else {
      const row = db.prepare(`
        SELECT COALESCE(SUM(i.amount), 0) as t 
        FROM invoices i
        WHERE i.status = 'unpaid' 
          AND (i.period_year = ? OR i.period_year = ?)
          AND (i.period_month = ? OR i.period_month = ?)
      `).get(numYear, strYear, numMonth, strMonth);
      pendingAmount = Number(row?.t || 0);
    }
  } catch (err) {
    logger.error('[Reports] Error pendingAmount:', err.message);
    pendingAmount = 0;
  }

  // B. Tagihan Lunas (Invoices) - Tahunan & Bulanan
  let revenueYearAll = 0;
  let revenueThisMonthAll = 0;
  let revenueYearDirect = 0;
  let revenueThisMonthDirect = 0;

  try {
    if (filterSite) {
      // Tahunan Site
      const yRow = db.prepare(`
        SELECT COALESCE(SUM(i.amount), 0) as t 
        FROM invoices i
        JOIN customers c ON i.customer_id = c.id
        WHERE i.status = 'paid' AND (i.period_year = ? OR i.period_year = ?) AND c.site = ?
      `).get(numYear, strYear, filterSite);
      revenueYearAll = Number(yRow?.t || 0);

      // Bulanan Site
      const mRow = db.prepare(`
        SELECT COALESCE(SUM(i.amount), 0) as t 
        FROM invoices i
        JOIN customers c ON i.customer_id = c.id
        WHERE i.status = 'paid' 
          AND (i.period_year = ? OR i.period_year = ?)
          AND (i.period_month = ? OR i.period_month = ?)
          AND c.site = ?
      `).get(numYear, strYear, numMonth, strMonth, filterSite);
      revenueThisMonthAll = Number(mRow?.t || 0);

      revenueYearDirect = revenueYearAll;
      revenueThisMonthDirect = revenueThisMonthAll;
    } else {
      // Tahunan Semua
      const yRow = db.prepare(`
        SELECT COALESCE(SUM(i.amount), 0) as t 
        FROM invoices i
        WHERE i.status = 'paid' AND (i.period_year = ? OR i.period_year = ?)
      `).get(numYear, strYear);
      revenueYearAll = Number(yRow?.t || 0);

      // Bulanan Semua
      const mRow = db.prepare(`
        SELECT COALESCE(SUM(i.amount), 0) as t 
        FROM invoices i
        WHERE i.status = 'paid' 
          AND (i.period_year = ? OR i.period_year = ?)
          AND (i.period_month = ? OR i.period_month = ?)
      `).get(numYear, strYear, numMonth, strMonth);
      revenueThisMonthAll = Number(mRow?.t || 0);

      revenueYearDirect = revenueYearAll;
      revenueThisMonthDirect = revenueThisMonthAll;
    }
  } catch (err) {
    logger.error('[Reports] Error revenue invoices:', err.message);
  }

  const revenueYearAgent = 0;
  const revenueThisMonthAgent = 0;

  // C. Pemasukan Tambahan Kas Masuk (cash_in) & Penjualan Voucher Hotspot
  let customCashInYear = 0;
  let customCashInMonth = 0;
  try {
    const rowInY = db.prepare("SELECT COALESCE(SUM(amount), 0) as t FROM cash_in WHERE date LIKE ?").get(`${strYear}%`);
    customCashInYear = Number(rowInY?.t || 0);

    const rowInM = db.prepare("SELECT COALESCE(SUM(amount), 0) as t FROM cash_in WHERE date LIKE ?").get(`${strYear}-${strMonth}%`);
    customCashInMonth = Number(rowInM?.t || 0);
  } catch (e) {}

  let voucherYear = 0;
  let voucherMonth = 0;
  try {
    const vY = db.prepare("SELECT COALESCE(SUM(price), 0) as t FROM public_voucher_orders WHERE status IN ('paid','fulfilled') AND created_at LIKE ?").get(`${strYear}%`);
    voucherYear = Number(vY?.t || 0);

    const vM = db.prepare("SELECT COALESCE(SUM(price), 0) as t FROM public_voucher_orders WHERE status IN ('paid','fulfilled') AND created_at LIKE ?").get(`${strYear}-${strMonth}%`);
    voucherMonth = Number(vM?.t || 0);
  } catch (e) {}

  let agentDepositYear = 0;
  let agentDepositThisMonth = 0;
  try {
    const aY = db.prepare("SELECT COALESCE(SUM(amount_buy), 0) as t FROM agent_transactions WHERE type='topup' AND created_at LIKE ?").get(`${strYear}%`);
    agentDepositYear = Number(aY?.t || 0);

    const aM = db.prepare("SELECT COALESCE(SUM(amount_buy), 0) as t FROM agent_transactions WHERE type='topup' AND created_at LIKE ?").get(`${strYear}-${strMonth}%`);
    agentDepositThisMonth = Number(aM?.t || 0);
  } catch (e) {}

  // TOTAL KAS MASUK (Tagihan Lunas + Kas Lainnya + Voucher)
  const cashInYear = revenueYearAll + (filterSite ? 0 : customCashInYear) + (filterSite ? 0 : voucherYear);
  const cashInThisMonth = revenueThisMonthAll + (filterSite ? 0 : customCashInMonth) + (filterSite ? 0 : voucherMonth);

  // D. PENGELUARAN (Expenses)
  let expensesRegularYear = 0;
  let expensesRegularMonth = 0;
  try {
    const expY = db.prepare("SELECT COALESCE(SUM(amount), 0) as t FROM expenses WHERE date LIKE ?").get(`${strYear}%`);
    expensesRegularYear = Number(expY?.t || 0);

    const expM = db.prepare("SELECT COALESCE(SUM(amount), 0) as t FROM expenses WHERE date LIKE ?").get(`${strYear}-${strMonth}%`);
    expensesRegularMonth = Number(expM?.t || 0);
  } catch (e) {}

  let digiflazzCostYear = 0;
  let digiflazzCostMonth = 0;
  try {
    const dgY = db.prepare("SELECT COALESCE(SUM(digi_price), 0) as t FROM agent_transactions WHERE type='pulsa' AND digi_status='sukses' AND created_at LIKE ?").get(`${strYear}%`);
    digiflazzCostYear = Number(dgY?.t || 0);

    const dgM = db.prepare("SELECT COALESCE(SUM(digi_price), 0) as t FROM agent_transactions WHERE type='pulsa' AND digi_status='sukses' AND created_at LIKE ?").get(`${strYear}-${strMonth}%`);
    digiflazzCostMonth = Number(dgM?.t || 0);
  } catch (e) {}

  const expensesYear = expensesRegularYear + digiflazzCostYear;
  const expensesMonth = expensesRegularMonth + digiflazzCostMonth;

  // E. Laba Bersih
  const netProfitYear = cashInYear - expensesYear;
  const netProfitMonth = cashInThisMonth - expensesMonth;

  // Rincian Pengeluaran berdasarkan kategori
  let expensesByCategory = [];
  try {
    expensesByCategory = db.prepare("SELECT category, COALESCE(SUM(amount), 0) as total FROM expenses WHERE date LIKE ? GROUP BY category").all(`${strYear}%`);
    if (digiflazzCostYear > 0) {
      expensesByCategory.push({ category: 'Modal PPOB (Digiflazz)', total: digiflazzCostYear });
    }
    expensesByCategory.sort((a, b) => b.total - a.total);
  } catch (e) {
    expensesByCategory = [];
  }

  // 4. GENERATE 12 BULAN LENGKAP UNTUK GRAFIK & TABEL (Pasti Terisi & Sinkron)
  const monthlyData = [];
  for (let m = 1; m <= 12; m++) {
    const padM = String(m).padStart(2, '0');
    
    // Total invoice terbit & terbayar di bulan tersebut
    const invParams = filterSite ? [filterYear, m, filterSite] : [filterYear, m];
    const invStat = db.prepare(`
      SELECT 
        COUNT(1) as total_invoices,
        SUM(CASE WHEN invoices.status = 'paid' THEN 1 ELSE 0 END) as paid_count,
        SUM(CASE WHEN invoices.status = 'paid' THEN invoices.amount ELSE 0 END) as income
      FROM invoices ${siteJoin}
      WHERE invoices.period_year = ? AND invoices.period_month = ? ${siteInvWhere}
    `).get(...invParams) || { total_invoices: 0, paid_count: 0, income: 0 };

    // Pengeluaran di bulan tersebut
    const expRow = db.prepare(
      "SELECT SUM(amount) as t FROM expenses WHERE (strftime('%Y', date) = ? AND strftime('%m', date) = ?) OR date LIKE ?"
    ).get(yStr, padM, `${yStr}-${padM}%`);
    const digiMonth = Number(db.prepare("SELECT SUM(digi_price) as t FROM agent_transactions WHERE type='pulsa' AND digi_status='sukses' AND (strftime('%Y-%m', created_at) = ? OR created_at LIKE ?)").get(`${yStr}-${padM}`, `${yStr}-${padM}-%`)?.t || 0);
    const mExpense = Number(expRow?.t || 0) + digiMonth;

    const mIncome = Number(invStat.income || 0);
    const mNetProfit = mIncome - mExpense;

    monthlyData.push({
      month: m,
      income: mIncome,
      expense: mExpense,
      net_profit: mNetProfit,
      paid_count: Number(invStat.paid_count || 0),
      total_invoices: Number(invStat.total_invoices || 0)
    });
  }

  // 5. Pembayaran Terakhir
  const recentPayments = billingSvc.getRecentPayments(10, filterSite);

  res.render('admin/reports', {
    title: 'Laporan Laba / Rugi', company: company(), activePage: 'reports',
    filterYear, filterMonth, filterSite, 
    monthlyData, 
    chartData: monthlyData, 
    recentPayments, 
    topUnpaid,
    totalRevenue: revenueYearAll,
    thisMonth: revenueThisMonthAll,
    pendingAmount,
    activeCustomers,
    revenueYearAgent,
    revenueThisMonthAgent,
    agentDepositYear,
    agentDepositThisMonth,
    customCashInYear,
    customCashInMonth,
    cashInYear,
    cashInThisMonth,
    expensesYear,
    expensesMonth,
    netProfitYear,
    netProfitMonth,
    expensesByCategory
  });
});
//AKHIR

// ─── CETAK PRINT PDF LAPORAN KEUANGAN (KOP SURAT RESMI + A4 FIT) ─────────────
router.get('/reports/print', requireAdminSession, requireSidebarMenuAccess('reports'), (req, res) => {
  try {
    const now = new Date();
    const filterYear = parseInt(req.query.year) || now.getFullYear();
    const filterMonth = parseInt(req.query.month) || (now.getMonth() + 1);
    let filterSite = String(req.query.site || '').trim();

    if (req.session?.isStaff && req.session?.staffSite && req.session.staffSite !== 'all') {
      filterSite = req.session.staffSite;
    }

    const numYear = Number(filterYear);
    const numMonth = Number(filterMonth);
    const strYear = String(filterYear);
    const strMonth = String(filterMonth).padStart(2, '0');

    const monthNames = [
      'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
      'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'
    ];
    const selMonthLabel = monthNames[filterMonth - 1] || 'Bulan Berjalan';

    // Ambil Pengaturan Perusahaan (Logo, Alamat, Kontak)
    const settings = getSettings();
    const compName = settings.company_header || company() || 'ISP BILLING';
    const compAddress = settings.company_address || 'Jl. Raya Internet No. 1, Indonesia';
    const compPhone = settings.company_phone || settings.company_whatsapp || '-';
    const compEmail = settings.company_email || 'finance@isp.net';

    // Cek ketersediaan file logo
    let logoHtml = '';
    const logoFilePath = path.join(__dirname, '../public/img/logo.png');
    if (fs.existsSync(logoFilePath)) {
      logoHtml = `<img src="/img/logo.png" alt="Logo" class="comp-logo">`;
    } else {
      logoHtml = `<div class="logo-placeholder"><span style="font-size:24px;font-weight:900;color:#0284c7;">⚡</span></div>`;
    }

    // 1. Data Invoices Bulan Ini
    let invoices = [];
    if (filterSite) {
      invoices = db.prepare(`
        SELECT i.*, c.name as customer_name, c.phone as customer_phone, c.address as customer_address, p.name as package_name
        FROM invoices i
        JOIN customers c ON i.customer_id = c.id
        LEFT JOIN packages p ON c.package_id = p.id
        WHERE (i.period_year = ? OR i.period_year = ?)
          AND (i.period_month = ? OR i.period_month = ?)
          AND c.site = ?
        ORDER BY i.status ASC, c.name ASC
      `).all(numYear, strYear, numMonth, strMonth, filterSite);
    } else {
      invoices = db.prepare(`
        SELECT i.*, c.name as customer_name, c.phone as customer_phone, c.address as customer_address, p.name as package_name
        FROM invoices i
        JOIN customers c ON i.customer_id = c.id
        LEFT JOIN packages p ON c.package_id = p.id
        WHERE (i.period_year = ? OR i.period_year = ?)
          AND (i.period_month = ? OR i.period_month = ?)
        ORDER BY i.status ASC, c.name ASC
      `).all(numYear, strYear, numMonth, strMonth);
    }

    let paidTotal = 0;
    let unpaidTotal = 0;
    let paidCount = 0;
    let unpaidCount = 0;

    for (const inv of invoices) {
      const amt = Number(inv.amount || 0);
      if (inv.status === 'paid') {
        paidTotal += amt;
        paidCount++;
      } else {
        unpaidTotal += amt;
        unpaidCount++;
      }
    }

    // 2. Data Pengeluaran Bulan Ini
    const expenses = db.prepare(`
      SELECT date, category, amount, description 
      FROM expenses 
      WHERE date LIKE ? 
      ORDER BY date ASC
    `).all(`${strYear}-${strMonth}%`);

    let totalExpenses = 0;
    for (const exp of expenses) {
      totalExpenses += Number(exp.amount || 0);
    }

    // 3. Kas Masuk Tambahan Bulan Ini
    const cashInList = db.prepare(`
      SELECT date, category, amount, description 
      FROM cash_in 
      WHERE date LIKE ? 
      ORDER BY date ASC
    `).all(`${strYear}-${strMonth}%`);

    let totalCashIn = 0;
    for (const c of cashInList) {
      totalCashIn += Number(c.amount || 0);
    }

    const netProfit = (paidTotal + totalCashIn) - totalExpenses;

    const html = `
<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <title>Laporan_Keuangan_${filterYear}_${strMonth}</title>
  <style>
    @page { 
      size: A4 portrait; 
      margin: 12mm 14mm 14mm 14mm; 
    }
    * { box-sizing: border-box; }
    body { 
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; 
      font-size: 10px; 
      line-height: 1.4; 
      color: #1e293b; 
      margin: 0; 
      padding: 0; 
      background: #fff;
    }
    
    /* TOOLBAR ATAS (HILANG SAAT PRINT) */
    .no-print { 
      background: #f8fafc; 
      border: 1px solid #cbd5e1; 
      padding: 10px 16px; 
      margin-bottom: 16px; 
      border-radius: 6px; 
      display: flex; 
      justify-content: space-between; 
      align-items: center; 
    }
    .btn-print { 
      background: #0284c7; 
      color: #fff; 
      border: none; 
      padding: 7px 16px; 
      border-radius: 4px; 
      cursor: pointer; 
      font-weight: bold; 
      font-size: 11px; 
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .btn-print:hover { background: #0369a1; }

    /* KOP SURAT RESMI SEPERTI INVOICE */
    .kop-surat { 
      display: flex; 
      align-items: center; 
      justify-content: space-between; 
      border-bottom: 2.5px solid #0f172a; 
      padding-bottom: 12px; 
      margin-bottom: 14px; 
    }
    .kop-left { 
      display: flex; 
      align-items: center; 
      gap: 14px; 
    }
    .comp-logo { 
      max-height: 60px; 
      max-width: 130px; 
      object-fit: contain; 
    }
    .logo-placeholder { 
      width: 55px; 
      height: 55px; 
      background: #e0f2fe; 
      border-radius: 8px; 
      display: flex; 
      align-items: center; 
      justify-content: center; 
    }
    .comp-info h1 { 
      font-size: 16px; 
      font-weight: 800; 
      color: #0f172a; 
      margin: 0 0 2px 0; 
      letter-spacing: 0.5px;
      text-transform: uppercase;
    }
    .comp-info p { 
      margin: 0; 
      color: #475569; 
      font-size: 9.5px; 
      line-height: 1.35;
    }
    .kop-right { 
      text-align: right; 
    }
    .kop-right .doc-title { 
      font-size: 15px; 
      font-weight: 800; 
      color: #0284c7; 
      text-transform: uppercase; 
      margin: 0 0 2px 0;
      letter-spacing: 0.5px;
    }
    .kop-right .doc-meta { 
      font-size: 9.5px; 
      color: #64748b; 
      margin: 1px 0; 
    }
    .badge-site { 
      background: #0f172a; 
      color: #fff; 
      font-size: 9px; 
      padding: 2px 6px; 
      border-radius: 3px; 
      font-weight: bold; 
    }

    /* KARTU SUMMARY */
    .summary-grid { 
      display: grid; 
      grid-template-columns: repeat(4, 1fr); 
      gap: 8px; 
      margin-bottom: 14px; 
    }
    .sum-box { 
      border: 1px solid #cbd5e1; 
      border-radius: 5px; 
      padding: 8px 10px; 
      background: #f8fafc; 
    }
    .sum-title { 
      font-size: 8.5px; 
      font-weight: 700; 
      text-transform: uppercase; 
      color: #64748b; 
      margin-bottom: 2px; 
    }
    .sum-val { 
      font-size: 13px; 
      font-weight: 800; 
      color: #0f172a; 
    }
    .sum-sub { 
      font-size: 8px; 
      color: #94a3b8; 
      margin-top: 1px; 
    }
    .text-green { color: #16a34a !important; }
    .text-red { color: #dc2626 !important; }
    .text-blue { color: #0284c7 !important; }

    /* TABEL DATA */
    .sec-title { 
      font-size: 10.5px; 
      font-weight: 800; 
      color: #0f172a; 
      text-transform: uppercase; 
      border-bottom: 1px solid #cbd5e1; 
      padding-bottom: 3px; 
      margin: 12px 0 6px 0; 
      display: flex;
      justify-content: space-between;
    }
    table { 
      width: 100%; 
      border-collapse: collapse; 
      font-size: 9px; 
      margin-bottom: 10px; 
    }
    th { 
      background: #f1f5f9; 
      color: #334155; 
      text-align: left; 
      padding: 5px 6px; 
      border: 1px solid #cbd5e1; 
      font-weight: 700; 
    }
    td { 
      padding: 4px 6px; 
      border: 1px solid #e2e8f0; 
    }
    tr:nth-child(even) { background-color: #fafbfc; }
    .t-center { text-align: center; }
    .t-right { text-align: right; }
    .badge { 
      padding: 2px 5px; 
      border-radius: 3px; 
      font-size: 8px; 
      font-weight: 800; 
      text-transform: uppercase; 
      display: inline-block;
    }
    .badge-paid { background: #dcfce7; color: #15803d; }
    .badge-unpaid { background: #fee2e2; color: #b91c1c; }

    /* FOOTER & TANDA TANGAN */
    .print-footer { 
      margin-top: 25px; 
      display: flex; 
      justify-content: space-between; 
      align-items: flex-end; 
      page-break-inside: avoid; 
    }
    .footer-notes { 
      font-size: 8.5px; 
      color: #64748b; 
      line-height: 1.4; 
      max-width: 320px; 
    }
    .ttd-wrap { 
      text-align: center; 
      width: 180px; 
    }
    .ttd-title { 
      font-size: 9px; 
      color: #475569; 
      margin-bottom: 45px; 
    }
    .ttd-name { 
      font-size: 10px; 
      font-weight: 800; 
      color: #0f172a; 
      border-top: 1px solid #334155; 
      padding-top: 4px; 
      text-transform: uppercase;
    }

    @media print {
      body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      .no-print { display: none !important; }
      tr { page-break-inside: avoid; }
    }
  </style>
</head>
<body>

  <!-- Tombol Aksi Layar -->
  <div class="no-print">
    <div>
      <span style="font-weight:600;color:#0f172a;">Pratinjau Cetak Laporan Keuangan A4</span>
      <span style="color:#64748b;margin-left:8px;font-size:10px;">(Pilih 'Save as PDF' atau langsung cetak printer)</span>
    </div>
    <button class="btn-print" onclick="window.print()">
      🖨️ Cetak Dokumen / Simpan PDF
    </button>
  </div>

  <!-- KOP SURAT RESMI -->
  <div class="kop-surat">
    <div class="kop-left">
      ${logoHtml}
      <div class="comp-info">
        <h1>${compName}</h1>
        <p>${compAddress}</p>
        <p>WhatsApp/Telp: <strong>${compPhone}</strong> • Email: ${compEmail}</p>
      </div>
    </div>
    <div class="kop-right">
      <div class="doc-title">Laporan Keuangan</div>
      <div class="doc-meta">Periode: <strong>${selMonthLabel} ${filterYear}</strong></div>
      <div class="doc-meta">Site: ${filterSite ? `<span class="badge-site">${filterSite.toUpperCase()}</span>` : '<strong>Semua Wilayah</strong>'}</div>
      <div class="doc-meta" style="font-size:8.5px;margin-top:2px;">Waktu Cetak: ${new Date().toLocaleString('id-ID')}</div>
    </div>
  </div>

  <!-- RINGKASAN KEUANGAN BULANAN -->
  <div class="summary-grid">
    <div class="sum-box">
      <div class="sum-title">Tagihan Terbayar</div>
      <div class="sum-val text-green">Rp ${paidTotal.toLocaleString('id-ID')}</div>
      <div class="sum-sub">${paidCount} dari ${invoices.length} Pelanggan Lunas</div>
    </div>
    <div class="sum-box">
      <div class="sum-title">Piutang Belum Bayar</div>
      <div class="sum-val text-red">Rp ${unpaidTotal.toLocaleString('id-ID')}</div>
      <div class="sum-sub">${unpaidCount} Pelanggan Tertunggak</div>
    </div>
    <div class="sum-box">
      <div class="sum-title">Total Kas Keluar</div>
      <div class="sum-val text-red">-Rp ${totalExpenses.toLocaleString('id-ID')}</div>
      <div class="sum-sub">${expenses.length} Transaksi Beban Operasional</div>
    </div>
    <div class="sum-box">
      <div class="sum-title">Laba Bersih Riil</div>
      <div class="sum-val ${netProfit >= 0 ? 'text-green' : 'text-red'}">Rp ${netProfit.toLocaleString('id-ID')}</div>
      <div class="sum-sub">${netProfit >= 0 ? 'Surplus / Profit' : 'Defisit Operasional'}</div>
    </div>
  </div>

  <!-- TABEL 1: RINCIAN TAGIHAN PELANGGAN -->
  <div class="sec-title">
    <span>1. Rincian Tagihan Pelanggan (${selMonthLabel} ${filterYear})</span>
    <span style="font-size:9px;color:#64748b;">Total Terbit: ${invoices.length} Pelanggan</span>
  </div>
  <table>
    <thead>
      <tr>
        <th style="width:24px" class="t-center">No</th>
        <th>Nama Pelanggan</th>
        <th>Telepon</th>
        <th>Paket Layanan</th>
        <th class="t-right" style="width:75px">Tagihan</th>
        <th class="t-center" style="width:70px">Status</th>
        <th style="width:105px">Tanggal Bayar</th>
      </tr>
    </thead>
    <tbody>
      ${invoices.length === 0 ? '<tr><td colspan="7" class="t-center" style="padding:10px;color:#94a3b8;">Tidak ada data tagihan pada periode ini.</td></tr>' : ''}
      ${invoices.map((inv, idx) => `
        <tr>
          <td class="t-center">${idx + 1}</td>
          <td><strong>${inv.customer_name || '-'}</strong></td>
          <td>${inv.customer_phone || '-'}</td>
          <td>${inv.package_name || '-'}</td>
          <td class="t-right">Rp ${Number(inv.amount || 0).toLocaleString('id-ID')}</td>
          <td class="t-center"><span class="badge ${inv.status === 'paid' ? 'badge-paid' : 'badge-unpaid'}">${inv.status === 'paid' ? 'LUNAS' : 'BELUM BAYAR'}</span></td>
          <td>${inv.paid_at ? inv.paid_at.slice(0, 16) : '-'}</td>
        </tr>
      `).join('')}
    </tbody>
    <tfoot>
      <tr style="background:#f1f5f9;font-weight:bold;">
        <td colspan="4" class="t-right">TOTAL TAGIHAN LUNAS:</td>
        <td class="t-right text-green">Rp ${paidTotal.toLocaleString('id-ID')}</td>
        <td colspan="2"></td>
      </tr>
    </tfoot>
  </table>

  <!-- TABEL 2: RINCIAN PENGELUARAN KAS -->
  <div class="sec-title">
    <span>2. Rincian Pengeluaran Operasional (${expenses.length} Transaksi)</span>
  </div>
  <table>
    <thead>
      <tr>
        <th style="width:24px" class="t-center">No</th>
        <th style="width:75px">Tanggal</th>
        <th style="width:130px">Kategori Beban</th>
        <th>Deskripsi / Keperluan</th>
        <th class="t-right" style="width:90px">Jumlah</th>
      </tr>
    </thead>
    <tbody>
      ${expenses.length === 0 ? '<tr><td colspan="5" class="t-center" style="padding:10px;color:#94a3b8;">Belum ada catatan pengeluaran kas di bulan ini.</td></tr>' : ''}
      ${expenses.map((exp, idx) => `
        <tr>
          <td class="t-center">${idx + 1}</td>
          <td>${exp.date ? exp.date.slice(0, 10) : '-'}</td>
          <td><strong>${exp.category || 'Operasional'}</strong></td>
          <td>${exp.description || '-'}</td>
          <td class="t-right text-red">-Rp ${Number(exp.amount || 0).toLocaleString('id-ID')}</td>
        </tr>
      `).join('')}
    </tbody>
    <tfoot>
      <tr style="background:#f1f5f9;font-weight:bold;">
        <td colspan="4" class="t-right">TOTAL PENGELUARAN:</td>
        <td class="t-right text-red">-Rp ${totalExpenses.toLocaleString('id-ID')}</td>
      </tr>
    </tfoot>
  </table>

  <!-- FOOTER & LEMBAR TANDA TANGAN -->
  <div class="print-footer">
    <div class="footer-notes">
      <strong>Catatan & Pernyataan:</strong><br>
      • Laporan ini merupakan rekapan pembukuan resmi dari sistem billing.<br>
      • Data piutang dan penerimaan kas telah disinkronkan secara otomatis.<br>
      • Dicetak oleh: <em>${req.session.adminUser || req.session.cashierName || 'Admin'}</em>
    </div>
    <div class="ttd-wrap">
      <div class="ttd-title">
        Mengetahui / Penanggung Jawab,<br>
        <strong>Bagian Keuangan & Admin</strong>
      </div>
      <div class="ttd-name">${compName}</div>
    </div>
  </div>

</body>
</html>
    `;

    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (err) {
    logger.error('[Print PDF Error]:', err.message);
    res.status(500).send('Gagal memuat halaman print laporan: ' + err.message);
  }
});

// ─── EXPORT EXCEL RESMI (.XLSX MULTI-SHEET) ─────────────────────────────────
router.get('/reports/export-csv', requireAdminSession, requireSidebarMenuAccess('reports'), (req, res) => {
  try {
    const now = new Date();
    const filterYear = parseInt(req.query.year) || now.getFullYear();
    const filterMonth = parseInt(req.query.month) || (now.getMonth() + 1);
    let filterSite = String(req.query.site || '').trim();

    if (req.session?.isStaff && req.session?.staffSite && req.session.staffSite !== 'all') {
      filterSite = req.session.staffSite;
    }

    const numYear = Number(filterYear);
    const numMonth = Number(filterMonth);
    const strYear = String(filterYear);
    const strMonth = String(filterMonth).padStart(2, '0');

    // Sheet 1: Invoices
    let invoices = [];
    if (filterSite) {
      invoices = db.prepare(`
        SELECT i.id, c.name as customer_name, c.phone as customer_phone, p.name as package_name,
               i.amount, i.status, i.paid_at, i.paid_by_name, i.notes
        FROM invoices i
        JOIN customers c ON i.customer_id = c.id
        LEFT JOIN packages p ON c.package_id = p.id
        WHERE (i.period_year = ? OR i.period_year = ?)
          AND (i.period_month = ? OR i.period_month = ?)
          AND c.site = ?
        ORDER BY i.status ASC, c.name ASC
      `).all(numYear, strYear, numMonth, strMonth, filterSite);
    } else {
      invoices = db.prepare(`
        SELECT i.id, c.name as customer_name, c.phone as customer_phone, p.name as package_name,
               i.amount, i.status, i.paid_at, i.paid_by_name, i.notes
        FROM invoices i
        JOIN customers c ON i.customer_id = c.id
        LEFT JOIN packages p ON c.package_id = p.id
        WHERE (i.period_year = ? OR i.period_year = ?)
          AND (i.period_month = ? OR i.period_month = ?)
        ORDER BY i.status ASC, c.name ASC
      `).all(numYear, strYear, numMonth, strMonth);
    }

    const invoiceRows = invoices.map((inv, idx) => ({
      'No': idx + 1,
      'ID Invoice': inv.id,
      'Nama Pelanggan': inv.customer_name || '',
      'No Telepon': inv.customer_phone || '',
      'Paket': inv.package_name || '',
      'Nominal Tagihan': Number(inv.amount || 0),
      'Status': inv.status === 'paid' ? 'LUNAS' : 'BELUM BAYAR',
      'Tanggal Bayar': inv.paid_at || '-',
      'Diterima Oleh': inv.paid_by_name || '-',
      'Catatan': inv.notes || ''
    }));

    // Sheet 2: Pengeluaran
    const expenses = db.prepare(`
      SELECT date, category, amount, description 
      FROM expenses 
      WHERE date LIKE ? 
      ORDER BY date ASC
    `).all(`${strYear}-${strMonth}%`);

    const expenseRows = expenses.map((exp, idx) => ({
      'No': idx + 1,
      'Tanggal': exp.date || '',
      'Kategori': exp.category || '',
      'Nominal': Number(exp.amount || 0),
      'Keterangan': exp.description || ''
    }));

    // Sheet 3: Kas Masuk Tambahan
    const cashInList = db.prepare(`
      SELECT date, category, amount, description 
      FROM cash_in 
      WHERE date LIKE ? 
      ORDER BY date ASC
    `).all(`${strYear}-${strMonth}%`);

    const cashInRows = cashInList.map((c, idx) => ({
      'No': idx + 1,
      'Tanggal': c.date || '',
      'Sumber / Kategori': c.category || '',
      'Nominal': Number(c.amount || 0),
      'Keterangan': c.description || ''
    }));

    // Buat Workbook Excel Asli (.xlsx)
    const wb = XLSX.utils.book_new();

    const wsInvoices = XLSX.utils.json_to_sheet(invoiceRows);
    XLSX.utils.book_append_sheet(wb, wsInvoices, 'Tagihan Pelanggan');

    const wsExpenses = XLSX.utils.json_to_sheet(expenseRows);
    XLSX.utils.book_append_sheet(wb, wsExpenses, 'Pengeluaran Kas');

    if (cashInRows.length > 0) {
      const wsCashIn = XLSX.utils.json_to_sheet(cashInRows);
      XLSX.utils.book_append_sheet(wb, wsCashIn, 'Kas Masuk Tambahan');
    }

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const fileName = `Laporan_Keuangan_${filterYear}_${strMonth}.xlsx`;

    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    return res.send(buf);

  } catch (err) {
    logger.error('[Export Excel Error]:', err.message);
    res.status(500).send('Gagal export file Excel: ' + err.message);
  }
});

// ─── SETTINGS ──────────────────────────────────────────────────────────────
router.get('/sidebar-settings', requireAdminSession, (req, res) => {
  const selectedRole = String(req.query.role || 'staff').trim(); // Default ke tab Staff/Mitra
  res.render('admin/sidebar_settings', {
    title: 'Pengaturan Sidebar',
    company: company(),
    activePage: 'sidebar_settings',
    msg: flashMsg(req),
    canManageSidebar: Boolean(req.session?.isAdmin),
    selectedRole,
    menuConfigs: sidebarMenuSvc.getConfigMenus(selectedRole),
    featureContactPhone: sidebarMenuSvc.getFeatureContactPhone()
  });
});

router.post('/sidebar-settings', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), (req, res) => {
  try {
    const featurePassword = String(req.body.feature_password || '').trim();
    if (!sidebarMenuSvc.isFeaturePasswordValid(featurePassword)) {
      throw new Error(`Password aktivasi salah. Hubungi ${sidebarMenuSvc.getFeatureContactPhone()} untuk mendapatkan password yang benar.`);
    }

    const targetRole = String(req.body.target_role || 'staff').trim();
    const menuStates = sidebarMenuSvc.sanitizeMenuStates(req.body.menu_state || {});
    const success = sidebarMenuSvc.saveMenuStates(menuStates, targetRole);
    if (!success) throw new Error('Gagal menyimpan pengaturan sidebar');

    if (auditSvc && typeof auditSvc.logAuditTrail === 'function') {
      auditSvc.logAuditTrail({
        action: 'UPDATE',
        entity_type: 'sidebar_settings',
        entity_id: 'global',
        actor_type: req.session?.isAdmin ? 'admin' : 'cashier',
        actor_id: String(req.session?.adminUser || req.session?.cashierUsername || ''),
        actor_name: req.session?.adminUser || req.session?.cashierName || 'Admin',
        details: { menuStates, password_verified: true },
        ip_address: req.ip,
        user_agent: req.get('user-agent')
      });
    }

    req.session._msg = { type: 'success', text: `Pengaturan sidebar untuk role [${targetRole.toUpperCase()}] berhasil disimpan.` };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal menyimpan pengaturan sidebar: ' + e.message };
  }
  res.redirect('/admin/sidebar-settings?role=' + (req.body.target_role || 'staff'));
});

router.get('/settings', requireAdminSession, requireSidebarMenuAccess('settings'), (req, res) => {
  const settings = getSettings();
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.get('host');
  const baseUrl = (settings && settings.app_url ? String(settings.app_url) : `${protocol}://${host}`).replace(/\/+$/, '');
  const digiflazzWebhookUrl = `${baseUrl}/webhook/digiflazz`;
  const paymentWebhookUrl = `${baseUrl}/customer/payment/callback`;
  res.render('admin/settings', {
    title: 'Pengaturan Sistem', company: company(), activePage: 'settings',
    settings, msg: flashMsg(req),
    digiflazzWebhookUrl,
    paymentWebhookUrl
  });
});

router.get('/ewallet-logs', requireAdminSession, requireSidebarMenuAccess('settings'), (req, res) => {
  const settings = getSettings();
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.get('host');
  const baseUrl = (settings && settings.app_url ? String(settings.app_url) : `${protocol}://${host}`).replace(/\/+$/, '');
  const digiflazzWebhookUrl = `${baseUrl}/webhook/digiflazz`;
  const paymentWebhookUrl = `${baseUrl}/customer/payment/callback`;
  res.render('admin/settings', {
    title: 'Log Notifikasi E-Wallet (Webhook)', company: company(), activePage: 'ewallet_logs',
    settings, msg: flashMsg(req),
    digiflazzWebhookUrl,
    paymentWebhookUrl,
    viewMode: 'ewallet_logs'
  });
});

router.post('/settings/qris-upload', requireAdminSession, qrisUpload.single('qris_file'), async (req, res) => {
  try {
    const f = req.file;
    if (!f || !f.buffer || !f.originalname) throw new Error('File QRIS tidak ditemukan');

    const ext = String(path.extname(f.originalname || '') || '').toLowerCase();
    const allowedExt = new Set(['.png', '.jpg', '.jpeg', '.webp']);
    const allowedMime = new Set(['image/png', 'image/jpeg', 'image/webp']);
    if (!allowedExt.has(ext) || !allowedMime.has(String(f.mimetype || '').toLowerCase())) {
      throw new Error('Format file tidak didukung. Gunakan PNG/JPG/WebP');
    }

    const dir = path.join(__dirname, '../public/uploads/qris');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const name = `qris-${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`;
    const fullPath = path.join(dir, name);
    fs.writeFileSync(fullPath, f.buffer);

    const url = `/uploads/qris/${name}`;
    let payload = '';
    const payloadFromClient = String(req.body?.qris_payload || '').trim();
    try {
      if (payloadFromClient) {
        payload = payloadFromClient.replace(/[\r\n\t]+/g, '').trim();
      } else {
        payload = await extractQrTextFromImageBuffer(f.buffer);
      }
      if (!payload.startsWith('000201')) payload = '';
    } catch (e) {
      payload = '';
    }

    const ok = saveSettings({ qris_static_qr_url: url, qris_static_enabled: true, ...(payload ? { qris_static_payload: payload } : {}) });
    if (!ok) throw new Error('Gagal menyimpan pengaturan QRIS');

    if (payload) {
      req.session._msg = { type: 'success', text: 'QRIS berhasil di-upload. Payload QRIS berhasil terbaca otomatis.' };
    } else {
      req.session._msg = { type: 'success', text: 'QRIS berhasil di-upload, tetapi payload QRIS tidak terbaca otomatis. Silakan isi QRIS Static Payload (String) secara manual.' };
    }
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal upload QRIS: ' + (e?.message || e) };
  }
  res.redirect('/admin/settings');
});

router.post('/settings/logo-upload', requireAdminSession, qrisUpload.single('logo_file'), async (req, res) => {
  try {
    const f = req.file;
    if (!f || !f.buffer || !f.originalname) throw new Error('File logo tidak ditemukan');

    const ext = String(path.extname(f.originalname || '') || '').toLowerCase();
    const allowedExt = new Set(['.png', '.jpg', '.jpeg', '.webp']);
    const allowedMime = new Set(['image/png', 'image/jpeg', 'image/webp']);
    if (!allowedExt.has(ext) || !allowedMime.has(String(f.mimetype || '').toLowerCase())) {
      throw new Error('Format file tidak didukung. Gunakan PNG/JPG/WebP');
    }

    const dir = path.join(__dirname, '../public/img');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const fullPath = path.join(dir, 'logo.png');
    fs.writeFileSync(fullPath, f.buffer);

    req.session._msg = { type: 'success', text: 'Logo aplikasi berhasil diperbarui!' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal upload logo: ' + (e?.message || e) };
  }
  res.redirect('/admin/settings');
});

router.get('/digiflazz', requireAdminSession, requireSidebarMenuAccess('digiflazz'), restrictToAdmin, async (req, res) => {
  const settings = getSettings();
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.get('host');
  const baseUrl = (settings && settings.app_url ? String(settings.app_url) : `${protocol}://${host}`).replace(/\/+$/, '');
  const digiflazzWebhookUrl = `${baseUrl}/webhook/digiflazz`;
  let digi = { configured: digiflazzConfigured(), deposit: null, error: null };
  if (digi.configured) {
    try {
      const data = await digiflazzCekSaldo();
      digi.deposit = Number(data?.deposit || 0);
    } catch (e) {
      digi.error = String(e?.message || e || '');
    }
  }

  const q = String(req.query.q || '').trim();
  const category = String(req.query.category || '').trim();
  const status = String(req.query.status || '').trim();

  const where = [];
  const params = [];
  if (q) {
    where.push('(sku LIKE ? OR product_name LIKE ? OR brand LIKE ? OR category LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }
  if (category) {
    where.push('category = ?');
    params.push(category);
  }
  if (status === 'active') where.push('status = 1');
  if (status === 'inactive') where.push('status = 0');

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const products = db.prepare(`SELECT * FROM digiflazz_products ${whereSql} ORDER BY category, brand, price_sell LIMIT 300`).all(...params);
  const categories = db.prepare("SELECT category FROM digiflazz_products WHERE category IS NOT NULL AND TRIM(category)<>'' GROUP BY category ORDER BY category").all().map(r => r.category);
  const stats = db.prepare('SELECT COUNT(1) AS total, SUM(CASE WHEN status=1 THEN 1 ELSE 0 END) AS active, SUM(CASE WHEN status=0 THEN 1 ELSE 0 END) AS inactive FROM digiflazz_products').get();
  const lastSync = db.prepare('SELECT * FROM digiflazz_sync_logs ORDER BY id DESC LIMIT 1').get();
  const webhookLogs = db.prepare(
    `
    SELECT id, created_at, ref_id, status, signature_ok, matched_agent_tx_id, ip
    FROM digiflazz_webhook_logs
    ORDER BY id DESC
    LIMIT 80
  `
  ).all();

  const recentPulsaTx = db.prepare(
    `
    SELECT t.*, a.name AS agent_name, a.username AS agent_username
    FROM agent_transactions t
    JOIN agents a ON a.id = t.agent_id
    WHERE t.type = 'pulsa'
    ORDER BY t.id DESC
    LIMIT 60
  `
  ).all();

  res.render('admin/digiflazz', {
    title: 'Digiflazz',
    company: company(),
    activePage: 'digiflazz',
    msg: flashMsg(req),
    settings,
    digi,
    digiflazzWebhookUrl,
    q,
    category,
    status,
    products,
    categories,
    stats,
    lastSync,
    recentPulsaTx,
    webhookLogs
  });
});

router.post('/digiflazz/check-balance', requireAdminSession, restrictToAdmin, async (req, res) => {
  try {
    const data = await digiflazzCekSaldo();
    const depo = Number(data?.deposit || 0);
    req.session._msg = { type: 'success', text: `Saldo Digiflazz: Rp ${depo.toLocaleString('id-ID')}` };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal cek saldo Digiflazz: ' + (e?.message || e) };
  }
  res.redirect('/admin/digiflazz');
});

router.post('/digiflazz/sync-products', requireAdminSession, restrictToAdmin, async (req, res) => {
  try {
    const markup = Math.max(0, Math.floor(Number(getSetting('digiflazz_markup', 0) || 0)));
    const list = await digiflazzPriceListAll();

    const selectOne = db.prepare('SELECT sku, product_name, category, brand, price_modal, price_sell, status FROM digiflazz_products WHERE sku = ?');
    const upsert = db.prepare(
      `
      INSERT INTO digiflazz_products (sku, product_name, category, brand, price_modal, price_sell, status, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, (NOW_LOCAL()))
      ON CONFLICT(sku) DO UPDATE SET
        product_name=excluded.product_name,
        category=excluded.category,
        brand=excluded.brand,
        price_modal=excluded.price_modal,
        price_sell=excluded.price_sell,
        status=excluded.status,
        updated_at=(NOW_LOCAL())
    `
    );

    const run = db.transaction(() => {
      const summary = { total: 0, inserted: 0, updated: 0, active: 0, inactive: 0, skippedNoPrice: 0 };
      for (const p of list) {
        summary.total++;
        const sku = String(p?.buyer_sku_code || '').trim();
        if (!sku) continue;

        const priceModal = Number(p?.price ?? p?.buyer_price ?? 0) || 0;
        if (priceModal <= 0) {
          summary.skippedNoPrice++;
          continue;
        }

        const status = p?.buyer_product_status ? 1 : 0;
        if (status === 1) summary.active++;
        else summary.inactive++;

        const existing = selectOne.get(sku);
        const name = String(p?.product_name || sku).trim();
        const cat = String(p?.category || '').trim();
        const brand = String(p?.brand || '').trim();
        const priceSell = Math.floor(priceModal + markup);

        if (!existing) summary.inserted++;
        else {
          const changed =
            String(existing.product_name || '') !== name ||
            String(existing.category || '') !== cat ||
            String(existing.brand || '') !== brand ||
            Number(existing.price_modal || 0) !== Math.floor(priceModal) ||
            Number(existing.price_sell || 0) !== priceSell ||
            Number(existing.status || 0) !== status;
          if (changed) summary.updated++;
        }

        upsert.run(sku, name, cat, brand, Math.floor(priceModal), priceSell, status);
      }

      db.prepare(
        'INSERT INTO digiflazz_sync_logs (total, inserted, updated, active, inactive) VALUES (?, ?, ?, ?, ?)'
      ).run(summary.total, summary.inserted, summary.updated, summary.active, summary.inactive);

      return summary;
    });

    const s = run();
    req.session._msg = { type: 'success', text: `Sync Digiflazz OK | Total: ${s.total} | Baru: ${s.inserted} | Update: ${s.updated} | Aktif: ${s.active} | Nonaktif: ${s.inactive} | SkipNoPrice: ${s.skippedNoPrice}` };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal sync produk Digiflazz: ' + (e?.message || e) };
  }
  res.redirect('/admin/digiflazz');
});

router.post('/digiflazz/products/update-price', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), (req, res) => {
  try {
    const sku = String(req.body.sku || '').trim();
    const priceSell = Math.max(0, Math.floor(Number(req.body.price_sell || 0) || 0));
    if (!sku) throw new Error('SKU wajib');
    const info = db.prepare('UPDATE digiflazz_products SET price_sell=?, updated_at=(NOW_LOCAL()) WHERE sku=?').run(priceSell, sku);
    if (info.changes === 0) throw new Error('SKU tidak ditemukan');
    req.session._msg = { type: 'success', text: `Harga jual diperbarui: ${sku}` };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal update harga: ' + (e?.message || e) };
  }
  res.redirect('/admin/digiflazz');
});

router.get('/update', requireAdminSession, requireSidebarMenuAccess('update'), restrictToAdmin, (req, res) => {
  const repoRoot = path.resolve(__dirname, '..');
  const info = getUpdateInfo(repoRoot);
  res.render('admin/update', {
    title: 'Update Aplikasi',
    company: company(),
    activePage: 'update',
    msg: flashMsg(req),
    info,
    log: popUpdateLog(req)
  });
});

router.post('/update/run', requireAdminSession, restrictToAdmin, (req, res) => {
  const repoRoot = path.resolve(__dirname, '..');
  const log = [];
  const pushCmd = (label, r) => {
    log.push(`$ ${label}`.trim());
    if (r.stdout) log.push(String(r.stdout).trimEnd());
    if (r.stderr) log.push(String(r.stderr).trimEnd());
  };

  const versionPath = path.join(repoRoot, 'version.txt');
  const localBefore = readTextFileSafe(versionPath) || '-';
  const branch = getGitDefaultBranch(repoRoot);
  const backupRoot = path.join(os.tmpdir(), `billing-update-backup-${Date.now()}`);
  const authFolder = String(getSetting('whatsapp_auth_folder', 'auth_info_baileys') || 'auth_info_baileys').trim() || 'auth_info_baileys';
  const preservedEntries = [
    { label: 'settings.json', relativePath: 'settings.json', cleanExclude: 'settings.json' },
    { label: '.env', relativePath: '.env', cleanExclude: '.env' },
    { label: 'database', relativePath: 'database', cleanExclude: 'database' },
    { label: 'public/uploads', relativePath: 'public/uploads', cleanExclude: 'public/uploads' },
    { label: 'public/img', relativePath: 'public/img', cleanExclude: 'public/img' },
    { label: authFolder, relativePath: authFolder, cleanExclude: authFolder.replace(/\\/g, '/') },
    { label: 'data', relativePath: 'data', cleanExclude: 'data' }
  ];
  let repoChanged = false;

  const backupPreservedEntries = () => {
    const backedUp = [];
    for (const entry of preservedEntries) {
      const sourcePath = path.resolve(repoRoot, entry.relativePath);
      const backupPath = path.resolve(backupRoot, entry.relativePath);
      if (!fs.existsSync(sourcePath)) continue;
      const stat = fs.statSync(sourcePath);
      if (stat.isDirectory()) {
        fs.mkdirSync(backupPath, { recursive: true });
        copyDirSync(sourcePath, backupPath);
      } else {
        fs.mkdirSync(path.dirname(backupPath), { recursive: true });
        fs.copyFileSync(sourcePath, backupPath);
      }
      backedUp.push(entry.label);
    }
    if (backedUp.length > 0) {
      log.push(`$ backup preserved files: ${backedUp.join(', ')}`);
    }
  };

  const restorePreservedFiles = (stageLabel) => {
    const restored = [];
    for (const entry of preservedEntries) {
      const targetPath = path.resolve(repoRoot, entry.relativePath);
      const backupPath = path.resolve(backupRoot, entry.relativePath);
      if (!fs.existsSync(backupPath)) continue;
      const stat = fs.statSync(backupPath);
      if (stat.isDirectory()) {
        fs.rmSync(targetPath, { recursive: true, force: true });
        fs.mkdirSync(targetPath, { recursive: true });
        copyDirSync(backupPath, targetPath);
      } else {
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.copyFileSync(backupPath, targetPath);
      }
      restored.push(entry.label);
    }
    if (restored.length > 0) {
      log.push(`$ restore preserved files (${stageLabel}): ${restored.join(', ')}`);
    }
  };

  try {
    const inside = runCmd('git', ['rev-parse', '--is-inside-work-tree'], repoRoot);
    pushCmd('git rev-parse --is-inside-work-tree', inside);
    if (!inside.ok) throw new Error('Folder ini belum menjadi git repository.');

    const fetch = runCmd('git', ['fetch', '--prune'], repoRoot);
    pushCmd('git fetch --prune', fetch);
    if (!fetch.ok) throw new Error('Gagal git fetch.');

    const remote = runCmd('git', ['show', `origin/${branch}:version.txt`], repoRoot);
    pushCmd(`git show origin/${branch}:version.txt`, remote);
    if (!remote.ok) throw new Error('Tidak bisa membaca version.txt dari GitHub.');
    const remoteVersion = String(remote.stdout || '').trim() || '-';

    if (remoteVersion !== '-' && remoteVersion === localBefore) {
      req.session._msg = { type: 'success', text: 'Versi sudah terbaru: ' + localBefore };
      req.session._updateLog = log.join('\n');
      return res.redirect('/admin/update');
    }

    fs.mkdirSync(backupRoot, { recursive: true });
    backupPreservedEntries();

    const resetSettings = runCmd('git', ['checkout', '--', 'settings.json'], repoRoot);
    pushCmd('git checkout -- settings.json', resetSettings);
    const resetDb = runCmd('git', ['checkout', '--', 'database'], repoRoot);
    pushCmd('git checkout -- database', resetDb);

    const resetHard = runCmd('git', ['reset', '--hard', `origin/${branch}`], repoRoot);
    pushCmd(`git reset --hard origin/${branch}`, resetHard);
    if (!resetHard.ok) throw new Error('Gagal reset ke origin/' + branch);
    repoChanged = true;

    if (remoteVersion && remoteVersion !== '-') {
      try {
        fs.writeFileSync(versionPath, remoteVersion + os.EOL, 'utf8');
        log.push(`$ write version.txt = ${remoteVersion}`);
      } catch (e) {
        log.push(`$ write version.txt failed: ${String(e?.message || e)}`);
      }
    }

    const cleanExcludes = ['node_modules', 'package-lock.json', ...preservedEntries.map((entry) => entry.cleanExclude)];
    const cleanArgs = ['clean', '-fd'];
    for (const exclude of cleanExcludes) {
      cleanArgs.push('-e', exclude);
    }
    const clean = runCmd(
      'git',
      cleanArgs,
      repoRoot
    );
    pushCmd(`git ${cleanArgs.join(' ')}`, clean);

    restorePreservedFiles('post-update');

    // Cek apakah package.json berubah sebelum install
    const pkgDiff = runCmd('git', ['diff', 'HEAD@{1}', 'HEAD', '--', 'package.json'], repoRoot);
    const pkgChanged = pkgDiff.ok && String(pkgDiff.stdout || '').trim().length > 0;

    if (pkgChanged) {
      log.push('$ package.json berubah, menjalankan npm install (Low-CPU Mode)...');
      const npm = runCmd('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--prefer-offline'], repoRoot);
      pushCmd('npm install --omit=dev --no-audit --no-fund --prefer-offline', npm);
      if (!npm.ok) throw new Error('Update berhasil, tetapi npm install gagal.');
    } else {
      log.push('$ package.json tidak berubah, npm install dilewati (Hemat CPU & Waktu!).');
    }

    const localAfter = readTextFileSafe(versionPath) || '-';
    req.session._msg = { type: 'success', text: `Update selesai. Versi: ${localBefore} → ${localAfter}. Silakan restart aplikasi.` };
    req.session._updateLog = log.join('\n');
  } catch (e) {
    if (repoChanged) {
      try {
        restorePreservedFiles('error-recovery');
      } catch (restoreErr) {
        log.push(`$ restore preserved files failed: ${String(restoreErr?.message || restoreErr)}`);
      }
    }
    req.session._msg = { type: 'error', text: 'Gagal update: ' + (e?.message || e) };
    req.session._updateLog = log.join('\n');
  } finally {
    try {
      if (fs.existsSync(backupRoot)) fs.rmSync(backupRoot, { recursive: true, force: true });
    } catch (e) {}
  }

  return res.redirect('/admin/update');
});

router.post('/api/telegram/sync', requireAdminSession, async (req, res) => {
  try {
    const { initTelegram } = require('../services/telegramBot');
    initTelegram();
    res.json({ success: true, message: 'Bot Telegram berhasil disinkronkan.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/settings', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    const newSettings = { ...req.body };
    if (newSettings.whatsapp_enabled === 'true') newSettings.whatsapp_enabled = true;
    else if (newSettings.whatsapp_enabled === 'false') newSettings.whatsapp_enabled = false;

    if (newSettings.qris_static_enabled === 'true') newSettings.qris_static_enabled = true;
    else if (newSettings.qris_static_enabled === 'false') newSettings.qris_static_enabled = false;
    
    if (newSettings.tripay_enabled === 'true') newSettings.tripay_enabled = true;
    else if (newSettings.tripay_enabled === 'false') newSettings.tripay_enabled = false;
    
    if (newSettings.midtrans_enabled === 'true') newSettings.midtrans_enabled = true;
    else if (newSettings.midtrans_enabled === 'false') newSettings.midtrans_enabled = false;

    if (newSettings.xendit_enabled === 'true') newSettings.xendit_enabled = true;
    else if (newSettings.xendit_enabled === 'false') newSettings.xendit_enabled = false;

    if (newSettings.duitku_enabled === 'true') newSettings.duitku_enabled = true;
    else if (newSettings.duitku_enabled === 'false') newSettings.duitku_enabled = false;

    if (newSettings.default_gateway) newSettings.default_gateway = newSettings.default_gateway.toLowerCase();

    if (typeof newSettings.whatsapp_admin_numbers === 'string') {
      newSettings.whatsapp_admin_numbers = newSettings.whatsapp_admin_numbers.split(',').map(n => n.trim()).filter(Boolean);
    }
    // whatsapp_tech_numbers removed - now automatically fetched from technicians table
    if (newSettings.server_port) newSettings.server_port = parseInt(newSettings.server_port);
    if (newSettings.mikrotik_port) newSettings.mikrotik_port = parseInt(newSettings.mikrotik_port);
    if (newSettings.whatsapp_broadcast_delay) newSettings.whatsapp_broadcast_delay = parseInt(newSettings.whatsapp_broadcast_delay);
    if (newSettings.digiflazz_markup !== undefined) newSettings.digiflazz_markup = parseInt(newSettings.digiflazz_markup) || 0;
    
    newSettings.login_otp_enabled = (newSettings.login_otp_enabled === 'true');
    newSettings.telegram_enabled = (newSettings.telegram_enabled === 'true');
    newSettings.telegram_group_ai_enabled = (newSettings.telegram_group_ai_enabled === 'true');
    newSettings.telegram_welcome_enabled = (newSettings.telegram_welcome_enabled === 'true');
    if (newSettings.whatsapp_ai_enabled === 'admin_only') {
      newSettings.whatsapp_ai_enabled = 'admin_only';
    } else if (newSettings.whatsapp_ai_enabled === 'true' || newSettings.whatsapp_ai_enabled === true) {
      newSettings.whatsapp_ai_enabled = true;
    } else {
      newSettings.whatsapp_ai_enabled = false;
    }
    newSettings.auto_backup_enabled = (newSettings.auto_backup_enabled === 'true');
    newSettings.use_builtin_acs = (newSettings.use_builtin_acs === 'true' || newSettings.use_builtin_acs === true);
	newSettings.portal_banner_enabled = (newSettings.portal_banner_enabled === 'true' || newSettings.portal_banner_enabled === true);

    // AI Provider & API Settings
    if (newSettings.ai_provider) newSettings.ai_provider = String(newSettings.ai_provider).trim().toLowerCase();
    if (newSettings.gemini_api_key) newSettings.gemini_api_key = String(newSettings.gemini_api_key).trim();
    if (newSettings.openai_api_key) newSettings.openai_api_key = String(newSettings.openai_api_key).trim();
    if (newSettings.openai_model) newSettings.openai_model = String(newSettings.openai_model).trim();
    if (newSettings.deepseek_api_key) newSettings.deepseek_api_key = String(newSettings.deepseek_api_key).trim();
    if (newSettings.deepseek_model) newSettings.deepseek_model = String(newSettings.deepseek_model).trim();
    if (newSettings.groq_api_key) newSettings.groq_api_key = String(newSettings.groq_api_key).trim();
    if (newSettings.groq_model) newSettings.groq_model = String(newSettings.groq_model).trim();
    if (newSettings.openrouter_api_key) newSettings.openrouter_api_key = String(newSettings.openrouter_api_key).trim();
    if (newSettings.openrouter_model) newSettings.openrouter_model = String(newSettings.openrouter_model).trim();
    if (newSettings.custom_ai_api_key) newSettings.custom_ai_api_key = String(newSettings.custom_ai_api_key).trim();
    if (newSettings.custom_ai_base_url) newSettings.custom_ai_base_url = String(newSettings.custom_ai_base_url).trim();
    if (newSettings.custom_ai_model) newSettings.custom_ai_model = String(newSettings.custom_ai_model).trim();

    // Multi-Router Mode settings
    if (!newSettings.multi_router_mode) newSettings.multi_router_mode = 'disabled';
    if (newSettings.default_router_id) newSettings.default_router_id = parseInt(newSettings.default_router_id) || null;

    // ✅ NEW: Jika switching dari disabled ke active, auto-assign default router ke pelanggan NULL
    const oldMode = getSetting('multi_router_mode', 'disabled');
    if (oldMode === 'disabled' && newSettings.multi_router_mode === 'active') {
      const defaultRouterId = newSettings.default_router_id;
      if (defaultRouterId && defaultRouterId > 0) {
        // Auto-assign default router to customers with NULL router_id
        const result = db.prepare(
          "UPDATE customers SET router_id = ? WHERE router_id IS NULL AND (pppoe_username != '' OR hotspot_username != '' OR static_ip != '')"
        ).run(defaultRouterId);
        logger.info(`[Settings] Auto-assigned router ${defaultRouterId} to ${result.changes} customers with NULL router_id`);
      } else {
        // Jika tidak ada default router, cari router pertama yang aktif
        const router = db.prepare('SELECT id FROM routers WHERE is_active = 1 ORDER BY id ASC LIMIT 1').get();
        if (router) {
          const result = db.prepare(
            "UPDATE customers SET router_id = ? WHERE router_id IS NULL AND (pppoe_username != '' OR hotspot_username != '' OR static_ip != '')"
          ).run(router.id);
          logger.info(`[Settings] Auto-assigned router ${router.id} to ${result.changes} customers with NULL router_id`);
        }
      }
    }

    const success = saveSettings(newSettings);
    if (success) {
      // Re-init services if needed
      if (newSettings.telegram_enabled) {
        require('../services/telegramBot').initTelegram();
      } else {
        require('../services/telegramBot').initTelegram(); // This will stop it if it was running
      }
      req.session._msg = { type: 'success', text: 'Pengaturan berhasil disimpan.' };
    } else {
      req.session._msg = { type: 'error', text: 'Gagal menyimpan pengaturan' };
    }
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/settings');
});

// ─── BACKUP & RECOVERY ──────────────────────────────────────────────────────
router.get('/backup', requireAdminSession, requireSidebarMenuAccess('backup'), (req, res) => {
  const result = backupSvc.listBackups();
  res.render('admin/backup', {
    title: 'Backup & Recovery',
    company: company(),
    activePage: 'backup',
    msg: flashMsg(req),
    backups: result.backups || [],
    total: result.total || 0,
    getSetting
  });
});

router.get('/backup/download/:fileName', requireAdminSession, (req, res) => {
  try {
    const rawFileName = req.params.fileName;
    const fileName = path.basename(rawFileName);
    const backupDir = path.join(__dirname, '../backups');
    const filePath = path.join(backupDir, fileName);

    if (!fs.existsSync(filePath)) {
      req.session._msg = { type: 'error', text: 'File backup tidak ditemukan.' };
      return res.redirect('/admin/backup');
    }

    res.download(filePath, fileName, (err) => {
      if (err && !res.headersSent) {
        logger.error(`[Backup] Error downloading file ${fileName}:`, err);
        req.session._msg = { type: 'error', text: 'Gagal mendownload file backup.' };
        res.redirect('/admin/backup');
      }
    });
  } catch (e) {
    logger.error('[Backup] Download error:', e);
    req.session._msg = { type: 'error', text: 'Gagal mendownload backup: ' + e.message };
    res.redirect('/admin/backup');
  }
});

router.post('/backup/create', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    const { type } = req.body;
    let result;

    if (type === 'all') {
      result = backupSvc.backupAll();
    } else if (type === 'database') {
      result = backupSvc.backupDatabase();
    } else if (type === 'settings') {
      result = backupSvc.backupSettings();
    } else {
      req.session._msg = { type: 'error', text: 'Tipe backup tidak valid' };
      return res.redirect('/admin/backup');
    }

    if (result.success) {
      req.session._msg = { type: 'success', text: `Backup berhasil dibuat: ${result.fileName}` };
    } else {
      req.session._msg = { type: 'error', text: `Gagal backup: ${result.error}` };
    }
  } catch (e) {
    req.session._msg = { type: 'error', text: `Gagal: ${e.message}` };
  }
  res.redirect('/admin/backup');
});

router.post('/backup/restore', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    const { fileName, type } = req.body;
    let result;

    if (type === 'database') {
      result = backupSvc.restoreDatabase(fileName);
    } else if (type === 'settings') {
      result = backupSvc.restoreSettings(fileName);
    } else {
      req.session._msg = { type: 'error', text: 'Tipe restore tidak valid' };
      return res.redirect('/admin/backup');
    }

    if (result.success) {
      req.session._msg = { type: 'success', text: `Restore berhasil: ${fileName}` };
    } else {
      req.session._msg = { type: 'error', text: `Gagal restore: ${result.error}` };
    }
  } catch (e) {
    req.session._msg = { type: 'error', text: `Gagal: ${e.message}` };
  }
  res.redirect('/admin/backup');
});

router.post('/backup/upload-restore', requireAdminSession, upload.single('backupFile'), (req, res) => {
  try {
    const file = req.file;
    if (!file || !file.buffer || !file.originalname) {
      throw new Error('File backup tidak ditemukan.');
    }

    const originalName = path.basename(file.originalname);
    const ext = path.extname(originalName).toLowerCase();
    const timestamp = Date.now();
    const backupDir = path.join(__dirname, '../backups');

    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }

    let result;
    let savedFileName = '';

    if (ext === '.db' || ext === '.sqlite' || originalName.includes('billing_db')) {
      savedFileName = `uploaded_db_${timestamp}_${originalName}`;
      const savePath = path.join(backupDir, savedFileName);
      fs.writeFileSync(savePath, file.buffer);
      result = backupSvc.restoreDatabase(savedFileName);
    } else if (ext === '.json' || originalName.includes('settings')) {
      savedFileName = `uploaded_settings_${timestamp}_${originalName}`;
      const savePath = path.join(backupDir, savedFileName);
      fs.writeFileSync(savePath, file.buffer);

      // Verify JSON validity before restoring settings
      try {
        JSON.parse(file.buffer.toString('utf8'));
      } catch (jsonErr) {
        fs.unlinkSync(savePath);
        throw new Error('Format JSON file settings tidak valid: ' + jsonErr.message);
      }

      result = backupSvc.restoreSettings(savedFileName);
    } else {
      throw new Error('Format file tidak didukung. Harap upload file .db (database) atau .json (settings).');
    }

    if (result && result.success) {
      req.session._msg = { 
        type: 'success', 
        text: `File backup "${originalName}" berhasil di-upload dan di-restore! Backup otomatis sebelum restore telah dibuat (${result.preRestoreBackup || '-'}).` 
      };
    } else {
      req.session._msg = { type: 'error', text: `Gagal restore: ${result ? result.error : 'Error tidak diketahui'}` };
    }
  } catch (e) {
    logger.error('[Backup] Upload & restore error:', e);
    req.session._msg = { type: 'error', text: 'Gagal upload & restore: ' + e.message };
  }
  res.redirect('/admin/backup');
});

router.post('/backup/delete', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    const { fileName } = req.body;
    const fs = require('fs');
    const path = require('path');
    const backupDir = path.join(__dirname, '../backups');
    const backupFilePath = path.join(backupDir, fileName);

    if (!fs.existsSync(backupFilePath)) {
      req.session._msg = { type: 'error', text: 'File backup tidak ditemukan' };
      return res.redirect('/admin/backup');
    }

    fs.unlinkSync(backupFilePath);
    logger.info(`[Backup] Backup deleted: ${fileName}`);
    req.session._msg = { type: 'success', text: `Backup berhasil dihapus: ${fileName}` };
  } catch (e) {
    req.session._msg = { type: 'error', text: `Gagal menghapus: ${e.message}` };
  }
  res.redirect('/admin/backup');
});

router.post('/backup/cleanup', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    const { retentionDays } = req.body;
    const result = backupSvc.cleanupOldBackups(parseInt(retentionDays) || 30);

    if (result.success) {
      req.session._msg = { type: 'success', text: `Cleanup selesai: ${result.deletedCount} backup lama dihapus` };
    } else {
      req.session._msg = { type: 'error', text: `Gagal cleanup: ${result.error}` };
    }
  } catch (e) {
    req.session._msg = { type: 'error', text: `Gagal: ${e.message}` };
  }
  res.redirect('/admin/backup');
});

// ─── INVENTORY / WAREHOUSE ──────────────────────────────────────────────────
router.get('/inventory', requireAdminSession, requireSidebarMenuAccess('inventory'), (req, res) => {
  const selectedCat = req.query.category_id ? Number(req.query.category_id) : null;
  const items = inventorySvc.getAllItems(req.query.q, selectedCat);
  const categories = inventorySvc.getAllCategories();
  const logs = inventorySvc.getInventoryLogs({
    limit: 150,
    search: req.query.log_q || '',
    type: req.query.log_type || null,
    itemId: req.query.log_item_id || null
  });
  const stats = inventorySvc.getInventoryStats();

  let customers = [];
  try {
    customers = db.prepare('SELECT id, name, pppoe_username as pppoe_user, phone FROM customers ORDER BY name ASC').all() || [];
  } catch (e) {
    customers = [];
  }

  let technicians = [];
  try {
    technicians = db.prepare('SELECT id, name, phone FROM technicians WHERE is_active = 1 ORDER BY name ASC').all() || [];
  } catch (e) {
    technicians = [];
  }

  res.render('admin/inventory', {
    title: 'Manajemen Inventaris & Stok Gudang',
    company: company(),
    activePage: 'inventory',
    msg: flashMsg(req),
    items,
    categories,
    logs,
    stats,
    customers,
    technicians,
    query: req.query
  });
});

// JSON API Detail Barang untuk Modal & Kartu Stok
router.get('/api/inventory/item/:id', requireAdminSession, (req, res) => {
  try {
    const detail = inventorySvc.getItemDetail(req.params.id);
    if (!detail) return res.status(404).json({ success: false, message: 'Barang tidak ditemukan' });
    res.json({ success: true, data: detail });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// JSON API List Serial Number Available untuk Dropdown Modal
router.get('/api/inventory/serials/:itemId', requireAdminSession, (req, res) => {
  try {
    const serials = inventorySvc.getAvailableSerialNumbers(req.params.itemId);
    res.json({ success: true, data: serials });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// Kategori: Tambah
router.post('/inventory/category/add', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    inventorySvc.createCategory(req.body);
    req.session._msg = { type: 'success', text: 'Kategori barang berhasil ditambahkan.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal menambah kategori: ' + e.message };
  }
  res.redirect('/admin/inventory?tab=categories');
});

// Kategori: Edit
router.post('/inventory/category/edit/:id', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    inventorySvc.updateCategory(req.params.id, req.body);
    req.session._msg = { type: 'success', text: 'Kategori barang berhasil diperbarui.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal memperbarui kategori: ' + e.message };
  }
  res.redirect('/admin/inventory?tab=categories');
});

// Kategori: Hapus
router.post('/inventory/category/delete/:id', requireAdminSession, (req, res) => {
  try {
    inventorySvc.deleteCategory(req.params.id);
    req.session._msg = { type: 'success', text: 'Kategori berhasil dihapus.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal menghapus kategori: ' + e.message };
  }
  res.redirect('/admin/inventory?tab=categories');
});

// Master Barang: Tambah
router.post('/inventory/item/add', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    inventorySvc.createItem(req.body);
    req.session._msg = { type: 'success', text: 'Data barang baru berhasil disimpan.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal menambah barang: ' + e.message };
  }
  res.redirect('/admin/inventory');
});

// Master Barang: Edit
router.post('/inventory/item/edit/:id', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    inventorySvc.updateItem(req.params.id, req.body);
    req.session._msg = { type: 'success', text: 'Data barang berhasil diperbarui.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal memperbarui barang: ' + e.message };
  }
  res.redirect('/admin/inventory');
});

// Master Barang: Hapus
router.post('/inventory/item/delete/:id', requireAdminSession, (req, res) => {
  try {
    inventorySvc.deleteItem(req.params.id);
    req.session._msg = { type: 'success', text: 'Data barang berhasil dihapus.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal menghapus barang: ' + e.message };
  }
  res.redirect('/admin/inventory');
});

// Transaksi: 1. Stok Masuk (IN)
router.post('/inventory/stock/add', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    const actor = req.session.adminUser || (req.session.user && req.session.user.name) || 'Admin';
    const result = inventorySvc.addStock(req.body, actor);
    req.session._msg = { 
      type: 'success', 
      text: `Stok berhasil ditambahkan! Sisa stok tersedia saat ini: ${result.remainingStock}` 
    };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal menambah stok: ' + e.message };
  }
  res.redirect('/admin/inventory');
});

// Transaksi: 2. Pengeluaran Barang (OUT / ISSUE)
router.post('/inventory/stock/out', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    const actor = req.session.adminUser || (req.session.user && req.session.user.name) || 'Admin';
    const result = inventorySvc.issueStock(req.body, actor);
    req.session._msg = { 
      type: 'success', 
      text: `Pengeluaran barang berhasil dicatat! (-${result.qtyDeducted}). Sisa stok di gudang: ${result.remainingStock}` 
    };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal mengeluarkan barang: ' + e.message };
  }
  res.redirect('/admin/inventory');
});

// Transaksi: 3. Penyesuaian Stok (STOCK OPNAME / ADJUST)
router.post('/inventory/stock/adjust', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    const actor = req.session.adminUser || (req.session.user && req.session.user.name) || 'Admin';
    const result = inventorySvc.adjustStock(req.body, actor);
    const diffSign = result.diff > 0 ? '+' : '';
    req.session._msg = { 
      type: 'success', 
      text: `Penyesuaian stok berhasil! Selisih: ${diffSign}${result.diff}. Sisa stok fisik sekarang: ${result.remainingStock}` 
    };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal penyesuaian stok: ' + e.message };
  }
  res.redirect('/admin/inventory');
});

// Transaksi: 4. Pengembalian Barang (RETURN / COPOTAN)
router.post('/inventory/stock/return', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    const actor = req.session.adminUser || (req.session.user && req.session.user.name) || 'Admin';
    const result = inventorySvc.returnStock(req.body, actor);
    req.session._msg = { 
      type: 'success', 
      text: `Pengembalian barang berhasil dicatat! Sisa stok tersedia di gudang: ${result.remainingStock}` 
    };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal mencatat pengembalian: ' + e.message };
  }
  res.redirect('/admin/inventory');
});

router.get('/audit-logs', requireAdminSession, requireSidebarMenuAccess('audit_logs'), restrictToAdmin, (req, res) => {
  const filters = {
    action: req.query.action || null,
    entity_type: req.query.entity_type || null,
    limit: 100
  };
  const logs = auditSvc.getAuditTrail(filters);
  const stats = auditSvc.getAuditStats();

  res.render('admin/audit_logs', {
    title: 'Audit Trail / Log Aktivitas',
    company: company(),
    activePage: 'audit_logs',
    logs,
    stats,
    filters
  });
});

// ─── MONITORING ──────────────────────────────────────────────────────────────
router.get('/monitoring', requireAdminSession, requireSidebarMenuAccess('monitoring'), restrictToAdmin, async (req, res) => {
  const healthStatus = monitoringSvc.getHealthStatus();
  const performanceSummary = monitoringSvc.getPerformanceSummary();
  const dependencies = await diagnosticsSvc.checkDependencies();
  const recentErrors = diagnosticsSvc.getRecentErrors(10);
  const settings = getSettings(); // Get current settings

  res.render('admin/monitoring', {
      title: 'Monitoring Sistem',
      company: company(),
      activePage: 'monitoring',
      healthStatus,
      performanceSummary,
      dependencies,
      recentErrors,
      settings // Pass settings to view
    });
});

router.get('/api/health', requireAdmin, (req, res) => {
  const healthStatus = monitoringSvc.getHealthStatus();
  res.json(healthStatus);
});

router.get('/api/metrics', requireAdmin, (req, res) => {
  const metrics = monitoringSvc.getAllMetrics();
  res.json(metrics);
});

router.get('/api/metrics/history', requireAdmin, (req, res) => {
  const limit = parseInt(req.query.limit) || 10;
  const history = monitoringSvc.getMetricsHistory(limit);
  res.json(history);
});

// ─── GENIEACS SETTINGS API ──────────────────────────────────────────────────
router.post('/api/genieacs/settings', requireAdmin, async (req, res) => {
  try {
    const { genieacs_timeout, genieacs_rxpower_threshold, genieacs_monitoring_interval, genieacs_monitoring_enabled } = req.body;
    
    // Validate input
    if (genieacs_timeout < 5000 || genieacs_timeout > 120000) {
      return res.json({ success: false, message: 'Timeout harus antara 5000-120000 ms' });
    }
    if (genieacs_rxpower_threshold < -40 || genieacs_rxpower_threshold > -15) {
      return res.json({ success: false, message: 'RX Power threshold harus antara -40 sampai -15 dBm' });
    }
    if (genieacs_monitoring_interval < 1 || genieacs_monitoring_interval > 24) {
      return res.json({ success: false, message: 'Monitoring interval harus antara 1-24 jam' });
    }

    // Update settings
    const currentSettings = getSettings();
    currentSettings.genieacs_timeout = parseInt(genieacs_timeout);
    currentSettings.genieacs_rxpower_threshold = parseFloat(genieacs_rxpower_threshold);
    currentSettings.genieacs_monitoring_interval = parseInt(genieacs_monitoring_interval);
    currentSettings.genieacs_monitoring_enabled = Boolean(genieacs_monitoring_enabled);

    // Save to file
    const fs = require('fs');
    const path = require('path');
    const settingsPath = path.join(__dirname, '../settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify(currentSettings, null, 2), 'utf8');

    // Log audit
    try {
      if (auditSvc && typeof auditSvc.logAuditTrail === 'function') {
        auditSvc.logAuditTrail({
          action: 'UPDATE',
          entity_type: 'genieacs_settings',
          entity_id: 'settings.json',
          actor_type: req.session.isAdmin ? 'admin' : 'cashier',
          actor_id: req.session.adminUser || req.session.cashierUsername || 'admin',
          actor_name: req.session.adminUser || req.session.cashierName || 'Admin',
          details: {
            timeout: genieacs_timeout,
            rxpower_threshold: genieacs_rxpower_threshold,
            monitoring_interval: genieacs_monitoring_interval,
            monitoring_enabled: genieacs_monitoring_enabled
          },
          ip_address: req.ip || req.connection.remoteAddress,
          user_agent: req.headers['user-agent']
        });
      } else {
        logger.warn('[API] auditSvc.logAuditTrail is not available');
      }
    } catch (auditError) {
      logger.error('[API] Error logging audit trail:', auditError);
    }

    res.json({ 
      success: true, 
      message: 'Pengaturan GenieACS berhasil disimpan. Restart aplikasi untuk menerapkan perubahan timeout.' 
    });
  } catch (error) {
    logger.error('[API] Error saving GenieACS settings:', error);
    res.json({ success: false, message: 'Error: ' + error.message });
  }
});

router.get('/api/genieacs/test', requireAdmin, async (req, res) => {
  try {
    const genieacs = require('../config/genieacs');
    const devices = await genieacs.getDevices();
    
    res.json({ 
      success: true, 
      message: 'Koneksi ke GenieACS berhasil!',
      deviceCount: devices.length
    });
  } catch (error) {
    logger.error('[API] Error testing GenieACS connection:', error);
    res.json({ 
      success: false, 
      message: 'Koneksi gagal: ' + error.message 
    });
  }
});

// ─── API ROUTES (existing) ──────────────────────────────────────────────────
router.get('/api/stats', requireAdmin, async (req, res) => {
  try {
    const result = await customerDevice.listAllDevices(999999);
    if (!result.ok) return res.json({ error: result.message });
    const mikrotikService = require('../services/mikrotikService');
    const activeSessionsMap = await mikrotikService.getActivePppoeSessionsMap().catch(() => new Map());

    const devices = result.devices;
    const total = devices.length;
    let online = 0, offline = 0;

    devices.forEach(d => {
      const pppoeUser = customerDevice.extractPppoeUser(d);
      const isPppoeActive = pppoeUser && pppoeUser !== 'N/A' && pppoeUser !== '-' && activeSessionsMap.has(pppoeUser.toLowerCase());
      const mapped = customerDevice.mapDeviceData(d, d._tags?.[0] || d._id, isPppoeActive) || {};
      const status = String(mapped.status || 'offline').toLowerCase();
      if (status === 'online') online++;
      else offline++;
    });

    res.json({ total, online, offline, warning: 0, lastUpdate: getNowLocalISO() });
  } catch (e) {
    res.status(500).json({ error: 'Failed to get stats', detail: e.message });
  }
});

router.get('/api/devices', requireAdmin, async (req, res) => {
  try {
    const { search, status, limit = 999999, offset = 0 } = req.query;
    const result = await customerDevice.listAllDevices(999999);
    if (!result.ok) return res.json({ error: result.message });
    const mikrotikService = require('../services/mikrotikService');
    const activeSessionsMap = await mikrotikService.getActivePppoeSessionsMap().catch(() => new Map());

    let devices = result.devices.map(d => {
      const pppoeUser = customerDevice.extractPppoeUser(d);
      const isPppoeActive = pppoeUser && pppoeUser !== 'N/A' && pppoeUser !== '-' && activeSessionsMap.has(pppoeUser.toLowerCase());
      const mapped = customerDevice.mapDeviceData(d, d._tags?.[0] || d._id, isPppoeActive) || {};
      const tagsArr = Array.isArray(d._tags) ? d._tags.filter(Boolean).map(String) : [];
      return {
        id: String(d._id || ''),
        tags: tagsArr,
        serialNumber: String(mapped.serialNumber || '-'),
        lastInform: d._lastInform,
        lastInformLabel: String(mapped.lastInform || '-'),
        lastInformAgo: String(mapped.lastInformAgo || '-'),
        lastSync: d._updatedAt || mapped.lastSyncRaw || d._lastInform || '',
        lastSyncLabel: String(mapped.lastSync || '-'),
        lastSyncAgo: String(mapped.lastSyncAgo || '-'),
        syncInProgress: !!mapped.syncInProgress,
        syncPendingCount: Number(mapped.syncPendingCount || 0),
        syncStatusLabel: String(mapped.syncStatusLabel || 'Idle'),
        status: String(mapped.status || 'unknown').toLowerCase(),
        pppoeIP: String(mapped.pppoeIP || '-'),
        pppoeUsername: String(mapped.pppoeUsername || '-'),
        rxPower: String(mapped.rxPower || '-'),
        uptime: String(mapped.uptime || '-'),
        model: String(mapped.model || '-'),
        softwareVersion: String(mapped.softwareVersion || '-'),
        userConnected: mapped.totalAssociations ?? '-',
        ssid: String(mapped.ssid || '-'),
        acs_server_id: d._acs_server_id || 'legacy',
        acs_server_name: d._acs_server_name || 'Default ACS'
      };
    });
    if (search) { 
      const s = search.toLowerCase();
      const billingCustomers = customerSvc.getAllCustomers(s);
      const matchingTags = new Set(billingCustomers.map(c => c.genieacs_tag?.toLowerCase()).filter(Boolean));
      const matchingPppoes = new Set(billingCustomers.map(c => c.pppoe_username?.toLowerCase()).filter(Boolean));

      devices = devices.filter(d => 
        String(d.id || '').toLowerCase().includes(s) ||
        (Array.isArray(d.tags) && d.tags.some(t => String(t || '').toLowerCase().includes(s) || matchingTags.has(String(t || '').toLowerCase()))) || 
        String(d.serialNumber || '').toLowerCase().includes(s) || 
        String(d.pppoeIP || '').toLowerCase().includes(s) ||
        (String(d.pppoeUsername || '') !== 'N/A' && String(d.pppoeUsername || '').toLowerCase().includes(s)) ||
        matchingPppoes.has(String(d.pppoeUsername || '').toLowerCase())
      ); 
    }
    if (status && status !== 'all') devices = devices.filter(d => d.status === status);
    const total = devices.length;
    const paginated = devices.slice(parseInt(offset), parseInt(offset) + parseInt(limit));
    res.json({ devices: paginated, total, limit: parseInt(limit), offset: parseInt(offset) });
  } catch (e) {
    res.status(500).json({ error: 'Failed to get devices', detail: e.message });
  }
});

router.get('/api/device/:tag', requireAdmin, async (req, res) => {
  try {
    const data = await customerDevice.getCustomerDeviceData(req.params.tag);
    if (!data || data.status === 'Tidak ditemukan') return res.status(404).json({ error: 'Device not found' });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: 'Failed to get device details' });
  }
});

router.post('/api/device/:tag/ssid', requireAdmin, express.json(), async (req, res) => {
  const { ssid } = req.body;
  if (!ssid) return res.status(400).json({ error: 'SSID required' });
  const ok = await customerDevice.updateSSID(req.params.tag, ssid);
  // Kirim notifikasi WhatsApp ke pelanggan
  if (ok) {
    try {
      const tag = req.params.tag;
      const cust = customerSvc.findCustomerByAny(tag);
      if (cust && cust.phone) {
        const now = getNowLocal();
		//Ambil Pesan Dari Template
        const { formatWifiSsidChanged } = require('../services/whatsappService');
        const msg = formatWifiSsidChanged({
          name: cust.name,
          ssid: ssid,
          time: now
        });
        await trySendWhatsappPayment(cust.phone, msg);
      }
    } catch (e) { logger.error('[Admin] Gagal kirim notif SSID via WA: ' + (e.message || e)); }
  }
  res.json({ success: ok });
});

router.post('/api/device/:tag/password', requireAdmin, express.json(), async (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 8) return res.status(400).json({ error: 'Password minimal 8 karakter' });
  const ok = await customerDevice.updatePassword(req.params.tag, password);
  // Kirim notifikasi WhatsApp ke pelanggan
  if (ok) {
    try {
      const tag = req.params.tag;
      const cust = customerSvc.findCustomerByAny(tag);
      if (cust && cust.phone) {
        const now = getNowLocal();
		//Ambil Pesan Dari Template
        const { formatWifiPassChanged } = require('../services/whatsappService');
        const msg = formatWifiPassChanged({
          name: cust.name,
          password: password,
          time: now
        });
        await trySendWhatsappPayment(cust.phone, msg);
      }
    } catch (e) { logger.error('[Admin] Gagal kirim notif Password via WA: ' + (e.message || e)); }
  }
  res.json({ success: ok });
});

router.post('/api/device/:tag/reboot', requireAdmin, async (req, res) => {
  const result = await customerDevice.requestReboot(req.params.tag);
  res.json(result);
});

router.post('/api/bulk/ssid', requireAdmin, express.json(), async (req, res) => {
  const { tags, ssid } = req.body;
  if (!Array.isArray(tags) || !ssid) return res.status(400).json({ error: 'Tags and SSID required' });
  const results = [];
  for (const tag of tags) {
    try {
      const success = await customerDevice.updateSSID(tag, ssid);
      results.push({ tag, success });
      // Kirim notifikasi WhatsApp ke pelanggan
      if (success) {
        try {
          const cust = customerSvc.findCustomerByAny(tag);
          if (cust && cust.phone) {
            const now = getNowLocal();
            const msg = `📶 *PERUBAHAN SSID WIFI*\n\n` +
              `👤 *Pelanggan:* ${cust.name}\n` +
              `🕒 *Waktu:* ${now}\n\n` +
              `SSID WiFi Anda sudah diperbarui menjadi:\n` +
              `📡 *${ssid}*\n\n` +
              `Silakan pilih SSID baru di perangkat Anda untuk terhubung.\n` +
              `⚠️ Jangan bagikan info ini ke orang lain.`;
            await trySendWhatsappPayment(cust.phone, msg);
          }
        } catch (e) { /* ignore per-customer WA notification errors */ }
      }
    }
    catch (e) { results.push({ tag, success: false, error: e.message }); }
  }
  res.json({ results, total: tags.length, success: results.filter(r => r.success).length });
});

router.get('/api/mikrotik/profiles', requireAdmin, async (req, res) => {
  try {
    const profiles = await mikrotikService.getPppoeProfiles(req.query.routerId);
    res.json(profiles);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/mikrotik/users', requireAdmin, async (req, res) => {
  try {
    const routerId = req.query.routerId ? Number(req.query.routerId) : null;
    const onlyUnused = String(req.query.onlyUnused || '') === '1';
    const excludeCustomerId = req.query.excludeCustomerId ? Number(req.query.excludeCustomerId) : null;
    const users = await mikrotikService.getPppoeUsers(routerId);
    if (!onlyUnused) return res.json(users);

    const rows = excludeCustomerId
      ? db.prepare("SELECT pppoe_username FROM customers WHERE router_id IS ? AND id != ? AND pppoe_username IS NOT NULL AND TRIM(pppoe_username) != ''").all(routerId, excludeCustomerId)
      : db.prepare("SELECT pppoe_username FROM customers WHERE router_id IS ? AND pppoe_username IS NOT NULL AND TRIM(pppoe_username) != ''").all(routerId);
    const used = new Set(rows.map(r => String(r.pppoe_username).trim()).filter(Boolean));
    const filtered = (Array.isArray(users) ? users : []).filter(u => u && u.name && !used.has(String(u.name).trim()));
    res.json(filtered);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── MIKROTIK MONITORING ───────────────────────────────────────────────────
router.get('/mikrotik', requireAdminSession, requireSidebarMenuAccess('mikrotik'), (req, res) => {
  const dbRouters = mikrotikService.getAllRouters();
  const settings = getSettings();
  const settingsRouter = {
    id: '',
    name: settings.mikrotik_host ? `MikroTik (settings.json - ${settings.mikrotik_host})` : 'MikroTik (settings.json)',
    host: settings.mikrotik_host || '',
    user: settings.mikrotik_user || '',
    port: settings.mikrotik_port || 8728,
    is_active: true
  };
  
  const routers = dbRouters.length > 0 ? dbRouters : [settingsRouter];
  
  // Jika req.selectedRouterId bernilai null/kosong, biarkan kosong (artinya user memilih Default)
  const activeRouterId = req.selectedRouterId ? req.selectedRouterId : '';

  res.render('admin/mikrotik', {
    title: 'Monitoring MikroTik', company: company(), activePage: 'mikrotik',
    routers, activeRouterId, selectedRouterId: req.selectedRouterId, msg: flashMsg(req)
  });
});

router.get('/mikrotik/display', requireAdminSession, (req, res) => {
  const routers = mikrotikService.getAllRouters();
  const settings = getSettings();
  const defaultRouter = {
    id: 'settings_json',
    name: 'MikroTik (settings.json)',
    host: settings.mikrotik_host || '',
    user: settings.mikrotik_user || '',
    port: settings.mikrotik_port || 8728,
    is_active: true
  };
  
  const allRouters = [defaultRouter, ...routers];

  res.render('admin/mikrotik_display', {
    title: 'MikroTik NOC Display',
    company: company(),
    routers: allRouters,
    msg: flashMsg(req),
    settings
  });
});

router.get('/vouchers', requireAdminSession, (req, res) => {
  const routers = mikrotikService.getAllRouters();
  const selectedRouterId = req.selectedRouterId || (req.query.router_id ? Number(req.query.router_id) : null);
  res.render('admin/vouchers', {
    title: 'Manajemen Voucher', company: company(), activePage: 'mikrotik',
    routers, selectedRouterId, msg: flashMsg(req), settings: getSettings()
  });
});

router.get('/api/vouchers/template', requireAdminSession, (req, res) => {
  const settings = getSettings();
  res.json({
    use_template: !!settings.voucher_print_use_template,
    default_style: String(settings.voucher_print_default_style || ''),
    header: String(settings.voucher_print_template_header || ''),
    row: String(settings.voucher_print_template_row || ''),
    footer: String(settings.voucher_print_template_footer || '')
  });
});

router.post('/api/vouchers/template', requireAdminSession, restrictToAdmin, express.json({ limit: '1mb' }), (req, res) => {
  try {
    const useTemplate = !!req.body.use_template;
    const defaultStyle = String(req.body.default_style || '').trim().toLowerCase();
    const header = String(req.body.header || '');
    const row = String(req.body.row || '');
    const footer = String(req.body.footer || '');
    saveSettings({
      voucher_print_use_template: useTemplate,
      voucher_print_default_style: defaultStyle,
      voucher_print_template_header: header,
      voucher_print_template_row: row,
      voucher_print_template_footer: footer
    });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/webhook/payment-notif/logs', requireAdminSession, (req, res) => {
  try {
    const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 200));
    const service = String(req.query.service || '').trim();
    const q = String(req.query.q || '').trim();

    const where = [];
    const params = [];
    if (service) {
      where.push('service = ?');
      params.push(service);
    }
    if (q) {
      where.push('(content LIKE ? OR service LIKE ?)');
      params.push(`%${q}%`, `%${q}%`);
    }

    const sql = `
      SELECT id, created_at, service, content, parsed_amount, parsed_ok, matched_invoice_id, matched_voucher_order_id, matched_donation_order_id, ip
      FROM webhook_payment_notifs
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY id DESC
      LIMIT ?
    `;
    const rows = db.prepare(sql).all(...params, limit);

    // Convert created_at to local timezone
    const rowsWithLocalTime = rows.map(row => ({
      ...row,
      created_at: row.created_at ? formatDateLocal(row.created_at, 'YYYY-MM-DD HH:mm:ss') : null
    }));

    res.json({ ok: true, rows: rowsWithLocalTime });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/api/webhook/payment-notif/clear', requireAdminSession, restrictToAdmin, express.json(), (req, res) => {
  try {
    db.prepare('DELETE FROM webhook_payment_notifs').run();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get('/vouchers/batches/:id/print', requireAdminSession, (req, res) => {
  const batchId = Number(req.params.id);
  const batch = db.prepare(`
    SELECT b.*, r.name AS router_name
    FROM voucher_batches b
    LEFT JOIN routers r ON r.id = b.router_id
    WHERE b.id = ?
  `).get(batchId);
  if (!batch) return res.status(404).send('Batch tidak ditemukan');

  const vouchers = db.prepare(`
    SELECT code, password, profile_name, used_at
    FROM vouchers
    WHERE batch_id = ?
    ORDER BY code ASC
  `).all(batchId);

  const settings = getSettings();
  const requestedStyle = String(req.query.style || '').trim().toLowerCase();
  const style = requestedStyle || String(settings.voucher_print_default_style || '').trim().toLowerCase() || (settings.voucher_print_use_template ? 'template' : 'cards');

  const escapeHtml = (s) => String(s ?? '').replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

  const stripUnsafe = (html) => {
    let out = String(html || '');
    out = out.replace(/<\?(?:php)?[\s\S]*?\?>/gi, '');
    out = out.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
    out = out.replace(/\son\w+\s*=\s*(['"]).*?\1/gi, '');
    return out;
  };

  const applyVars = (tpl, vars) => {
    let out = String(tpl || '');
    out = out.replace(/%([a-zA-Z0-9_#]+)%/g, (m, k) => (vars[k] != null ? vars[k] : m));
    out = out.replace(/\{\{\s*([a-zA-Z0-9_#]+)\s*\}\}/g, (m, k) => (vars[k] != null ? vars[k] : m));
    return out;
  };

  const formatValidity = (v) => {
    if (!v) return '-';
    const s = String(v).trim();
    const mDay = s.match(/^(\d+)\s*d$/i);
    if (mDay) return `${Number(mDay[1])} hari`;
    return s;
  };

  let renderedHtml = '';
  let templateError = '';
  const builtinTemplate = (name) => {
    const phone = (Array.isArray(settings.whatsapp_admin_numbers) && settings.whatsapp_admin_numbers.length > 0)
      ? ('+' + String(settings.whatsapp_admin_numbers[0]))
      : String(settings.company_phone || '');
    const companyName = settings.company_header || company();
    const timeStamp = new Date().toISOString();
    const priceNumber = Number(batch.price || 0);
    const priceText = priceNumber.toLocaleString('id-ID');
    const validityText = formatValidity(batch.validity);

    const rows = (vouchers || []).map((v, i) => {
      const credential = (String(v.code) === String(v.password))
        ? escapeHtml(String(v.code))
        : `U: ${escapeHtml(v.code)}<br>P: ${escapeHtml(v.password)}`;
      return {
        idx: i + 1,
        username: escapeHtml(v.code),
        password: escapeHtml(v.password),
        credential,
        profile: escapeHtml(batch.profile_name || v.profile_name || ''),
        company: escapeHtml(companyName),
        phone: escapeHtml(phone),
        timeStamp: escapeHtml(timeStamp),
        currency: 'Rp',
        price: escapeHtml(String(priceNumber)),
        priceText: escapeHtml(priceText),
        validity: escapeHtml(batch.validity || ''),
        validityText: escapeHtml(validityText),
      };
    });

    if (name === 'mks') {
      const css = `<style>
@page{size:A4;margin:6mm}
*{box-sizing:border-box}
body{margin:0;font-family:Arial,sans-serif;color:#0f172a}
.v-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.vc{border:1px solid #0f172a;border-radius:10px;min-height:110px;padding:8px;position:relative;break-inside:avoid;overflow:hidden}
.vc:before{content:"";position:absolute;inset:0;background:linear-gradient(120deg,rgba(59,130,246,.03),rgba(16,185,129,.025))}
.vc>*{position:relative}
.vh{font-weight:900;font-size:11px;letter-spacing:.2px}
.vp{position:absolute;top:8px;right:8px;font-size:10.5px;font-weight:800;background:rgba(16,185,129,.16);border:1px solid rgba(16,185,129,.35);padding:2px 7px;border-radius:999px}
.vm{font-size:10px;color:#334155;margin-top:6px}
.vu{font-weight:950;font-size:18px;letter-spacing:1px;margin-top:8px;font-family:Consolas,monospace;line-height:1.15}
.vf{position:absolute;left:50%;bottom:6px;transform:translateX(-50%);font-size:9.5px;color:#334155;white-space:nowrap}
</style>`;
      const html = rows.map(r => `<div class="vc">
  <div class="vh">${r.company}</div>
  <div class="vp">${r.currency} ${r.priceText}</div>
  <div class="vm">${r.profile} • ${r.validityText}</div>
  <div class="vu">${r.credential}</div>
  <div class="vf">WA: ${r.phone}</div>
</div>`).join('\n');
      return `${css}<div class="v-grid">\n${html}\n</div>`;
    }

    if (name === 'simple') {
      const css = `<style>
@page{size:A4;margin:6mm}
*{box-sizing:border-box}
body{margin:0;font-family:Arial,sans-serif;color:#0f172a}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.card{border:1.5px solid #334155;border-radius:10px;padding:8px 8px 22px;min-height:110px;position:relative;break-inside:avoid}
.hd{font-weight:800;font-size:11px}
.code{font-weight:900;font-size:22px;letter-spacing:2px;margin-top:6px;font-family:Consolas,monospace}
.meta{font-size:10px;color:#334155;margin-top:4px}
.wa{position:absolute;left:50%;bottom:6px;transform:translateX(-50%);font-size:9.5px;color:#334155;white-space:nowrap}
</style>`;
      const html = rows.map(r => `<div class="card">
  <div class="hd">${r.company}</div>
  <div class="meta">${r.profile} • ${r.validityText} • ${r.currency} ${r.priceText}</div>
  <div class="code">${r.username}</div>
  <div class="meta">${r.password}</div>
  <div class="wa">WA: ${r.phone}</div>
</div>`).join('\n');
      return `${css}<div class="grid">\n${html}\n</div>`;
    }

    if (name === 'minimal') {
      const css = `<style>
@page{size:A4;margin:6mm}
*{box-sizing:border-box}
body{margin:0;font-family:Arial,sans-serif;color:#0f172a}
.g{display:grid;grid-template-columns:repeat(4,1fr);gap:6px}
.c{border:1px dashed #334155;border-radius:8px;padding:6px 6px 18px;min-height:84px;position:relative;break-inside:avoid}
.t{font-weight:900;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.m{font-size:9.5px;color:#334155;margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.k{font-weight:950;font-size:18px;letter-spacing:2px;margin-top:8px;font-family:Consolas,monospace}
.w{position:absolute;left:6px;right:6px;bottom:5px;font-size:9px;color:#334155;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
</style>`;
      const html = rows.map(r => `<div class="c">
  <div class="t">${r.company}</div>
  <div class="m">${r.profile}</div>
  <div class="k">${r.username}</div>
  <div class="w">${r.validityText} • ${r.currency} ${r.priceText} • ${r.phone}</div>
</div>`).join('\n');
      return `${css}<div class="g">\n${html}\n</div>`;
    }

    return '';
  };

  if (style === 'mks' || style === 'simple' || style === 'minimal') {
    renderedHtml = builtinTemplate(style);
  } else if (style === 'template') {
    const headerTpl = String(settings.voucher_print_template_header || '');
    const rowTpl = String(settings.voucher_print_template_row || '');
    const footerTpl = String(settings.voucher_print_template_footer || '');

    if (rowTpl.trim()) {
      const looksLikePhpOnly = (tpl) => {
        const s = String(tpl || '');
        const hasHtml = /<\s*[a-zA-Z][^>]*>/.test(s);
        const phpSignals = /(\$[a-zA-Z_])|(\bif\s*\()|(\bsubstr\s*\()|(\bstrlen\s*\()|(\belse(if)?\b)|(\bforeach\b)/.test(s);
        const manyPhp = (s.match(/\$/g) || []).length >= 3;
        return !hasHtml && (phpSignals || manyPhp);
      };
      const combined = `${headerTpl}\n${rowTpl}\n${footerTpl}`;
      if (/<\?(?:php)?/i.test(combined) || looksLikePhpOnly(combined)) {
        templateError = 'Template yang dipaste masih format PHP (Mikhmon). Di sini hanya mendukung template HTML + placeholder (%username% dll).';
      }

      const phone = (Array.isArray(settings.whatsapp_admin_numbers) && settings.whatsapp_admin_numbers.length > 0)
        ? ('+' + String(settings.whatsapp_admin_numbers[0]))
        : String(settings.company_phone || '');
      const timeStamp = new Date().toISOString();
      const priceNumber = Number(batch.price || 0);
      const priceText = priceNumber.toLocaleString('id-ID');
      const validityText = formatValidity(batch.validity);

      const parts = [];
      parts.push(stripUnsafe(applyVars(headerTpl, {
        company: escapeHtml(settings.company_header || company()),
        phone: escapeHtml(phone),
        timeStamp: escapeHtml(timeStamp),
        currency: 'Rp',
        validityText: escapeHtml(validityText),
        priceText: escapeHtml(priceText)
      })));

      vouchers.forEach((v, i) => {
        const credential = (String(v.code) === String(v.password))
          ? escapeHtml(String(v.code))
          : `U: ${escapeHtml(v.code)}<br>P: ${escapeHtml(v.password)}`;
        const vars = {
          username: escapeHtml(v.code),
          password: escapeHtml(v.password),
          profile: escapeHtml(batch.profile_name || v.profile_name || ''),
          validity: escapeHtml(batch.validity || ''),
          validityText: escapeHtml(validityText),
          price: escapeHtml(String(priceNumber)),
          priceText: escapeHtml(priceText),
          currency: 'Rp',
          company: escapeHtml(settings.company_header || company()),
          phone: escapeHtml(phone),
          timeStamp: escapeHtml(timeStamp),
          '#': escapeHtml(String(i + 1)),
          credential
        };
        parts.push(stripUnsafe(applyVars(rowTpl, vars)));
      });

      parts.push(stripUnsafe(applyVars(footerTpl, {
        company: escapeHtml(settings.company_header || company()),
        phone: escapeHtml(phone),
        timeStamp: escapeHtml(timeStamp),
        currency: 'Rp',
        validityText: escapeHtml(validityText),
        priceText: escapeHtml(priceText)
      })));

      renderedHtml = parts.join('\n');
    }
  }

  let finalStyle = style;
  if (finalStyle === 'template') {
    const s = String(renderedHtml || '').trim();
    if (!s || !/<\s*[a-zA-Z][^>]*>/.test(s) || templateError) {
      renderedHtml = '';
      finalStyle = 'cards';
    }
  }

  res.render('admin/print_vouchers', {
    title: 'Cetak Voucher',
    company: company(),
    settings,
    batch,
    vouchers,
    style: finalStyle,
    renderedHtml,
    templateError
  });
});

router.get('/vouchers/batches/:id/export.csv', requireAdminSession, (req, res) => {
  const batchId = Number(req.params.id);
  const batch = db.prepare(`
    SELECT b.*, r.name AS router_name
    FROM voucher_batches b
    LEFT JOIN routers r ON r.id = b.router_id
    WHERE b.id = ?
  `).get(batchId);
  if (!batch) return res.status(404).send('Batch tidak ditemukan');

  const vouchers = db.prepare(`
    SELECT code, password, profile_name, used_at
    FROM vouchers
    WHERE batch_id = ?
    ORDER BY code ASC
  `).all(batchId);

  const lines = [];
  lines.push(['code', 'password', 'profile', 'validity', 'price', 'router', 'batch_id', 'created_at', 'used_at'].join(','));
  const createdAt = batch.created_at || '';
  const validity = batch.validity || '';
  const price = Number(batch.price || 0);
  const routerName = batch.router_name || '';
  for (const v of vouchers) {
    const row = [
      v.code,
      v.password,
      v.profile_name,
      validity,
      price,
      routerName,
      batchId,
      createdAt,
      v.used_at || ''
    ].map(x => `"${String(x ?? '').replace(/"/g, '""')}"`).join(',');
    lines.push(row);
  }

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename=vouchers_batch_${batchId}.csv`);
  res.send(lines.join('\n'));
});

router.get('/api/vouchers/batches', requireAdmin, (req, res) => {
  const routerId = req.query.routerId ? Number(req.query.routerId) : null;
  const rows = db.prepare(`
    SELECT
      b.*,
      r.name AS router_name,
      (SELECT COUNT(1) FROM vouchers v WHERE v.batch_id = b.id) AS vouchers_count,
      (SELECT COUNT(1) FROM vouchers v WHERE v.batch_id = b.id AND v.used_at IS NOT NULL) AS used_count
    FROM voucher_batches b
    LEFT JOIN routers r ON r.id = b.router_id
    WHERE (? IS NULL OR b.router_id = ?)
    ORDER BY b.id DESC
    LIMIT 200
  `).all(routerId, routerId);
  res.json(rows);
});

router.get('/api/vouchers/batches/:id', requireAdmin, (req, res) => {
  const batchId = Number(req.params.id);
  const batch = db.prepare(`
    SELECT
      b.*,
      r.name AS router_name,
      (SELECT COUNT(1) FROM vouchers v WHERE v.batch_id = b.id) AS vouchers_count,
      (SELECT COUNT(1) FROM vouchers v WHERE v.batch_id = b.id AND v.used_at IS NOT NULL) AS used_count
    FROM voucher_batches b
    LEFT JOIN routers r ON r.id = b.router_id
    WHERE b.id = ?
  `).get(batchId);
  if (!batch) return res.status(404).json({ error: 'Batch tidak ditemukan' });

  const vouchers = db.prepare(`
    SELECT id, code, password, profile_name, status, used_at, last_seen_comment, last_seen_uptime, last_seen_at
    FROM vouchers
    WHERE batch_id = ?
    ORDER BY code ASC
    LIMIT 2000
  `).all(batchId);
  res.json({ batch, vouchers });
});

router.post('/api/vouchers/batches', requireAdmin, express.json(), async (req, res) => {
  try {
    const routerId = req.query.routerId ? Number(req.query.routerId) : null;
    const profileName = String(req.body.profile || '').trim();
    const qty = Math.max(1, Math.min(5000, Number(req.body.qty) || 0));
    const prefix = String(req.body.prefix || '').trim();
    const codeLength = Math.max(4, Math.min(16, Number(req.body.codeLength) || 6));
    const mode = String(req.body.mode || 'voucher');
    const charset = String(req.body.charset || 'numbers');
    const priceInput = req.body.price;
    
    if (!profileName) return res.status(400).json({ error: 'Profile wajib diisi' });
    if (!qty) return res.status(400).json({ error: 'Jumlah voucher wajib diisi' });
    if (prefix.length >= codeLength) return res.status(400).json({ error: 'Prefix terlalu panjang' });

    const profiles = await mikrotikService.getHotspotUserProfiles(routerId);
    const profile = profiles.find(p => p.name === profileName);
    if (!profile) return res.status(400).json({ error: 'Profile Hotspot tidak ditemukan di MikroTik' });

    const meta = parseMikhmonOnLogin(profile.onLogin || profile['on-login']);
    if (!meta || !meta.validity) return res.status(400).json({ error: 'Profile belum memiliki metadata harga/durasi (Format Mikhmon)' });

    const createdBy = req.session?.isAdmin ? (req.session.adminUser || 'admin') : (req.session.cashierName || 'kasir');
    let price = Number(meta.price || 0);
    if (priceInput !== undefined && priceInput !== null && String(priceInput).trim() !== '') {
      const p = Number(priceInput);
      if (!Number.isFinite(p) || p < 0) return res.status(400).json({ error: 'Harga tidak valid' });
      price = Math.floor(p);
    }

    const now = new Date();
    const dd = String(now.getDate()).padStart(2, '0');
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const yy = String(now.getFullYear()).slice(-2);
    const defaultComment = `vc-${createdBy}-${dd}.${mm}.${yy}`;
    const comment = String(req.body.comment || defaultComment).trim();

    const insertBatch = db.prepare(`
      INSERT INTO voucher_batches (router_id, profile_name, qty_total, qty_created, qty_failed, price, validity, prefix, code_length, status, created_by, mode, charset)
      VALUES (?, ?, ?, 0, 0, ?, ?, ?, ?, 'creating', ?, ?, ?)
    `);
    const batchRes = insertBatch.run(routerId, profileName, qty, price, meta.validity || '', prefix, codeLength, createdBy, mode, charset);
    const batchId = Number(batchRes.lastInsertRowid);

    const insertVoucher = db.prepare(`
      INSERT INTO vouchers (batch_id, router_id, code, password, profile_name, comment, status)
      VALUES (?, ?, ?, ?, ?, ?, 'pending')
    `);

    const exists = db.prepare('SELECT 1 FROM vouchers WHERE router_id IS ? AND code = ? LIMIT 1');
    const codes = new Set();
    const makeCode = () => {
      const coreLen = Math.max(4, Math.min(16, codeLength - prefix.length));
      const userCode = prefix + genCode(coreLen, charset);
      let passCode = userCode;
      if (mode === 'member') {
        passCode = genCode(coreLen, charset);
      }
      return { userCode, passCode };
    };

    const initialVouchers = [];
    while (initialVouchers.length < qty) {
      const generated = makeCode();
      if (codes.has(generated.userCode)) continue;
      if (exists.get(routerId, generated.userCode)) continue;
      codes.add(generated.userCode);
      initialVouchers.push(generated);
    }

    const tx = db.transaction((items) => {
      for (const c of items) {
        insertVoucher.run(batchId, routerId, c.userCode, c.passCode, profileName, comment);
      }
    });
    tx(initialVouchers);

    setImmediate(() => {
      createVoucherBatchAsync(batchId).catch(e => logger.error('[VoucherBatch] Error: ' + (e?.message || e)));
    });

    res.json({ success: true, batchId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/api/vouchers/batches/:id/sync', requireAdmin, async (req, res) => {
  try {
    const batchId = Number(req.params.id);
    const batch = db.prepare('SELECT * FROM voucher_batches WHERE id = ?').get(batchId);
    if (!batch) return res.status(404).json({ error: 'Batch tidak ditemukan' });

    const routerId = batch.router_id ?? null;
    const users = await mikrotikService.getHotspotUsers(routerId);
    const byName = new Map();
    for (const u of users) {
      if (u?.name) byName.set(String(u.name), u);
    }

    const list = db.prepare('SELECT id, code, used_at FROM vouchers WHERE batch_id = ?').all(batchId);
    const updSeen = db.prepare("UPDATE vouchers SET last_seen_comment=?, last_seen_uptime=?, last_seen_at=(NOW_LOCAL()) WHERE id=?");
    const markUsed = db.prepare("UPDATE vouchers SET used_at=(NOW_LOCAL()), status='used', last_seen_comment=?, last_seen_uptime=?, last_seen_at=(NOW_LOCAL()) WHERE id=?");
    const markMissing = db.prepare("UPDATE vouchers SET status='missing', last_seen_at=(NOW_LOCAL()) WHERE id=?");

    let usedNew = 0;
    let missing = 0;

    const tx = db.transaction(() => {
      for (const v of list) {
        const u = byName.get(String(v.code));
        if (!u) {
          markMissing.run(v.id);
          missing++;
          continue;
        }
        const comment = String(u.comment || '');
        const uptime = String(u.uptime || '');
        const isUsedByComment = comment && !comment.toLowerCase().startsWith('vc') && !comment.toLowerCase().startsWith('up');
        const isUsedByUptime = uptime && uptime !== '0s' && uptime !== '0' && uptime !== '00:00:00';
        const usedNow = isUsedByComment || isUsedByUptime;
        if (usedNow && !v.used_at) {
          markUsed.run(comment, uptime, v.id);
          usedNew++;
        } else {
          updSeen.run(comment, uptime, v.id);
        }
      }
    });
    tx();

    res.json({ success: true, usedNew, missing, total: list.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/api/vouchers/batches/:id/delete', requireAdmin, async (req, res) => {
  try {
    const batchId = Number(req.params.id);
    if (!batchId) return res.status(400).json({ error: 'Batch ID tidak valid' });

    const batch = db.prepare('SELECT id, status FROM voucher_batches WHERE id = ?').get(batchId);
    if (!batch) return res.status(404).json({ error: 'Batch tidak ditemukan' });
    if (String(batch.status) === 'creating') {
      return res.status(400).json({ error: 'Batch sedang diproses (creating). Silakan tunggu hingga selesai.' });
    }

    const stats = db.prepare(`
      SELECT
        (SELECT COUNT(1) FROM vouchers v WHERE v.batch_id = ?) AS total,
        (SELECT COUNT(1) FROM vouchers v WHERE v.batch_id = ? AND v.used_at IS NOT NULL) AS used
    `).get(batchId, batchId);

    const del = db.prepare('DELETE FROM voucher_batches WHERE id = ?');
    del.run(batchId);

    res.json({ success: true, deletedBatchId: batchId, deletedVouchers: stats?.total || 0, usedCount: stats?.used || 0 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/mikrotik/secrets', requireAdmin, async (req, res) => {
  try { res.json(await mikrotikService.getPppoeSecrets(req.query.routerId)); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/mikrotik/secrets', requireAdmin, express.json(), async (req, res) => {
  try { await mikrotikService.addPppoeSecret(req.body, req.query.routerId); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/mikrotik/secrets/:id/update', requireAdmin, express.json(), async (req, res) => {
  try { await mikrotikService.updatePppoeSecret(req.params.id, req.body, req.query.routerId); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/mikrotik/secrets/:id/delete', requireAdmin, async (req, res) => {
  try { await mikrotikService.deletePppoeSecret(req.params.id, req.query.routerId); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/api/mikrotik/hotspot-users', requireAdmin, async (req, res) => {
  try { res.json(await mikrotikService.getHotspotUsers(req.query.routerId)); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/mikrotik/hotspot-users', requireAdmin, express.json(), async (req, res) => {
  try { await mikrotikService.addHotspotUser(req.body, req.query.routerId); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/mikrotik/hotspot-users/:id/update', requireAdmin, express.json(), async (req, res) => {
  try { await mikrotikService.updateHotspotUser(req.params.id, req.body, req.query.routerId); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/mikrotik/hotspot-users/:id/delete', requireAdmin, async (req, res) => {
  try { await mikrotikService.deleteHotspotUser(req.params.id, req.query.routerId); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/api/mikrotik/monitoring-display-data', requireAdmin, async (req, res) => {
  const routerId = req.query.routerId ? (req.query.routerId === 'null' || req.query.routerId === 'settings' || req.query.routerId === 'settings_json' ? 'settings_json' : Number(req.query.routerId)) : 'settings_json';
  try {
    const conn = await mikrotikService.getConnection(routerId);
    if (!conn) {
      return res.status(500).json({ error: 'Gagal terhubung ke router MikroTik.' });
    }

    // Parallel execution for performance
    const [
      resource,
      interfaces,
      activePppoe,
      secrets,
      activeHotspot,
      hotspotUsers
    ] = await Promise.all([
      // 1. Resources
      mikrotikService.getSystemResource(routerId).catch(err => {
        logger.error('[NOC Display] Error resource:', err.message);
        return null;
      }),
      // 2. Interfaces
      conn.client.menu('/interface').get().catch(err => {
        logger.error('[NOC Display] Error interfaces:', err.message);
        return [];
      }),
      // 3. Active PPPoE
      mikrotikService.getPppoeActive(routerId).catch(err => {
        logger.error('[NOC Display] Error active PPPoE:', err.message);
        return [];
      }),
      // 4. PPPoE Secrets
      mikrotikService.getPppoeSecrets(routerId).catch(err => {
        logger.error('[NOC Display] Error secrets:', err.message);
        return [];
      }),
      // 5. Active Hotspot
      mikrotikService.getHotspotActive(routerId).catch(err => {
        logger.error('[NOC Display] Error active Hotspot:', err.message);
        return [];
      }),
      // 6. Hotspot Users
      mikrotikService.getHotspotUsers(routerId).catch(err => {
        logger.error('[NOC Display] Error hotspot users:', err.message);
        return [];
      })
    ]);

    // Calculate PPPoE Offline
    const activePppoeNames = new Set((activePppoe || []).map(s => String(s.name).trim()));
    const offlinePppoe = (secrets || []).filter(s => {
      const isOnline = activePppoeNames.has(String(s.name).trim());
      const isDisabled = s.disabled === true || s.disabled === 'true';
      return !isOnline && !isDisabled;
    });

    // Format resources
    const resData = {
      cpu: resource ? String(resource['cpu-load'] || resource.cpuLoad || resource['cpu'] || '0') : '0',
      freeMemory: resource ? Number(resource['free-memory'] || resource.freeMemory) || 0 : 0,
      totalMemory: resource ? Number(resource['total-memory'] || resource.totalMemory) || 0 : 0,
      uptime: resource ? String(resource['uptime'] || '00:00:00') : '00:00:00',
      boardName: resource ? String(resource['board-name'] || resource.boardName || 'MikroTik') : 'MikroTik',
      version: resource ? String(resource['version'] || 'N/A') : 'N/A'
    };

    // Format interfaces (only return fields needed)
    const formattedInterfaces = (interfaces || []).map(i => {
      return {
        name: i.name,
        type: i.type,
        running: i.running === true || i.running === 'true' || i.running === 'yes',
        disabled: i.disabled === true || i.disabled === 'true' || i.disabled === 'yes',
        bytesIn: Number(i['rx-byte'] || i['rx-bytes'] || i['bytes-in']) || 0,
        bytesOut: Number(i['tx-byte'] || i['tx-bytes'] || i['bytes-out']) || 0
      };
    });

    res.json({
      ok: true,
      resources: resData,
      interfaces: formattedInterfaces,
      pppoe: {
        active: activePppoe ? activePppoe.length : 0,
        offline: offlinePppoe ? offlinePppoe.length : 0,
        total: secrets ? secrets.length : 0
      },
      hotspot: {
        active: activeHotspot ? activeHotspot.length : 0,
        total: hotspotUsers ? hotspotUsers.length : 0
      },
      timestamp: Date.now()
    });
  } catch (e) {
    logger.error('[NOC Display API] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/mikrotik/hotspot-profiles', requireAdmin, async (req, res) => {
  try { res.json(await mikrotikService.getHotspotProfiles(req.query.routerId)); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/api/mikrotik/active-pppoe', requireAdmin, async (req, res) => {
  try { res.json(await mikrotikService.getPppoeActive(req.query.routerId)); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/api/mikrotik/active-hotspot', requireAdmin, async (req, res) => {
  try { res.json(await mikrotikService.getHotspotActive(req.query.routerId)); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/api/mikrotik/ip-pools', requireAdmin, async (req, res) => {
  try { res.json(await mikrotikService.getIpPools(req.query.routerId)); } catch (e) { res.status(500).json({ error: e.message }); }
});

// PPPoE Profiles CRUD
router.post('/api/mikrotik/pppoe-profiles', requireAdmin, express.json(), async (req, res) => {
  try { await mikrotikService.addPppoeProfile(req.body, req.query.routerId); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/api/mikrotik/pppoe-profiles/:id/update', requireAdmin, express.json(), async (req, res) => {
  try { await mikrotikService.updatePppoeProfile(req.params.id, req.body, req.query.routerId); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/api/mikrotik/pppoe-profiles/:id/delete', requireAdmin, async (req, res) => {
  try { await mikrotikService.deletePppoeProfile(req.params.id, req.query.routerId); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});

// Hotspot User Profiles CRUD
router.get('/api/mikrotik/hotspot-user-profiles', requireAdmin, async (req, res) => {
  try {
    const rows = await mikrotikService.getHotspotUserProfiles(req.query.routerId);
    res.json((Array.isArray(rows) ? rows : []).map((r) => ({ ...r, id: r.id || r['.id'] })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
router.get('/api/mikrotik/hotspot-user-profiles/:id', requireAdmin, async (req, res) => {
  try {
    const row = await mikrotikService.getHotspotUserProfileById(req.params.id, req.query.routerId);
    if (!row) return res.status(404).json({ error: 'Profile tidak ditemukan' });
    return res.json({ ok: true, row });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});
router.post('/api/mikrotik/hotspot-user-profiles', requireAdmin, express.json(), async (req, res) => {
  try { await mikrotikService.addHotspotUserProfile(req.body, req.query.routerId); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/api/mikrotik/hotspot-user-profiles/:id/update', requireAdmin, express.json(), async (req, res) => {
  try { await mikrotikService.updateHotspotUserProfile(req.params.id, req.body, req.query.routerId); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/api/mikrotik/hotspot-user-profiles/:id/delete', requireAdmin, async (req, res) => {
  try { await mikrotikService.deleteHotspotUserProfile(req.params.id, req.query.routerId); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/api/mikrotik/backup', requireAdmin, async (req, res) => {
  try {
    const backup = await mikrotikService.getBackup(req.query.routerId);
    res.setHeader('Content-disposition', 'attachment; filename=mikrotik_backup_' + new Date().toISOString().slice(0,10) + '.rsc');
    res.setHeader('Content-type', 'text/plain');
    res.send(backup);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── WHATSAPP ──────────────────────────────────────────────────────────────
// Global Broadcast Tracker
global.broadcastStatus = {
  active: false,
  total: 0,
  sent: 0,
  failed: 0,
  startTime: null,
  paused: false,
  stopped: false,
  currentBatch: 0,
  messagesPerHour: 0,
  hourlyLimit: 100
};

// Helper: Random delay generator untuk smart rate limiting
function getRandomDelay(baseDelayMs, varianceMs = 3000) {
  const minDelay = Math.max(baseDelayMs - varianceMs, 2000);
  const maxDelay = baseDelayMs + varianceMs;
  return Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;
}

// Helper: Exponential backoff untuk error handling
function getBackoffDelay(attemptCount, baseDelayMs = 2000) {
  const maxDelay = 30000;
  const delay = Math.min(baseDelayMs * Math.pow(2, attemptCount), maxDelay);
  return delay + Math.floor(Math.random() * 1000);
}

// Helper: Message variation untuk menghindari spam detection
function addMessageVariation(message, index) {
  const variations = [
    '',
    '\n\n_',
    '\n\n•',
    '\n\n▪',
    '\n\n▫'
  ];
  const suffix = variations[index % variations.length];
  return message + suffix;
}

// Helper: Cek apakah waktu aman untuk broadcast (hindari jam sibuk)
function isSafeTimeToBroadcast() {
  const now = new Date();
  const hour = now.getHours();
  // Hindari jam 00:00 - 06:00 (jam malam) dan jam 18:00 - 21:00 (jam sibuk)
  return hour >= 8 && hour <= 17;
}

// Helper: Hitung delay berdasarkan jam (lebih lama di jam sibuk)
function getTimeBasedDelay(baseDelayMs) {
  const now = new Date();
  const hour = now.getHours();
  
  // Jam sibuk (18:00 - 21:00): delay 2x lebih lama
  if (hour >= 18 && hour <= 21) {
    return baseDelayMs * 2;
  }
  
  // Jam malam (00:00 - 06:00): delay 3x lebih lama
  if (hour >= 0 && hour <= 6) {
    return baseDelayMs * 3;
  }
  
  // Jam normal: delay normal
  return baseDelayMs;
}

// Helper: Cek duplicate message untuk menghindari spam
function isDuplicateMessage(phone, message, messageHistory) {
  const key = `${phone}_${message.substring(0, 50)}`;
  const lastSent = messageHistory.get(key);
  if (!lastSent) return false;
  
  const timeDiff = Date.now() - lastSent;
  return timeDiff < 3600000; // 1 jam
}

// Helper: Cek apakah error adalah permanent (tidak perlu retry)
function isPermanentError(errorMessage) {
  const permanentErrorPatterns = [
    /invalid.*number/i,
    /number.*not.*found/i,
    /phone.*not.*exist/i,
    /blocked/i,
    /banned/i,
    /not.*registered/i,
    /user.*not.*found/i,
    /404/i,
    /400/i
  ];
  
  return permanentErrorPatterns.some(pattern => pattern.test(errorMessage));
}

// Helper: Cek apakah error adalah temporary (bisa retry)
function isTemporaryError(errorMessage) {
  const temporaryErrorPatterns = [
    /timeout/i,
    /network/i,
    /connection/i,
    /rate.*limit/i,
    /too.*many/i,
    /429/i,
    /500/i,
    /502/i,
    /503/i,
    /504/i
  ];
  
  return temporaryErrorPatterns.some(pattern => pattern.test(errorMessage));
}

// Global message history untuk duplicate detection
global.broadcastMessageHistory = new Map();

const waSvc = require('../services/whatsappService');

router.get('/whatsapp', requireAdminSession, requireSidebarMenuAccess('whatsapp'), async (req, res) => {
  const waGatewayType = getSetting('wa_gateway_type', 'baileys');
  const metaSettings = {
    meta_phone_number_id: getSetting('meta_phone_number_id', ''),
    meta_waba_id: getSetting('meta_waba_id', ''),
    meta_access_token: getSetting('meta_access_token', ''),
    meta_verify_token: getSetting('meta_verify_token', 'antigravity_meta_wa_secret'),
    meta_business_phone: getSetting('meta_business_phone', '')
  };
  const fonnteSettings = {
    fonnte_token: getSetting('fonnte_token', ''),
    fonnte_api_url: getSetting('fonnte_api_url', 'https://api.fonnte.com/send'),
    fonnte_country_code: getSetting('fonnte_country_code', '62')
  };

  const whatsappAiMode = getSetting('whatsapp_ai_enabled', 'admin_only');

  res.render('admin/whatsapp', {
    title: 'Status WhatsApp',
    company: company(),
    activePage: 'whatsapp',
    msg: flashMsg(req),
    waGatewayType,
    metaSettings,
    fonnteSettings,
    whatsappAiMode,
    host: req.get('host') || 'localhost:3001'
  });
});

router.post('/whatsapp/gateway-settings', requireAdminSession, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const {
      wa_gateway_type,
      meta_phone_number_id,
      meta_waba_id,
      meta_access_token,
      meta_verify_token,
      meta_business_phone,
      fonnte_token,
      fonnte_api_url,
      fonnte_country_code
    } = req.body;

    saveSettings({
      wa_gateway_type: wa_gateway_type || 'baileys',
      meta_phone_number_id: String(meta_phone_number_id || '').trim(),
      meta_waba_id: String(meta_waba_id || '').trim(),
      meta_access_token: String(meta_access_token || '').trim(),
      meta_verify_token: String(meta_verify_token || '').trim() || 'antigravity_meta_wa_secret',
      meta_business_phone: String(meta_business_phone || '').trim(),
      fonnte_token: String(fonnte_token || '').trim(),
      fonnte_api_url: String(fonnte_api_url || 'https://api.fonnte.com/send').trim(),
      fonnte_country_code: String(fonnte_country_code || '62').trim()
    });

    if ((wa_gateway_type || 'baileys') === 'baileys') {
      import('../services/whatsappBot.mjs').then(m => m.startWhatsAppBot()).catch(e => {
        logger.error('Failed to start Baileys bot on gateway change: ' + e.message);
      });
    }

    req.session._msg = { type: 'success', text: 'Pengaturan WhatsApp Gateway (Baileys / Fonnte / Meta) berhasil disimpan.' };
  } catch (e) {
    req.session._msg = { type: 'danger', text: 'Gagal menyimpan pengaturan: ' + e.message };
  }
  res.redirect('/admin/whatsapp');
});

router.post('/whatsapp/ai-settings', requireAdminSession, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const { whatsapp_ai_enabled } = req.body;
    let mode = 'admin_only';
    if (whatsapp_ai_enabled === 'true') mode = true;
    else if (whatsapp_ai_enabled === 'false') mode = false;
    else mode = 'admin_only';

    saveSettings({ whatsapp_ai_enabled: mode });

    req.session._msg = {
      type: 'success',
      text: mode === 'admin_only'
        ? 'Pengaturan Bot AI berhasil disimpan: Khusus Admin Saja (Pelanggan tidak diganggu AI).'
        : (mode === true ? 'Pengaturan Bot AI berhasil disimpan: Aktif untuk Semua Pengguna (Admin & Pelanggan).' : 'Pengaturan Bot AI berhasil disimpan: Nonaktif Sepenuhnya.')
    };
  } catch (err) {
    req.session._msg = { type: 'danger', text: 'Gagal menyimpan pengaturan AI: ' + err.message };
  }
  res.redirect('/admin/whatsapp');
});

router.post('/whatsapp/test-fonnte', requireAdminSession, express.json(), async (req, res) => {
  try {
    const { phone, message } = req.body;
    if (!phone) return res.status(400).json({ success: false, error: 'Nomor HP tujuan wajib diisi.' });

    const fonnteSvc = require('../services/fonnteWhatsappService');
    const result = await fonnteSvc.testFonnteConnection(phone, message);
    res.json({ success: true, message: 'Pesan berhasil dikirim via Fonnte Gateway!', data: result });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// LIVE CHAT ROUTES
router.get('/whatsapp/live-chat', requireAdminSession, requireSidebarMenuAccess('whatsapp'), async (req, res) => {
  const waGatewayType = getSetting('wa_gateway_type', 'baileys');
  const customers = customerSvc.getAllCustomers();
  res.render('admin/whatsapp_live_chat', {
    title: 'Live Chat WhatsApp',
    company: company(),
    activePage: 'whatsapp_live_chat',
    msg: flashMsg(req),
    gatewayType: waGatewayType,
    customers: customers || []
  });
});

router.get('/api/whatsapp/conversations', requireAdminSession, (req, res) => {
  try {
    const list = waSvc.getRecentConversations(50);
    res.json({ ok: true, conversations: list });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get('/api/whatsapp/messages', requireAdminSession, (req, res) => {
  try {
    const phone = req.query.phone || '';
    const list = waSvc.getChatHistory(phone, 100);
    res.json({ ok: true, messages: list });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* === AWAL PERUBAHAN: SEND-DIRECT DENGAN AUTO READ RECEIPT & ENDPOINT MARK-READ === */
router.post('/api/whatsapp/send-direct', requireAdminSession, express.json(), async (req, res) => {
  try {
    const { phone, message } = req.body;
    if (!phone || !message) return res.status(400).json({ success: false, error: 'Nomor dan pesan tidak boleh kosong' });

    // 1. Kirim pesan balasan dari admin
    await waSvc.sendWhatsAppMessage(phone, message);

    // 2. OTOMATIS: Begitu admin membalas, tandai semua chat lawan bicara sebagai SUDAH DIBACA (Centang Biru di WA Asli)
    try {
      const { markChatAsRead } = await import('../services/whatsappBot.mjs');
      if (typeof markChatAsRead === 'function') {
        markChatAsRead(phone).catch(() => {});
      }
    } catch (_) {}

    res.json({ success: true, message: 'Pesan WhatsApp terkirim' });
  } catch (e) {
    const errorText = e?.message || (typeof e === 'string' ? e : JSON.stringify(e));
    res.status(500).json({ success: false, error: errorText });
  }
});

// Endpoint untuk menandai chat sudah dibaca saat obrolan dibuka di Live Chat
router.post('/api/whatsapp/mark-read', requireAdminSession, express.json(), async (req, res) => {
  try {
    const phone = String(req.body.phone || '').trim();
    if (!phone) return res.status(400).json({ success: false, error: 'Nomor telepon wajib diisi' });

    const { markChatAsRead } = await import('../services/whatsappBot.mjs');
    if (typeof markChatAsRead === 'function') {
      await markChatAsRead(phone);
    }

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});
/* === AKHIR PERUBAHAN === */

/* === AWAL PERUBAHAN: API HAPUS PESAN SATUAN, PER ORANG & SEMUA CHAT === */
// 1. Hapus pesan satu-satu
router.post('/api/whatsapp/messages/:id/delete', requireAdminSession, (req, res) => {
  try {
    const msgId = Number(req.params.id);
    if (!msgId) return res.status(400).json({ success: false, error: 'ID pesan tidak valid' });

    db.prepare('DELETE FROM wa_chat_messages WHERE id = ?').run(msgId);
    res.json({ success: true, message: 'Pesan berhasil dihapus' });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 2. Hapus percakapan per orang (berdasarkan nomor HP)
router.post('/api/whatsapp/conversations/delete', requireAdminSession, express.json(), (req, res) => {
  try {
    const phone = String(req.body.phone || '').trim();
    if (!phone) return res.status(400).json({ success: false, error: 'Nomor HP tidak valid' });

    const normalized = phone.replace(/\D/g, '');
    const last8 = normalized.slice(-8);

    db.prepare(`
      DELETE FROM wa_chat_messages 
      WHERE sender_phone LIKE ? OR recipient_phone LIKE ? OR sender_phone LIKE ? OR recipient_phone LIKE ?
    `).run(`%${last8}%`, `%${last8}%`, `%${normalized}%`, `%${normalized}%`);

    res.json({ success: true, message: 'Percakapan berhasil dihapus' });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 3. Hapus SEMUA percakapan dari semua orang sekaligus
router.post('/api/whatsapp/conversations/clear-all', requireAdminSession, restrictToAdmin, (req, res) => {
  try {
    db.prepare('DELETE FROM wa_chat_messages').run();
    res.json({ success: true, message: 'Semua riwayat percakapan berhasil dibersihkan' });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});
/* === AKHIR PERUBAHAN: API HAPUS PESAN SATUAN, PER ORANG & SEMUA CHAT === */

// VOICE AI ASSISTANT (TALK-TO-SPEECH) ROUTES
router.get('/voice-assistant', requireAdminSession, requireSidebarMenuAccess('voice_assistant'), (req, res) => {
  res.render('admin/voice_assistant', {
    title: 'Voice AI Assistant',
    company: company(),
    activePage: 'voice_assistant',
    adminName: req.session.adminUser?.name || 'Administrator',
    msg: flashMsg(req)
  });
});

router.post('/api/voice-assistant/ask', requireAdminSession, express.json(), async (req, res) => {
  try {
    const rawQuestion = String(req.body.message || '').trim();
    if (!rawQuestion) {
      return res.status(400).json({ ok: false, error: 'Pesan suara atau teks tidak boleh kosong.' });
    }

    const senderName = req.session.adminUser?.name || 'Admin';
    const answer = await telegramAi.askAi({
      question: rawQuestion,
      senderName,
      isAdmin: true,
      extraContext: {
        phone: req.session.adminUser?.phone || '',
        req
      }
    });

    const cleanDisplay = typeof telegramAi.cleanAiResponse === 'function' ? telegramAi.cleanAiResponse(answer) : answer;
    const speechText = voiceTts.cleanTextForSpeech(cleanDisplay);

    res.json({
      ok: true,
      text: cleanDisplay,
      speechText
    });
  } catch (err) {
    logger.error('[VoiceAssistant] Error: ' + err.message);
    res.status(500).json({ ok: false, error: err.message || 'Gagal memproses AI' });
  }
});

router.get('/api/voice-assistant/tts', requireAdminSession, async (req, res) => {
  try {
    const text = String(req.query.text || '').trim();
    if (!text) {
      return res.status(400).send('Teks kosong');
    }

    const audioBuffer = await voiceTts.generateIndonesianSpeech(text);
    if (!audioBuffer) {
      return res.status(500).send('Gagal membuat audio');
    }

    res.set({
      'Content-Type': 'audio/mpeg',
      'Content-Length': audioBuffer.length,
      'Cache-Control': 'public, max-age=86400'
    });
    res.send(audioBuffer);
  } catch (err) {
    logger.error('[VoiceTTS Route] Error: ' + err.message);
    res.status(500).send('Error generate TTS: ' + err.message);
  }
});

router.get('/api/soundbox/poll', requireAdminSession, (req, res) => {
  try {
    const soundboxSvc = require('../services/soundboxService');
    const afterId = Number(req.query.afterId || 0);
    const events = soundboxSvc.getLatestEvents(afterId, 15);
    res.json({ success: true, events });
  } catch (err) {
    logger.error('[Soundbox Route] Poll error: ' + err.message);
    res.status(500).json({ success: false, message: err.message, events: [] });
  }
});

/* >>> AWAL KODE BARU: ENDPOINT RINGKASAN NOTIFIKASI ADMIN (BELL DROPDOWN) <<< */
router.get('/api/notifications/summary', requireAdminSession, async (req, res) => {
  try {
    const items = [];

    // 1. Live Chat Baru (Pesan Masuk Belum Dibaca)
    try {
      const unreadChat = db.prepare(`
        SELECT COUNT(1) as cnt 
        FROM wa_chat_messages 
        WHERE direction = 'inbound' AND status != 'read'
      `).get();
      const chatCount = Number(unreadChat?.cnt || 0);
      if (chatCount > 0) {
        items.push({
          type: 'chat',
          title: 'Live Chat WhatsApp',
          desc: `${chatCount} pesan baru belum dibaca`,
          count: chatCount,
          url: '/admin/whatsapp/live-chat',
          icon: 'bi-chat-dots-fill',
          color: '#10b981' // Hijau Emerald
        });
      }
    } catch (_) {}

    // 2. Tiket Gangguan / Keluhan Pelanggan Baru (Status Open / Pending)
    try {
      const openTickets = db.prepare(`
        SELECT COUNT(1) as cnt 
        FROM tickets 
        WHERE status IN ('open', 'pending')
      `).get();
      const ticketCount = Number(openTickets?.cnt || 0);
      if (ticketCount > 0) {
        items.push({
          type: 'ticket',
          title: 'Tiket Gangguan Pelanggan',
          desc: `${ticketCount} keluhan aktif butuh penanganan`,
          count: ticketCount,
          url: '/admin/tickets',
          icon: 'bi-exclamation-octagon-fill',
          color: '#ef4444' // Merah
        });
      }
    } catch (_) {}

    // 3. Pendaftaran Pasang Baru (Status Pending)
    try {
      const pendingReg = db.prepare(`
        SELECT COUNT(1) as cnt 
        FROM registrations 
        WHERE status = 'pending'
      `).get();
      const regCount = Number(pendingReg?.cnt || 0);
      if (regCount > 0) {
        items.push({
          type: 'registration',
          title: 'Pendaftaran Pasang Baru',
          desc: `${regCount} calon pelanggan baru menunggu teknisi`,
          count: regCount,
          url: '/admin/technicians?tab=registrations',
          icon: 'bi-person-plus-fill',
          color: '#3b82f6' // Biru
        });
      }
    } catch (_) {}

    // 4. Pembayaran Masuk Hari Ini (Hanya Menghitung yang Belum Dilihat Admin)
    try {
      const lastSeenInvId = Number(req.query.last_seen_invoice_id || 0);

      // Hitung hanya invoice paid hari ini yang ID-nya lebih besar dari yang sudah dilihat admin
      const newInvoices = db.prepare(`
        SELECT COUNT(1) as cnt, COALESCE(SUM(amount), 0) as total, MAX(id) as max_id
        FROM invoices 
        WHERE status = 'paid' 
          AND date(paid_at) = date(NOW_LOCAL())
          AND id > ?
      `).get(lastSeenInvId);

      const invCount = Number(newInvoices?.cnt || 0);

      if (invCount > 0) {
        // Ambil transaksi pembayaran lunas TERAKHIR yang baru masuk
        const lastPaid = db.prepare(`
          SELECT i.id, i.amount, i.paid_at, c.name as customer_name, c.phone as customer_phone
          FROM invoices i
          JOIN customers c ON i.customer_id = c.id
          WHERE i.status = 'paid' AND date(i.paid_at) = date(NOW_LOCAL()) AND i.id > ?
          ORDER BY datetime(i.paid_at) DESC, i.id DESC
          LIMIT 1
        `).get(lastSeenInvId);

        const latestName = lastPaid ? lastPaid.customer_name : '';
        const latestAmount = lastPaid ? Number(lastPaid.amount || 0).toLocaleString('id-ID') : '0';
        const latestId = lastPaid ? lastPaid.id : (newInvoices.max_id || 0);

        let descText = '';
        if (invCount === 1) {
          descText = `${latestName} (Rp ${latestAmount})`;
        } else {
          descText = `${latestName} & ${invCount - 1} lainnya (Rp ${latestAmount})`;
        }

        const targetUrl = latestName 
          ? `/admin/billing?status=paid&search=${encodeURIComponent(latestName)}` 
          : `/admin/billing?status=paid`;

        items.push({
          type: 'payment_invoice',
          title: 'Pembayaran Lunas Baru',
          desc: descText,
          count: invCount,
          latestId: latestId, // Kirim ID terbaru agar frontend bisa mencatatnya
          url: targetUrl,
          icon: 'bi-check-circle-fill',
          color: '#059669' // Hijau Emerald
        });
      }
    } catch (_) {}

    // 5. Pembelian Voucher Hotspot Online Hari Ini (Langsung Menampilkan Pembeli Terakhir)
    try {
      const todayVouchers = db.prepare(`
        SELECT COUNT(1) as cnt, COALESCE(SUM(price), 0) as total 
        FROM public_voucher_orders 
        WHERE status IN ('paid', 'fulfilled') AND date(paid_at) = date(NOW_LOCAL())
      `).get();
      const vcCount = Number(todayVouchers?.cnt || 0);

      if (vcCount > 0) {
        const lastVc = db.prepare(`
          SELECT id, buyer_phone, voucher_code, profile_name, price 
          FROM public_voucher_orders 
          WHERE status IN ('paid', 'fulfilled') AND date(paid_at) = date(NOW_LOCAL())
          ORDER BY id DESC LIMIT 1
        `).get();

        const buyerPhone = lastVc ? lastVc.buyer_phone : '';
        const vcTargetUrl = buyerPhone 
          ? `/admin/vouchers/orders?q=${encodeURIComponent(buyerPhone)}`
          : `/admin/vouchers/orders`;

        items.push({
          type: 'payment_voucher',
          title: 'Voucher QRIS Terjual',
          desc: lastVc ? `${buyerPhone} (${lastVc.profile_name})` : `${vcCount} voucher terjual`,
          count: vcCount,
          url: vcTargetUrl,
          icon: 'bi-qr-code-scan',
          color: '#8b5cf6' // Ungu
        });
      }
    } catch (_) {}

    // 6. Request Tagihan Masuk dari Kolektor (Pending Approval)
    try {
      const pendingCollector = db.prepare(`
        SELECT COUNT(1) as cnt 
        FROM collector_payment_requests 
        WHERE status = 'pending'
      `).get();
      const colCount = Number(pendingCollector?.cnt || 0);
      if (colCount > 0) {
        items.push({
          type: 'collector_request',
          title: 'Approval Setoran Kolektor',
          desc: `${colCount} setoran tagihan menunggu konfirmasi`,
          count: colCount,
          url: '/admin/collector-payments',
          icon: 'bi-cash-coin',
          color: '#f59e0b' // Kuning Amber
        });
      }
    } catch (_) {}

    // 7. Perangkat Offline & Redaman Tinggi (Cek Cepat dari OLT Cache)
    try {
      const allActiveOlts = oltSvc.getActiveOlts() || [];
      let totalOfflineOnus = 0;
      let totalWeakOnus = 0;

      for (const olt of allActiveOlts) {
        // Ambil data OLT cepat (memakai cache getOltStats tanpa beban CPU)
        const stats = await oltSvc.getOltStats(olt.id, false).catch(() => null);
        if (stats) {
          totalOfflineOnus += Number(stats.onus_offline || 0);
          totalWeakOnus += Number(stats.onus_weak || 0);
        }
      }

      if (totalOfflineOnus > 0) {
        items.push({
          type: 'onu_offline',
          title: 'Modem / ONU Terputus',
          desc: `${totalOfflineOnus} modem terpantau offline`,
          count: totalOfflineOnus,
          url: '/admin/onu-provision',
          icon: 'bi-router-fill',
          color: '#dc2626' // Merah Gelap
        });
      }

      if (totalWeakOnus > 0) {
        items.push({
          type: 'onu_optical',
          title: 'Redaman Optik Buruk',
          desc: `${totalWeakOnus} modem sinyal RX < -27 dBm`,
          count: totalWeakOnus,
          url: '/admin/olts',
          icon: 'bi-reception-1',
          color: '#ea580c' // Oranye
        });
      }
    } catch (_) {}

    // Hitung total akumulasi angka notifikasi
    const totalCount = items.reduce((acc, curr) => acc + (curr.count || 1), 0);

    return res.json({
      success: true,
      total: totalCount,
      items
    });
  } catch (err) {
    logger.error('[API Notification] Error: ' + err.message);
    return res.status(500).json({ success: false, total: 0, items: [] });
  }
});
/* ========================================================================= */

router.post('/api/soundbox/test', requireAdminSession, (req, res) => {
  try {
    const soundboxSvc = require('../services/soundboxService');
    const customText = req.body?.speechText;
    const amount = Number(req.body?.amount || 50000);
    const id = soundboxSvc.queueSoundboxEvent({
      type: 'test',
      title: 'Uji Suara Kasir',
      speechText: customText || ('Uji coba speaker kasir berhasil. Pembayaran sebesar ' + soundboxSvc.formatRupiahSpoken(amount) + ' diterima.'),
      amount,
      customerName: 'Admin Soundbox'
    });
    res.json({ success: true, eventId: id });
  } catch (err) {
    logger.error('[Soundbox Route] Test error: ' + err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

//skrip baru

router.get('/whatsapp/templates', requireAdminSession, requireSidebarMenuAccess('whatsapp'), async (req, res) => {
  const comp = company();
  const defaultAutoBilling = `Yth. Pelanggan {{nama}},\n\nIni adalah pengingat sebelum tanggal jatuh tempo/isolir.\n\n📦 *Paket:* {{paket}}\n💰 *Total Tagihan:* Rp {{tagihan}}\n📅 *Periode:* {{rincian}}\n\nMohon segera melakukan pembayaran melalui portal pelanggan: {{link}}\n\nTerima kasih atas kerja samanya.\nSalam,\nAdmin ${comp}`;
  
  const defaultQris = `Yth. Pelanggan {{nama}},\n\nBerikut rincian tagihan manual + Kode Bayar QRIS Anda:\n\n📦 *Paket:* {{paket}}\n📅 *Periode:* {{periode}}\n💰 *Nominal:* Rp {{qris_nominal}}\n\nSilakan scan QRIS berikut untuk melakukan pembayaran otomatis:\n{{qris_qr}}\n\nTerima kasih.`;

  const defaultSuccess = whatsappService.DEFAULT_PAYMENT_SUCCESS_TEMPLATE;

  const defaultIsolir = `Yth. Pelanggan {{nama}},\n\nLayanan internet Anda (Paket {{paket}}) saat ini ditangguhkan (Terisolir) karena belum melunasi tagihan sebesar *Rp {{tagihan}}*.\n\nSilakan lakukan pembayaran segera melalui portal pelanggan: {{link}}\n\nTerima kasih.`;

  const defaultOfflineTmpl = 
`⚠️ *PERINGATAN: PERANGKAT OFFLINE*
Total: {{total_offline}} Perangkat (> {{threshold_jam}} Jam)

{{daftar_perangkat}}
Mohon tim teknisi segera melakukan pengecekan lapangan.
_Sistem Monitoring {{company}}_`;

  const defaultRedamanTmpl = 
`🚨 *PERINGATAN: REDAMAN TINGGI (DROP RX)*
Total: {{total_redaman}} Perangkat (Drop < {{threshold}} dBm)

{{daftar_perangkat}}
Mohon segera diperiksa redaman / kabel optiknya.
_Sistem Monitoring {{company}}_`;

  // === AWAL PENYESUAIAN FALLBACK TEMPLATE PENDAFTARAN ===
  const defaultRegAdmin = whatsappService.DEFAULT_REG_ADMIN_TEMPLATE;
  const defaultRegTech = whatsappService.DEFAULT_REG_TECH_TEMPLATE;
  const defaultRegWelcome = whatsappService.DEFAULT_REG_WELCOME_TEMPLATE;
  const defaultRegReject = whatsappService.DEFAULT_REG_REJECT_TEMPLATE;

  // === AWAL DEFAULT TEMPLATE TAMBAHAN TERPUSAT ===
  const defaultPdfCaption = whatsappService.DEFAULT_INVOICE_PDF_CAPTION_TEMPLATE;
  const defaultWifiSsid = whatsappService.DEFAULT_WIFI_SSID_CHANGED_TEMPLATE;
  const defaultWifiPass = whatsappService.DEFAULT_WIFI_PASS_CHANGED_TEMPLATE;
  const defaultVoucherResend = whatsappService.DEFAULT_VOUCHER_RESEND_TEMPLATE;
  const defaultTicketResolved = whatsappService.DEFAULT_TICKET_RESOLVED_TEMPLATE;
  const defaultPayrollSlip = whatsappService.DEFAULT_PAYROLL_SLIP_TEMPLATE;
  const defaultTestNotif = whatsappService.DEFAULT_TEST_NOTIF_TEMPLATE;
  // === AKHIR DEFAULT TEMPLATE TAMBAHAN TERPUSAT ===

  const templates = {
    whatsapp_auto_billing_message: db.getAppSetting('whatsapp_auto_billing_message', defaultAutoBilling),
    whatsapp_billing_qris_message: db.getAppSetting('whatsapp_billing_qris_message', defaultQris),
	// === AWAL TAMBAHAN: PARAMETER THRESHOLD & INTERVAL MONITORING ===
    genieacs_offline_threshold_hours: getSetting('genieacs_offline_threshold_hours', 24),
    genieacs_rxpower_threshold: getSetting('genieacs_rxpower_threshold', -27),
    genieacs_monitoring_interval_hours: getSetting('genieacs_monitoring_interval_hours', 6),
    // === AKHIR TAMBAHAN: PARAMETER THRESHOLD & INTERVAL MONITORING ===
    whatsapp_payment_success_message: db.getAppSetting('whatsapp_payment_success_message', defaultSuccess),
    whatsapp_isolir_message: db.getAppSetting('whatsapp_isolir_message', defaultIsolir),
    whatsapp_device_offline_message: db.getAppSetting('whatsapp_device_offline_message', defaultOfflineTmpl),
    whatsapp_device_rxpower_message: db.getAppSetting('whatsapp_device_rxpower_message', defaultRedamanTmpl),
    whatsapp_reg_admin_template: db.getAppSetting('whatsapp_reg_admin_template', defaultRegAdmin) || defaultRegAdmin,
    whatsapp_reg_tech_template: db.getAppSetting('whatsapp_reg_tech_template', defaultRegTech) || defaultRegTech,
    whatsapp_reg_welcome_template: db.getAppSetting('whatsapp_reg_welcome_template', defaultRegWelcome) || defaultRegWelcome,
    whatsapp_reg_reject_template: db.getAppSetting('whatsapp_reg_reject_template', defaultRegReject) || defaultRegReject,
    // Template Terpusat Baru:
    whatsapp_invoice_pdf_caption_template: db.getAppSetting('whatsapp_invoice_pdf_caption_template', defaultPdfCaption) || defaultPdfCaption,
    whatsapp_wifi_ssid_changed_template: db.getAppSetting('whatsapp_wifi_ssid_changed_template', defaultWifiSsid) || defaultWifiSsid,
    whatsapp_wifi_pass_changed_template: db.getAppSetting('whatsapp_wifi_pass_changed_template', defaultWifiPass) || defaultWifiPass,
    whatsapp_voucher_resend_template: db.getAppSetting('whatsapp_voucher_resend_template', defaultVoucherResend) || defaultVoucherResend,
    whatsapp_ticket_resolved_template: db.getAppSetting('whatsapp_ticket_resolved_template', defaultTicketResolved) || defaultTicketResolved,
    whatsapp_payroll_slip_template: db.getAppSetting('whatsapp_payroll_slip_template', defaultPayrollSlip) || defaultPayrollSlip,
    whatsapp_test_notif_template: db.getAppSetting('whatsapp_test_notif_template', defaultTestNotif) || defaultTestNotif
  };
  // === AKHIR PENYESUAIAN FALLBACK TEMPLATE PENDAFTARAN ===

  const paymentSuccessEnabled = db.getAppSetting('whatsapp_payment_success_enabled', '1') === '1';
  const isolirNotifEnabled = db.getAppSetting('whatsapp_isolir_notif_enabled', '1') === '1';
  const monitoringAlertEnabled = getSetting('genieacs_monitoring_enabled', false) === true;

  res.render('admin/whatsapp_templates', {
    title: 'Template Pesan WhatsApp',
    company: comp,
    activePage: 'whatsapp',
    msg: flashMsg(req),
    templates,
    paymentSuccessEnabled,
    isolirNotifEnabled,
    monitoringAlertEnabled
  });
});

// === AMBIL FORMAT WA DARI TEMPLATE ===
router.post('/whatsapp/templates', requireAdminSession, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const {
      whatsapp_auto_billing_message,
      whatsapp_billing_qris_message,
      whatsapp_payment_success_message,
      whatsapp_isolir_message,
      whatsapp_device_offline_message,
      whatsapp_device_rxpower_message,
	  genieacs_offline_threshold_hours,
      genieacs_rxpower_threshold,
      genieacs_monitoring_interval_hours,
      whatsapp_reg_admin_template,
      whatsapp_reg_tech_template,
      whatsapp_reg_welcome_template,
      whatsapp_reg_reject_template,
      // === AWAL DESTRUCTURING TEMPLATE TAMBAHAN ===
      whatsapp_invoice_pdf_caption_template,
      whatsapp_wifi_ssid_changed_template,
      whatsapp_wifi_pass_changed_template,
      whatsapp_voucher_resend_template,
      whatsapp_ticket_resolved_template,
      whatsapp_payroll_slip_template,
      whatsapp_test_notif_template,
      // === AKHIR DESTRUCTURING TEMPLATE TAMBAHAN ===
      whatsapp_payment_success_enabled,
      whatsapp_isolir_notif_enabled,
      genieacs_monitoring_enabled
    } = req.body;

    db.saveAppSetting('whatsapp_auto_billing_message', whatsapp_auto_billing_message || '');
    db.saveAppSetting('whatsapp_billing_qris_message', whatsapp_billing_qris_message || '');
    db.saveAppSetting('whatsapp_payment_success_message', whatsapp_payment_success_message || '');
    db.saveAppSetting('whatsapp_isolir_message', whatsapp_isolir_message || '');
    db.saveAppSetting('whatsapp_device_offline_message', whatsapp_device_offline_message || '');
    db.saveAppSetting('whatsapp_device_rxpower_message', whatsapp_device_rxpower_message || '');

    db.saveAppSetting('whatsapp_reg_admin_template', whatsapp_reg_admin_template || '');
    db.saveAppSetting('whatsapp_reg_tech_template', whatsapp_reg_tech_template || '');
    db.saveAppSetting('whatsapp_reg_welcome_template', whatsapp_reg_welcome_template || '');
    db.saveAppSetting('whatsapp_reg_reject_template', whatsapp_reg_reject_template || '');

    // === AWAL SIMPAN TEMPLATE TAMBAHAN KE DATABASE ===
    db.saveAppSetting('whatsapp_invoice_pdf_caption_template', whatsapp_invoice_pdf_caption_template || '');
    db.saveAppSetting('whatsapp_wifi_ssid_changed_template', whatsapp_wifi_ssid_changed_template || '');
    db.saveAppSetting('whatsapp_wifi_pass_changed_template', whatsapp_wifi_pass_changed_template || '');
    db.saveAppSetting('whatsapp_voucher_resend_template', whatsapp_voucher_resend_template || '');
    db.saveAppSetting('whatsapp_ticket_resolved_template', whatsapp_ticket_resolved_template || '');
    db.saveAppSetting('whatsapp_payroll_slip_template', whatsapp_payroll_slip_template || '');
    db.saveAppSetting('whatsapp_test_notif_template', whatsapp_test_notif_template || '');
    // === AKHIR SIMPAN TEMPLATE TAMBAHAN KE DATABASE ===


    db.saveAppSetting('whatsapp_payment_success_enabled', whatsapp_payment_success_enabled ? '1' : '0');
    db.saveAppSetting('whatsapp_isolir_notif_enabled', whatsapp_isolir_notif_enabled ? '1' : '0');
	
    // === AWAL PERUBAHAN: SIMPAN PENGATURAN MONITORING GENIEACS ===
    saveSettings({
      genieacs_monitoring_enabled: (genieacs_monitoring_enabled === '1' || genieacs_monitoring_enabled === 'on'),
      genieacs_offline_threshold_hours: parseInt(genieacs_offline_threshold_hours, 10) || 24,
      genieacs_rxpower_threshold: parseFloat(genieacs_rxpower_threshold) || -27,
      genieacs_monitoring_interval_hours: parseInt(genieacs_monitoring_interval_hours, 10) || 6
    });
    // === AKHIR PERUBAHAN: SIMPAN PENGATURAN MONITORING GENIEACS ===

    req.session._msg = { type: 'success', text: 'Semua template dan status saklar WhatsApp berhasil disimpan.' };
  } catch (e) {
    req.session._msg = { type: 'danger', text: 'Gagal menyimpan template: ' + e.message };
  }
  res.redirect('/admin/whatsapp/templates');
});

//batas skrip baru

router.get('/whatsapp/broadcast', requireAdminSession, requireSidebarMenuAccess('broadcast'), (req, res) => {
  const comp = company();
  const defaultAutoBillingMsg =
    `Yth. Pelanggan {{nama}},\n\n` +
    `Ini adalah pengingat sebelum tanggal jatuh tempo/isolir.\n\n` +
    `📦 *Paket:* {{paket}}\n` +
    `💰 *Total Tagihan:* Rp {{tagihan}}\n` +
    `📅 *Periode:* {{rincian}}\n\n` +
    `Mohon segera melakukan pembayaran melalui portal pelanggan: {{link}}\n\n` +
    `Terima kasih atas kerja samanya.\n` +
    `Salam,\nAdmin ${comp}`;
  const autoBillingMsg = db.getAppSetting('whatsapp_auto_billing_message', defaultAutoBillingMsg);

  res.render('admin/broadcast', {
    title: 'Broadcast WhatsApp', company: comp, activePage: 'broadcast', msg: flashMsg(req),
    broadcastStatus: global.broadcastStatus, getSetting, autoBillingMsg
  });
});

router.get('/api/whatsapp/broadcast-status', requireAdminSession, (req, res) => {
  res.json(global.broadcastStatus);
});

// API: Pause Broadcast
router.post('/api/whatsapp/broadcast-pause', requireAdminSession, (req, res) => {
  if (!global.broadcastStatus.active) {
    return res.json({ ok: false, error: 'Tidak ada broadcast yang sedang berjalan.' });
  }
  global.broadcastStatus.paused = true;
  logger.info('[Broadcast] Broadcast dipause oleh admin.');
  res.json({ ok: true, message: 'Broadcast berhasil dipause.' });
});

// API: Resume Broadcast
router.post('/api/whatsapp/broadcast-resume', requireAdminSession, (req, res) => {
  if (!global.broadcastStatus.active) {
    return res.json({ ok: false, error: 'Tidak ada broadcast yang sedang berjalan.' });
  }
  global.broadcastStatus.paused = false;
  logger.info('[Broadcast] Broadcast dilanjutkan oleh admin.');
  res.json({ ok: true, message: 'Broadcast berhasil dilanjutkan.' });
});

// API: Stop Broadcast
router.post('/api/whatsapp/broadcast-stop', requireAdminSession, (req, res) => {
  if (!global.broadcastStatus.active) {
    return res.json({ ok: false, error: 'Tidak ada broadcast yang sedang berjalan.' });
  }
  global.broadcastStatus.stopped = true;
  global.broadcastStatus.paused = false;
  logger.info('[Broadcast] Broadcast dihentikan oleh admin.');
  res.json({ ok: true, message: 'Broadcast berhasil dihentikan.' });
});

router.post('/whatsapp/broadcast', requireAdminSession, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const { target, message, delay: customDelay, batchSize: customBatchSize, hourlyLimit: customHourlyLimit } = req.body;
    if (!message) throw new Error('Pesan tidak boleh kosong');
    
    // Smart Rate Limit Settings
    const baseDelayMs = (parseInt(customDelay) || getSetting('whatsapp_broadcast_delay', 5)) * 1000; // Default 5 detik
    const batchSize = parseInt(customBatchSize) || 15; // Default 15 pesan per batch (lebih aman)
    const batchPauseMs = 120000; // Pause 2 menit setelah setiap batch (lebih aman)
    const hourlyLimit = parseInt(customHourlyLimit) || 80; // Default 80 pesan per jam (lebih aman)
    
    if (customDelay) {
      const v = parseInt(customDelay);
      if (Number.isFinite(v) && v >= 1 && v <= 60) {
        saveSettings({ whatsapp_broadcast_delay: v });
      }
    }

    if (global.broadcastStatus.active) {
      throw new Error('Ada proses broadcast yang sedang berjalan. Silakan tunggu hingga selesai.');
    }

    let customers = [];
    const allCust = customerSvc.getAllCustomers();
    
    if (target === 'all') {
      customers = allCust;
    } else if (target === 'active') {
      customers = allCust.filter(c => c.status === 'active');
    } else if (target === 'suspended') {
      customers = allCust.filter(c => c.status === 'suspended');
    } else if (target === 'unpaid') {
      customers = allCust.filter(c => c.unpaid_count > 0);
    }

    // Ambil pelanggan unik berdasarkan nomor HP
    const uniqueCustomers = [];
    const seenPhones = new Set();
    for (const c of customers) {
      if (c.phone && c.phone.length > 8 && !seenPhones.has(c.phone)) {
        uniqueCustomers.push(c);
        seenPhones.add(c.phone);
      }
    }

    if (uniqueCustomers.length === 0) {
      throw new Error('Tidak ada nomor pelanggan yang valid untuk target tersebut.');
    }
    
    // Initialize Tracker dengan Smart Rate Limit
    global.broadcastStatus = {
      active: true,
      total: uniqueCustomers.length,
      sent: 0,
      failed: 0,
      startTime: new Date(),
      paused: false,
      stopped: false,
      currentBatch: 0,
      messagesPerHour: 0,
      hourlyLimit: hourlyLimit
    };

    const sendMessageAsync = async () => {
      let batchCount = 0;
      let windowStartTime = Date.now();
      let messagesInCurrentHour = 0;

      for (let i = 0; i < uniqueCustomers.length; i++) {
        if (global.broadcastStatus.stopped) {
          logger.info('[Broadcast] Dihentikan oleh admin.');
          break;
        }

        while (global.broadcastStatus.paused) {
          await new Promise(r => setTimeout(r, 1000));
          if (global.broadcastStatus.stopped) break;
        }
        if (global.broadcastStatus.stopped) break;

        // Rate Limiting: Cek batas per jam
        const now = Date.now();
        if (now - windowStartTime >= 3600000) {
          windowStartTime = now;
          messagesInCurrentHour = 0;
          global.broadcastStatus.messagesPerHour = 0;
        }

        if (messagesInCurrentHour >= hourlyLimit) {
          const waitTimeMs = 3600000 - (now - windowStartTime);
          logger.info(`[Broadcast] Batas per jam tercapai (${hourlyLimit} pesan). Menunggu ${Math.ceil(waitTimeMs / 60000)} menit...`);
          await new Promise(r => setTimeout(r, waitTimeMs));
          windowStartTime = Date.now();
          messagesInCurrentHour = 0;
          global.broadcastStatus.messagesPerHour = 0;
        }

        const cust = uniqueCustomers[i];
        let attemptCount = 0;
        const maxAttempts = 3;

        while (attemptCount < maxAttempts) {
          try {
            // Smart Random Delay
            const randomDelay = getRandomDelay(baseDelayMs, 2000);
            await new Promise(r => setTimeout(r, randomDelay));

            // Format Pesan dengan Spintax
            let formattedMsg = message.replace(/{{nama}}/gi, cust.name || 'Pelanggan');

            const { parseSpintax } = await import('../services/whatsappBot.mjs');
            formattedMsg = parseSpintax(formattedMsg);
            formattedMsg = addMessageVariation(formattedMsg, i);

            await waSvc.sendWhatsAppMessage(cust.phone, formattedMsg);
            global.broadcastStatus.sent++;
            messagesInCurrentHour++;
            global.broadcastStatus.messagesPerHour = messagesInCurrentHour;
            batchCount++;
            
            // Batch Processing: Pause setelah N pesan
            if (batchCount >= batchSize && i < uniqueCustomers.length - 1) {
              logger.info(`[Broadcast] Selesai batch ${global.broadcastStatus.currentBatch + 1} (${batchSize} pesan). Pause ${Math.floor(batchPauseMs / 1000)} detik...`);
              global.broadcastStatus.currentBatch++;
              await new Promise(r => setTimeout(r, batchPauseMs));
              batchCount = 0;
            }
            
            break; // Sukses, keluar dari retry loop
          } catch (e) {
            attemptCount++;
            const errorMsg = e.message || e.toString();
            
            // Cek apakah error permanent (tidak perlu retry)
            if (isPermanentError(errorMsg)) {
              logger.warn(`[Broadcast] SKIP: Error permanent untuk ${cust.phone} - ${errorMsg}`);
              global.broadcastStatus.failed++;
              break; // Skip retry langsung ke pelanggan berikutnya
            }
            
            // Error temporary, bisa retry
            logger.error(`[Broadcast] Gagal kirim ke ${cust.phone} (attempt ${attemptCount}/${maxAttempts}): ${errorMsg}`);
            
            if (attemptCount >= maxAttempts) {
              logger.warn(`[Broadcast] Max attempts tercapai untuk ${cust.phone}`);
              global.broadcastStatus.failed++;
            } else {
              // Exponential backoff untuk retry
              const backoffDelay = getBackoffDelay(attemptCount);
              logger.info(`[Broadcast] Retry ke ${cust.phone} dalam ${Math.floor(backoffDelay / 1000)} detik...`);
              await new Promise(r => setTimeout(r, backoffDelay));
            }
          }
        }
      }
      
      global.broadcastStatus.active = false;
      logger.info(`[Broadcast] Selesai. Terkirim: ${global.broadcastStatus.sent}, Gagal: ${global.broadcastStatus.failed}`);
    };
    
    sendMessageAsync(); 

    req.session._msg = { type: 'success', text: `Broadcast sedang diproses untuk dikirim ke ${uniqueCustomers.length} pelanggan dengan smart rate limit.` };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal Broadcast: ' + e.message };
  }
  res.redirect('/admin/whatsapp/broadcast');
});

router.post('/whatsapp/auto-billing', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    const enabled = req.body && req.body.enabled ? true : false;
    const billingEnabled = req.body && req.body.billing_enabled ? true : false;
    const delay = req.body && req.body.delay ? parseInt(req.body.delay) : null;
    const next = { whatsapp_auto_billing_enabled: enabled, whatsapp_billing_to_customer_enabled: billingEnabled };
    if (delay != null && Number.isFinite(delay) && delay >= 1 && delay <= 60) {
      next.whatsapp_broadcast_delay = delay;
    }
    const msg = req.body && typeof req.body.message === 'string' ? req.body.message.trim() : '';
    if (msg) {
      db.saveAppSetting('whatsapp_auto_billing_message', msg);
    }
    saveSettings(next);
    req.session._msg = { type: 'success', text: `Pengingat tagihan otomatis ${enabled ? 'diaktifkan' : 'dimatikan'}. Notifikasi tagihan ke pelanggan ${billingEnabled ? 'diaktifkan' : 'dimatikan'}.` };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal menyimpan pengaturan: ' + e.message };
  }
  res.redirect('/admin/whatsapp/broadcast');
});

router.get('/api/whatsapp/status', requireAdmin, async (req, res) => {
    try {
      const gatewayType = getSetting('wa_gateway_type', 'baileys');
      if (gatewayType === 'fonnte') {
        const token = getSetting('fonnte_token', '');
        res.json({
          connection: token ? 'open' : 'close',
          gateway: 'fonnte',
          user: { id: 'fonnte_gateway', name: 'Fonnte Gateway' },
          lastUpdate: new Date().toISOString()
        });
      } else if (gatewayType === 'meta') {
        const phoneId = getSetting('meta_phone_number_id', '');
        const token = getSetting('meta_access_token', '');
        res.json({ connection: (phoneId && token) ? 'open' : 'connecting', gateway: 'meta' });
      } else {
        const { whatsappStatus, startWhatsAppBot, isBotRunning } = await import('../services/whatsappBot.mjs');
        if (getSetting('whatsapp_enabled', true) && !isBotRunning() && whatsappStatus.connection !== 'open' && whatsappStatus.connection !== 'qr') {
          startWhatsAppBot().catch(err => logger.error('Auto start Baileys error: ' + err.message));
        }
        res.json(whatsappStatus);
      }
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

router.post('/whatsapp/test-notification', requireAdminSession, async (req, res) => {
  try {
    const waSvc = require('../services/whatsappService');
    const adminNumbers = getSetting('whatsapp_admin_numbers', []);
    const legacyNumbers = getSetting('admins', []);
    let adminPhone = getSetting('company_phone', '');
    if (Array.isArray(adminNumbers) && adminNumbers.length > 0) {
      adminPhone = adminNumbers[0];
    } else if (Array.isArray(legacyNumbers) && legacyNumbers.length > 0) {
      adminPhone = legacyNumbers[0];
    }
    if (!adminPhone) {
      throw new Error('Nomor WhatsApp admin belum dikonfigurasi di Pengaturan WhatsApp / Perusahaan.');
    }

    logger.info(`[WA Test] Mengirim test notifikasi ke nomor admin: ${adminPhone}`);
	//Ambil Pesan Dari Template
    const { formatTestNotif } = require('../services/whatsappService');
    const msg = formatTestNotif({
      time: getNowLocal()
    });
    const ok = await waSvc.sendWhatsAppMessage(adminPhone, msg);
    if (!ok) throw new Error('Gagal mengirim pesan test WhatsApp.');
    logger.info(`[WA Test] Test notifikasi sukses terkirim ke ${adminPhone}`);
    req.session._msg = { type: 'success', text: 'Test notifikasi WhatsApp berhasil dikirim ke ' + adminPhone };
  } catch (e) {
    logger.error(`[WA Test] Gagal mengirim test notifikasi: ${e.message}`);
    req.session._msg = { type: 'error', text: 'Gagal kirim test WhatsApp: ' + e.message };
  }
  res.redirect('/admin/whatsapp');
});

router.post('/whatsapp/reset', requireAdminSession, (req, res) => {
  try {
    const authFolder = getSetting('whatsapp_auth_folder', 'auth_info_baileys');
    const folderPath = path.resolve(__dirname, '..', authFolder);
    
    if (fs.existsSync(folderPath)) {
      fs.rmSync(folderPath, { recursive: true, force: true });
      logger.info(`[WA] Session reset by admin. Folder ${authFolder} deleted.`);
      
      // Trigger restart bot secara asinkron
      import('../services/whatsappBot.mjs').then(m => m.restartWhatsAppBot()).catch(e => {
        logger.error('Failed to trigger WA restart:', e.message);
      });

      req.session._msg = { text: 'Sesi WhatsApp berhasil dihapus. Bot sedang memulai ulang, silakan tunggu QR Code muncul.', type: 'success' };
    } else {
      req.session._msg = { text: 'Folder sesi tidak ditemukan atau sudah dihapus.', type: 'warning' };
    }
    res.redirect('/admin/whatsapp');
  } catch (e) {
    logger.error('Failed to reset WA session:', e.message);
    req.session._msg = { text: 'Gagal menghapus sesi: ' + e.message, type: 'danger' };
    res.redirect('/admin/whatsapp');
  }
});

router.post('/whatsapp/repair-keys', requireAdminSession, async (req, res) => {
  try {
    const { cleanStaleSessionKeys, restartWhatsAppBot } = await import('../services/whatsappBot.mjs');
    const cleaned = cleanStaleSessionKeys();
    await restartWhatsAppBot();
    req.session._msg = {
      text: `Berhasil membersihkan ${cleaned} cache session/pre-key usang. Bot Baileys telah di-refresh tanpa perlu scan QR ulang.`,
      type: 'success'
    };
    res.redirect('/admin/whatsapp');
  } catch (e) {
    logger.error('Failed to repair WA session keys:', e.message);
    req.session._msg = { text: 'Gagal memperbaiki session keys: ' + e.message, type: 'danger' };
    res.redirect('/admin/whatsapp');
  }
});

// ─── ROUTERS (MULTI-ROUTER) ──────────────────────────────────────────────────
router.get('/routers', requireAdminSession, requireSidebarMenuAccess('mikrotik'), (req, res) => {
  res.render('admin/routers', {
    title: 'Manajemen Router', company: company(), activePage: 'mikrotik',
    routers: mikrotikService.getAllRouters(), msg: flashMsg(req)
  });
});

// ─── PROMO SLIDES ─────────────────────────────────────────────────────────────
router.get('/promo-slides', requireAdminSession, requireSidebarMenuAccess('settings'), (req, res) => {
  try {
    const slides = db.prepare(`
      SELECT * FROM promo_slides 
      ORDER BY sort_order ASC, id ASC
    `).all();
    
    res.render('admin/promo_slides', {
      title: 'Manajemen Promo Slides',
      company: company(),
      activePage: 'promo_slides',
      slides: slides || [],
      msg: flashMsg(req)
    });
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
    res.redirect('/admin/settings');
  }
});

router.get('/api/promo-slides/:id', requireAdminSession, (req, res) => {
  try {
    const slide = db.prepare('SELECT * FROM promo_slides WHERE id = ?').get(Number(req.params.id));
    if (!slide) return res.status(404).json({ error: 'Slide tidak ditemukan' });
    res.json(slide);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/promo-slides', requireAdminSession, requireSidebarMenuAccess('settings'), promoUpload.single('image'), (req, res) => {
  try {
    const { title, description, url, open_in_new_tab, sort_order, start_date, end_date, is_active } = req.body;
    
    if (!req.file) throw new Error('Gambar harus diupload');
    
    const imagePath = `/uploads/promo_slides/${req.file.filename}`;
    
    db.prepare(`
      INSERT INTO promo_slides (title, description, image_path, url, open_in_new_tab, sort_order, start_date, end_date, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      String(title || '').trim(),
      String(description || '').trim(),
      imagePath,
      String(url || '').trim(),
      open_in_new_tab === 'on' ? 1 : 0,
      Number(sort_order) || 0,
      start_date || null,
      end_date || null,
      is_active === 'on' ? 1 : 0
    );
    
    req.session._msg = { type: 'success', text: 'Promo slide berhasil ditambahkan' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/promo-slides');
});

router.post('/promo-slides/:id/update', requireAdminSession, requireSidebarMenuAccess('settings'), promoUpload.single('image'), (req, res) => {
  try {
    const { title, description, url, open_in_new_tab, sort_order, start_date, end_date, is_active } = req.body;
    const slideId = Number(req.params.id);
    
    const slide = db.prepare('SELECT * FROM promo_slides WHERE id = ?').get(slideId);
    if (!slide) throw new Error('Slide tidak ditemukan');
    
    let imagePath = slide.image_path;
    let oldImagePath = null;
    
    if (req.file) {
      oldImagePath = slide.image_path;
      imagePath = `/uploads/promo_slides/${req.file.filename}`;
    }
    
    db.prepare(`
      UPDATE promo_slides SET 
        title = ?, description = ?, image_path = ?, url = ?, 
        open_in_new_tab = ?, sort_order = ?, start_date = ?, end_date = ?, is_active = ?,
        updated_at = NOW_LOCAL()
      WHERE id = ?
    `).run(
      String(title || '').trim(),
      String(description || '').trim(),
      imagePath,
      String(url || '').trim(),
      open_in_new_tab === 'on' ? 1 : 0,
      Number(sort_order) || 0,
      start_date || null,
      end_date || null,
      is_active === 'on' ? 1 : 0,
      slideId
    );
    
    // Cleanup old image file if new one was uploaded
    if (oldImagePath && oldImagePath !== imagePath) {
      const oldFilePath = path.resolve(__dirname, '..', 'public', oldImagePath);
      try {
        if (fs.existsSync(oldFilePath)) {
          fs.unlinkSync(oldFilePath);
          logger.info(`[PromoSlides] Deleted old image: ${oldFilePath}`);
        }
      } catch (err) {
        logger.warn(`[PromoSlides] Failed to delete old image: ${err.message}`);
        // Don't fail the request, just log warning
      }
    }
    
    req.session._msg = { type: 'success', text: 'Promo slide berhasil diperbarui' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/promo-slides');
});

router.post('/promo-slides/:id/delete', requireAdminSession, requireSidebarMenuAccess('settings'), (req, res) => {
  try {
    const slideId = Number(req.params.id);
    
    // Get slide data to retrieve image path for cleanup
    const slide = db.prepare('SELECT * FROM promo_slides WHERE id = ?').get(slideId);
    
    // Delete from database
    db.prepare('DELETE FROM promo_slides WHERE id = ?').run(slideId);
    
    // Cleanup image file
    if (slide && slide.image_path) {
      const filePath = path.resolve(__dirname, '..', 'public', slide.image_path);
      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
          logger.info(`[PromoSlides] Deleted image: ${filePath}`);
        }
      } catch (err) {
        logger.warn(`[PromoSlides] Failed to delete image: ${err.message}`);
        // Don't fail the request, just log warning
      }
    }
    
    req.session._msg = { type: 'success', text: 'Promo slide berhasil dihapus' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/promo-slides');
});

router.post('/routers', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    mikrotikService.createRouter(req.body);
    req.session._msg = { type: 'success', text: `Router "${req.body.name}" berhasil ditambahkan.` };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/routers');
});

router.post('/routers/:id/update', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    mikrotikService.updateRouter(req.params.id, req.body);
    req.session._msg = { type: 'success', text: 'Router berhasil diperbarui.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/routers');
});

router.post('/routers/:id/delete', requireAdminSession, (req, res) => {
  try {
    mikrotikService.deleteRouter(req.params.id);
    req.session._msg = { type: 'success', text: 'Router berhasil dihapus.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/routers');
});

router.get('/api/routers/:id/test', requireAdmin, async (req, res) => {
  try {
    const conn = await mikrotikService.getConnection(req.params.id);
    if (conn && conn.api) {
      conn.api.close();
      return res.json({ success: true, message: 'Koneksi ke Router Berhasil!' });
    }
    throw new Error('Gagal terhubung ke router');
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

router.get('/api/routers/:id/details', requireAdmin, async (req, res) => {
  try {
    const routerId = req.params.id;
    const routerConfig = mikrotikService.getRouterById(routerId);
    if (!routerConfig) return res.status(404).json({ success: false, error: 'Router tidak ditemukan' });

    let liveData = {
      connected: false,
      identity: routerConfig.name || 'MikroTik',
      version: '-',
      boardName: '-',
      cpuLoad: 0,
      freeMemory: 0,
      totalMemory: 0,
      freeHdd: 0,
      totalHdd: 0,
      uptime: '-',
      architecture: '-',
      cpuCount: 1,
      cpuFrequency: 0,
      activePppoe: 0,
      activeHotspot: 0,
      customersCount: 0,
      error: null
    };

    try {
      const allRouters = mikrotikService.getAllRouters();
      const firstRouter = allRouters && allRouters.length > 0 ? allRouters[0] : null;
      let countRes;
      if (firstRouter && Number(firstRouter.id) === Number(routerId)) {
        countRes = db.prepare('SELECT COUNT(*) as total FROM customers WHERE router_id = ? OR router_id IS NULL OR router_id = 0').get(routerId);
      } else {
        countRes = db.prepare('SELECT COUNT(*) as total FROM customers WHERE router_id = ?').get(routerId);
      }
      liveData.customersCount = countRes ? countRes.total : 0;
    } catch (e) {
      liveData.customersCount = 0;
    }

    try {
      const resource = await mikrotikService.getSystemResource(routerId);
      if (resource) {
        liveData.connected = true;
        liveData.cpuLoad = parseInt(resource['cpu-load'] || resource.cpuLoad || 0);
        liveData.freeMemory = parseInt(resource['free-memory'] || resource.freeMemory || 0);
        liveData.totalMemory = parseInt(resource['total-memory'] || resource.totalMemory || 0);
        liveData.freeHdd = parseInt(resource['free-hdd-space'] || resource.freeHddSpace || 0);
        liveData.totalHdd = parseInt(resource['total-hdd-space'] || resource.totalHddSpace || 0);
        liveData.version = resource.version || '-';
        liveData.boardName = resource['board-name'] || resource.boardName || '-';
        liveData.uptime = resource.uptime || '-';
        liveData.architecture = resource['architecture-name'] || resource.architectureName || '-';
        liveData.cpuCount = resource['cpu-count'] || resource.cpuCount || 1;
        liveData.cpuFrequency = resource['cpu-frequency'] || resource.cpuFrequency || 0;
      }

      try {
        const identity = await mikrotikService.getSystemIdentity(routerId);
        if (identity) liveData.identity = identity;
      } catch (e) {}

      try {
        const activePpp = await mikrotikService.getPppoeActive(routerId);
        liveData.activePppoe = activePpp ? activePpp.length : 0;
        liveData.activePppoeList = Array.isArray(activePpp) ? activePpp.slice(0, 50).map(s => ({
          name: s.name || s['name'] || '-',
          address: s.address || s['address'] || '-',
          uptime: s.uptime || s['uptime'] || '-',
          callerId: s['caller-id'] || s.callerId || '-'
        })) : [];
      } catch (e) {
        liveData.activePppoeList = [];
      }

      try {
        const activeHs = await mikrotikService.getHotspotActive(routerId);
        liveData.activeHotspot = activeHs ? activeHs.length : 0;
        liveData.activeHotspotList = Array.isArray(activeHs) ? activeHs.slice(0, 50).map(h => ({
          user: h.user || h['user'] || '-',
          address: h.address || h['address'] || '-',
          mac: h['mac-address'] || h.mac || '-',
          uptime: h.uptime || h['uptime'] || '-'
        })) : [];
      } catch (e) {
        liveData.activeHotspotList = [];
      }

    } catch (e) {
      liveData.connected = false;
      liveData.error = e.message;
    }

    res.json({ success: true, router: routerConfig, live: liveData });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.post('/api/routers/:id/setup-firewall', requireAdmin, async (req, res) => {
  try {
    const result = await mikrotikService.setupIsolirFirewall(req.params.id);
    res.json(result);
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

router.get('/api/isolir-portal-script', requireAdmin, async (req, res) => {
  try {
    const data = await mikrotikService.generateIsolirPortalScript();
    res.json({ success: true, ...data });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.post('/api/system/update', requireAdmin, async (req, res) => {
  const { exec } = require('child_process');
  const path = require('path');
  const projectDir = path.join(__dirname, '..');
  const isWindows = process.platform === 'win32';

  const cmd = isWindows 
    ? 'git pull origin main || git pull' 
    : 'nice -n 19 bash update.sh';

  logger.info(`[System Update] Admin initiated 1-Click System Update.`);

  exec(cmd, { cwd: projectDir, timeout: 120000 }, (error, stdout, stderr) => {
    if (error) {
      logger.error(`[System Update Error]: ${error.message}`);
      return res.json({ success: false, message: 'Gagal update: ' + error.message, output: stderr || stdout });
    }
    logger.info(`[System Update Complete]: ${stdout}`);
    return res.json({ 
      success: true, 
      message: 'Pembaruan aplikasi berhasil diterapkan (Low-CPU Mode)!', 
      output: stdout || 'Git pull & reload berhasil.' 
    });
  });
});

router.get('/api/mikrotik/profiles/:routerId', requireAdmin, async (req, res) => {
  try {
    const profiles = await mikrotikService.getPppoeProfiles(req.params.routerId);
    res.json(profiles);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/mikrotik/users/:routerId', requireAdmin, async (req, res) => {
  try {
    const routerId = req.params.routerId ? Number(req.params.routerId) : null;
    const onlyUnused = String(req.query.onlyUnused || '') === '1';
    const excludeCustomerId = req.query.excludeCustomerId ? Number(req.query.excludeCustomerId) : null;
    const users = await mikrotikService.getPppoeUsers(routerId);
    if (!onlyUnused) return res.json(users);

    const rows = excludeCustomerId
      ? db.prepare("SELECT pppoe_username FROM customers WHERE router_id IS ? AND id != ? AND pppoe_username IS NOT NULL AND TRIM(pppoe_username) != ''").all(routerId, excludeCustomerId)
      : db.prepare("SELECT pppoe_username FROM customers WHERE router_id IS ? AND pppoe_username IS NOT NULL AND TRIM(pppoe_username) != ''").all(routerId);
    const used = new Set(rows.map(r => String(r.pppoe_username).trim()).filter(Boolean));
    const filtered = (Array.isArray(users) ? users : []).filter(u => u && u.name && !used.has(String(u.name).trim()));
    res.json(filtered);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// ─── ATTENDANCE MANAGEMENT ───────────────────────────────────────────────────

// Attendance dashboard
router.get('/attendance', requireAdminSession, requireSidebarMenuAccess('attendance'), (req, res) => {
  try {
    const date = req.query.date || getNowLocal().split(' ')[0];
    const attendances = attendanceSvc.getAttendanceByDate(date);
    const stats = attendanceSvc.getAttendanceStats(date);
    const lateCheckIns = attendanceSvc.getLateCheckIns(date);
    const notCheckedOut = attendanceSvc.getNotCheckedOut(date);
    
    res.render('admin/attendance', {
      title: 'Manajemen Absensi',
      company: company(),
      activePage: 'attendance',
      session: req.session,
      attendances,
      stats,
      lateCheckIns,
      notCheckedOut,
      selectedDate: date,
      msg: flashMsg(req),
      t: (key, defaultVal) => defaultVal || key
    });
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal memuat data absensi: ' + e.message };
    res.redirect('/admin');
  }
});

// Get attendance by date range (API)
router.get('/api/attendance/range', requireAdminSession, (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    if (!startDate || !endDate) {
      return res.json({ success: false, message: 'Start date dan end date wajib diisi' });
    }
    
    const attendances = attendanceSvc.getAttendanceByDateRange(startDate, endDate);
    res.json({ success: true, data: attendances });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

// Get employee attendance history
router.get('/api/attendance/employee/:type/:id', requireAdminSession, (req, res) => {
  try {
    const { type, id } = req.params;
    const limit = req.query.limit ? parseInt(req.query.limit) : 30;
    const history = attendanceSvc.getAttendanceHistory(type, parseInt(id), limit);
    res.json({ success: true, data: history });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

// Get monthly summary
router.get('/api/attendance/summary/:type/:id/:year/:month', requireAdminSession, (req, res) => {
  try {
    const { type, id, year, month } = req.params;
    const summary = attendanceSvc.getMonthlyAttendanceSummary(
      type, 
      parseInt(id), 
      parseInt(year), 
      parseInt(month)
    );
    res.json({ success: true, data: summary });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

// Update attendance (admin correction)
router.post('/attendance/:id/update', requireAdminSession, express.json(), (req, res) => {
  try {
    const { id } = req.params;
    const { check_in_time, check_in_note, check_out_time, check_out_note } = req.body;
    
    // Calculate duration if both times provided
    let duration = 0;
    if (check_in_time && check_out_time) {
      const checkIn = parseDateInTimezone(check_in_time);
      const checkOut = parseDateInTimezone(check_out_time);
      if (checkIn && checkOut) {
        duration = Math.floor((checkOut - checkIn) / 1000 / 60);
      }
    }
    
    attendanceSvc.updateAttendance(parseInt(id), {
      check_in_time,
      check_in_note: check_in_note || '',
      check_out_time: check_out_time || null,
      check_out_note: check_out_note || '',
      work_duration_minutes: duration
    });
    
    auditSvc.log('admin', req.session.username || 'admin', 'update_attendance', `Updated attendance #${id}`);
    res.json({ success: true, message: 'Absensi berhasil diperbarui' });
  } catch (e) {
    res.json({ success: false, message: 'Gagal update absensi: ' + e.message });
  }
});

// Delete attendance
router.post('/attendance/:id/delete', requireAdminSession, (req, res) => {
  try {
    const { id } = req.params;
    attendanceSvc.deleteAttendance(parseInt(id));
    auditSvc.log('admin', req.session.username || 'admin', 'delete_attendance', `Deleted attendance #${id}`);
    req.session._msg = { type: 'success', text: 'Absensi berhasil dihapus' };
    res.redirect('/admin/attendance');
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal hapus absensi: ' + e.message };
    res.redirect('/admin/attendance');
  }
});

// Export attendance to Excel
router.get('/attendance/export', requireAdminSession, (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    if (!startDate || !endDate) {
      req.session._msg = { type: 'error', text: 'Tanggal mulai dan akhir wajib diisi' };
      return res.redirect('/admin/attendance');
    }
    
    const attendances = attendanceSvc.getAttendanceByDateRange(startDate, endDate);
    
    // Prepare data for Excel
    const data = attendances.map(a => ({
      'ID': a.id,
      'Tipe Karyawan': a.employee_type,
      'Nama': a.employee_name,
      'Check In': a.check_in_time,
      'Lokasi Check In': a.check_in_lat && a.check_in_lng ? `${a.check_in_lat}, ${a.check_in_lng}` : '-',
      'Catatan Check In': a.check_in_note || '-',
      'Foto Check In': a.check_in_photo || '-',
      'Check Out': a.check_out_time || '-',
      'Lokasi Check Out': a.check_out_lat && a.check_out_lng ? `${a.check_out_lat}, ${a.check_out_lng}` : '-',
      'Catatan Check Out': a.check_out_note || '-',
      'Foto Check Out': a.check_out_photo || '-',
      'Durasi (menit)': a.work_duration_minutes || 0,
      'Status': a.status
    }));
    
    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Absensi');
    
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    
    res.setHeader('Content-Disposition', `attachment; filename=absensi_${startDate}_${endDate}.xlsx`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal export: ' + e.message };
    res.redirect('/admin/attendance');
  }
});


// ─── PAYROLL / GAJI KARYAWAN ───────────────────────────────────────────────

router.get('/payroll', requireAdmin, requireSidebarMenuAccess('payroll'), (req, res) => {
  const now = new Date();
  const month = parseInt(req.query.month) || (now.getMonth() + 1);
  const year = parseInt(req.query.year) || now.getFullYear();

  const employees = payrollSvc.getAllEmployees();
  const slips = payrollSvc.getSlipsByPeriod(month, year);
  const summary = payrollSvc.getPayrollSummary(month, year);

  res.render('admin/payroll', {
    title: 'Gaji Karyawan',
    company: company(),
    employees,
    slips,
    summary,
    selectedMonth: month,
    selectedYear: year,
    msg: req.session._msg || null
  });
  req.session._msg = null;
});

router.post('/payroll/settings', requireAdmin, (req, res) => {
  try {
    payrollSvc.upsertPayrollSetting(req.body);
    req.session._msg = { type: 'success', text: 'Pengaturan gaji berhasil disimpan.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/payroll');
});

router.post('/payroll/generate', requireAdmin, (req, res) => {
  const month = parseInt(req.body.month);
  const year = parseInt(req.body.year);
  if (!month || !year) {
    req.session._msg = { type: 'error', text: 'Bulan dan tahun diperlukan' };
    return res.redirect('/admin/payroll');
  }

  const result = payrollSvc.generateAllSlips(month, year);
  req.session._msg = { 
    type: 'success', 
    text: `Generate selesai: ${result.generated} berhasil, ${result.skipped} dilewati, ${result.errors.length} error.` 
  };
  res.redirect(`/admin/payroll?month=${month}&year=${year}`);
});

router.post('/payroll/slip/:id/deduction', requireAdmin, express.json(), (req, res) => {
  try {
    const { other_deduction, other_deduction_note } = req.body;
    payrollSvc.updateSlipDeductions(req.params.id, other_deduction, other_deduction_note);
    res.json({ success: true, message: 'Potongan diperbarui' });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

router.post('/payroll/slip/:id/approve', requireAdmin, (req, res) => {
  try {
    payrollSvc.approveSlip(req.params.id);
    req.session._msg = { type: 'success', text: 'Slip berhasil di-approve.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: e.message };
  }
  res.redirect('back');
});

router.post('/payroll/slip/:id/paid', requireAdmin, (req, res) => {
  try {
    payrollSvc.markSlipPaid(req.params.id);
    req.session._msg = { type: 'success', text: 'Slip ditandai lunas (paid).' };
  } catch (e) {
    req.session._msg = { type: 'error', text: e.message };
  }
  res.redirect('back');
});

router.post('/payroll/slip/:id/delete', requireAdmin, (req, res) => {
  try {
    payrollSvc.deleteSlip(req.params.id);
    req.session._msg = { type: 'success', text: 'Slip berhasil dihapus.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: e.message };
  }
  res.redirect('back');
});

router.post('/payroll/bulk-approve', requireAdmin, (req, res) => {
  try {
    payrollSvc.bulkApprove(parseInt(req.body.month), parseInt(req.body.year));
    req.session._msg = { type: 'success', text: 'Semua slip draft berhasil di-approve.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: e.message };
  }
  res.redirect('back');
});

router.post('/payroll/bulk-paid', requireAdmin, (req, res) => {
  try {
    payrollSvc.bulkMarkPaid(parseInt(req.body.month), parseInt(req.body.year));
    req.session._msg = { type: 'success', text: 'Semua slip approved ditandai lunas.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: e.message };
  }
  res.redirect('back');
});

router.post('/payroll/delete-drafts', requireAdmin, (req, res) => {
  try {
    payrollSvc.deleteSlipsByPeriod(parseInt(req.body.month), parseInt(req.body.year));
    req.session._msg = { type: 'success', text: 'Semua slip draft dihapus.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: e.message };
  }
  res.redirect('back');
});

router.get('/payroll/slip/:id/print', requireAdmin, (req, res) => {
  const slip = payrollSvc.getSlipById(req.params.id);
  if (!slip) return res.status(404).send('Slip tidak ditemukan');
  
  res.render('admin/print_payslip', {
    company: company(),
    slip
  });
});

router.post('/payroll/slip/:id/send-wa', requireAdmin, async (req, res) => {
  try {
    const slip = payrollSvc.getSlipById(req.params.id);
    if (!slip) throw new Error('Slip tidak ditemukan');
    
    const phone = payrollSvc.getEmployeePhone(slip.employee_type, slip.employee_id);
    if (!phone) throw new Error('Nomor HP karyawan tidak diset');

    const { getSettingsWithCache } = require('../config/settingsManager');
    const settings = getSettingsWithCache();
    if (!settings.whatsapp_enabled) throw new Error('WhatsApp bot tidak aktif');

    const { sendWA, whatsappStatus } = await import('../services/whatsappBot.mjs');
    if (!whatsappStatus || whatsappStatus.connection !== 'open') {
      throw new Error('WhatsApp bot tidak terkoneksi');
    }

    const monthNames = ['','Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];
    
	//Ambil Pesan Dari Template
    const { formatPayrollSlip } = require('../services/whatsappService');

    let incomeDetails = '';
    if (slip.transport_allowance) incomeDetails += `\n- Tunj. Transport: Rp ${slip.transport_allowance.toLocaleString('id-ID')}`;
    if (slip.meal_allowance) incomeDetails += `\n- Tunj. Makan: Rp ${slip.meal_allowance.toLocaleString('id-ID')}`;
    if (slip.phone_allowance) incomeDetails += `\n- Tunj. Pulsa: Rp ${slip.phone_allowance.toLocaleString('id-ID')}`;
    if (slip.other_allowance) incomeDetails += `\n- Tunj. Lain: Rp ${slip.other_allowance.toLocaleString('id-ID')}`;
    if (slip.ticket_bonus) incomeDetails += `\n- Bonus Tiket: +Rp ${slip.ticket_bonus.toLocaleString('id-ID')}`;
    if (slip.collection_commission) incomeDetails += `\n- Komisi Tagihan: +Rp ${slip.collection_commission.toLocaleString('id-ID')}`;
    if (slip.overtime_bonus) incomeDetails += `\n- Lembur: +Rp ${slip.overtime_bonus.toLocaleString('id-ID')}`;

    let deductionDetails = '';
    if (slip.absence_deduction) deductionDetails += `\n- Potongan Absen: -Rp ${slip.absence_deduction.toLocaleString('id-ID')}`;
    if (slip.late_deduction) deductionDetails += `\n- Potongan Terlambat: -Rp ${slip.late_deduction.toLocaleString('id-ID')}`;
    if (slip.other_deduction) deductionDetails += `\n- Potongan Lain: -Rp ${slip.other_deduction.toLocaleString('id-ID')}`;

    const msg = formatPayrollSlip({
      name: slip.employee_name,
      period: `${monthNames[slip.period_month]} ${slip.period_year}`,
      status: slip.status.toUpperCase(),
      baseSalary: slip.base_salary.toLocaleString('id-ID'),
      incomeDetails,
      grossSalary: slip.gross_salary.toLocaleString('id-ID'),
      deductionDetails,
      totalDeductions: slip.total_deductions.toLocaleString('id-ID'),
      netSalary: slip.net_salary.toLocaleString('id-ID')
    });

    await sendWA(phone, msg);
    res.json({ success: true, message: 'Terkirim' });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

router.use('/acs', acsPortal);

// Mount Finance Portal
router.use('/finance', require('./financePortal'));
// ─── ONU PROVISION ─────────────────────────────────────────────────────────
const onuProvisionSvc = require('../services/onuProvisionService');

// ─── AMBIL DATA OLT DI DATABASE ─────────────────────────────────────────────────────────
router.get('/onu-provision', requireAdminSession, restrictToAdmin, (req, res) => {
  const olts = oltSvc.getAllOlts();
  const selectedOltId = req.query.olt_id ? Number(req.query.olt_id) : (olts.find(o => o.is_active)?.id || (olts[0] ? olts[0].id : null));
  const currentOlt = selectedOltId ? oltSvc.getOltById(selectedOltId) : null;
  
  res.render('admin/onu_provision', {
    title: 'ONU Provision',
    company: company(),
    activePage: 'onu_provision',
    msg: flashMsg(req),
    olts,
    currentOlt,
    selectedOltId,
    lang: req.session?.lang || 'id'
  });
});

// --- AWAL KODE BARU SCAN-CONFIGURED (MURNI SNMP DARI DATABASE OLT) ---
router.post('/onu-provision/scan-configured', requireAdminSession, restrictToAdmin, express.json(), async (req, res) => {
  try {
    const oltId = req.body.oltId ? Number(req.body.oltId) : null;
    let olt = null;
    if (oltId) {
      olt = oltSvc.getOltById(oltId);
    } else {
      const allActive = oltSvc.getActiveOlts();
      olt = (allActive && allActive.length > 0) ? allActive[0] : (oltSvc.getAllOlts()[0] || null);
    }

    if (!olt) {
      return res.json({ 
        success: false, 
        error: 'Belum ada data OLT di sistem. Silakan tambahkan OLT di menu Manajemen OLT terlebih dahulu.' 
      });
    }
    
    const stats = await oltSvc.getOltStats(olt.id, true);
    res.json({ success: true, onus: stats.onus || [], oltId: olt.id, oltName: olt.name });
  } catch (error) {
    logger.error('Scan configured ONUs error:', error);
    res.json({ success: false, error: error.message });
  }
});

// ============================================================================
// >>> AWAL PERBAIKAN: SCAN UNCONFIGURED MURNI MIB AUTOFIND C-DATA (.4.7.1) <<<
// ============================================================================
router.post(
  '/onu-provision/scan-unconfigured',
  requireAdminSession,
  restrictToAdmin,
  express.json(),
  async (req, res) => {
    let session;

    try {
      const oltId = Number(req.body?.oltId);
      const olt = oltId
        ? oltSvc.getOltById(oltId)
        : (oltSvc.getActiveOlts()?.[0] || oltSvc.getAllOlts()?.[0]);

      if (!olt) {
        return res.status(400).json({
          success: false,
          error: 'OLT tidak ditemukan di database'
        });
      }

      const community = String(olt.snmp_community || 'private').trim();
      const snmp = require('net-snmp');

      session = snmp.createSession(olt.host, community, {
        port: Number(olt.snmp_port) || 161,
        version: snmp.Version2c,
        timeout: 5000,
        retries: 1
      });

      // MIB Tabel Auto-Find C-Data GPON yang terverifikasi lewat walk (.4.7.1)
      const baseAutofind = '1.3.6.1.4.1.17409.2.8.4.7.1';
      const modelOid     = `${baseAutofind}.2`; // Equipment ID (misal F670LV9.0)
      const serialOid    = `${baseAutofind}.3`; // Serial Number (misal ZTEG-D4BDF9E0)
      const loidOid      = `${baseAutofind}.5`; // LOID

      // Helper walk kolom
      const walkColumn = (oid) => new Promise((resolve) => {
        const values = {};
        session.subtree(
          oid,
          20,
          (varbinds) => {
            for (const vb of varbinds || []) {
              if (!vb?.oid || snmp.isVarbindError(vb)) continue;
              const prefix = `${oid}.`;
              if (!vb.oid.startsWith(prefix)) continue;
              const index = vb.oid.slice(prefix.length);
              values[index] = vb.value;
            }
          },
          () => resolve(values)
        );
      });

      // Ambil data Serial Number, Model, dan LOID secara paralel
      const [serials, models, loids] = await Promise.all([
        walkColumn(serialOid),
        walkColumn(modelOid),
        walkColumn(loidOid)
      ]);

      // Ambil daftar ONU yang sudah terdaftar untuk menentukan alokasi ID berikutnya
      const existingStatusMap = await walkColumn('1.3.6.1.4.1.17409.2.8.4.1.1.7');
      const usedIds = new Set();
      for (const idx of Object.keys(existingStatusMap)) {
        const n = Number(idx);
        if (Number.isFinite(n) && n > 4718592) {
          usedIds.add(n - 4718592);
        }
      }

      // Hitung ID kosong pertama yang belum terpakai (1 s/d 128)
      let nextAvailableId = 1;
      for (let i = 1; i <= 128; i++) {
        if (!usedIds.has(i)) {
          nextAvailableId = i;
          break;
        }
      }

      const onus = [];
      for (const index of Object.keys(serials)) {
        const rawSerial = serials[index];
        let snClean = '';

        if (Buffer.isBuffer(rawSerial)) {
          snClean = rawSerial.toString('utf8').replace(/\0/g, '').trim();
        } else if (rawSerial != null) {
          snClean = String(rawSerial).trim();
        }

        // Hapus tanda strip jika ada (ZTEG-D4BDF9E0 -> ZTEGD4BDF9E0)
        snClean = snClean.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
        if (!snClean) continue;

        // Model / Equipment ID
        const rawModel = models[index];
        const modelClean = rawModel
          ? (Buffer.isBuffer(rawModel) ? rawModel.toString('utf8') : String(rawModel)).replace(/\0/g, '').trim()
          : 'GPON-ONU';

        // LOID
        const rawLoid = loids[index];
        const loidClean = rawLoid
          ? (Buffer.isBuffer(rawLoid) ? rawLoid.toString('utf8') : String(rawLoid)).replace(/\0/g, '').trim()
          : '';

        // Hitung port PON dari index (contoh: 4718593 -> port 1)
        const numericIndex = Number(index);
        let portNum = 1;
        if (Number.isFinite(numericIndex)) {
          portNum = ((numericIndex >> 16) & 0xff) || 1;
        }

        onus.push({
          index,
          onuId: nextAvailableId++, // Alokasi otomatis kandidat nomor ONU berikutnya
          pon: `0/0/${portNum}`,
          port: String(portNum),
          sn: snClean,
          loid: loidClean,
          model: modelClean,
          vendor: 'C-Data'
        });
      }

      return res.json({
        success: true,
        oltId: olt.id,
        oltName: olt.name,
        onus
      });
    } catch (error) {
      logger.error('Scan unconfigured ONUs via SNMP error:', error);
      return res.status(500).json({
        success: false,
        error: error.message
      });
    } finally {
      try {
        session?.close();
      } catch {}
    }
  }
);
// ============================================================================
// >>> AKHIR PERBAIKAN: SCAN UNCONFIGURED MURNI MIB AUTOFIND C-DATA (.4.7.1) <<<
// ============================================================================


// ============================================================================
// >>> AWAL PERBAIKAN: ROUTE BIND ONU VIA TELNET (KREDENSIAL DARI DATABASE) <<<
// ============================================================================
router.post('/onu-provision/provision', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const oltId = req.body.oltId ? Number(req.body.oltId) : null;
    let olt = null;
    if (oltId) {
      olt = oltSvc.getOltById(oltId);
    } else {
      const allActive = oltSvc.getActiveOlts();
      olt = (allActive && allActive.length > 0) ? allActive[0] : (oltSvc.getAllOlts()[0] || null);
    }

    if (!olt) {
      throw new Error('Data OLT tidak ditemukan di database.');
    }

    const { name, sn, onuId, pon, authPolicy } = req.body;
    if (!sn) throw new Error('Serial Number (SN) wajib diisi');

    // Auto alokasi nomor ONU ID berikutnya jika tidak diisi atau 0
    let targetOnuId = parseInt(onuId, 10);
    if (!targetOnuId || isNaN(targetOnuId)) {
      const currentStats = await oltSvc.getOltStats(olt.id, true);
      const existingIds = new Set((currentStats.onus || []).map(o => {
        const m = String(o.id || o.name || '').match(/(\d+)$/);
        return m ? parseInt(m[1], 10) : null;
      }).filter(Boolean));

      for (let i = 1; i <= 128; i++) {
        if (!existingIds.has(i)) {
          targetOnuId = i;
          break;
        }
      }
    }

    const cleanPon = pon || '0/0/1';
    const cleanPolicy = authPolicy || 'default-mult-srv-profile';

    logger.info(`[ONU Provision] Menjalankan otorisasi CLI Telnet ${name || 'ONT'} (${sn}) pada OLT ${olt.name} (${olt.host}) ID: ${targetOnuId}...`);

    // Eksekusi Bind via Telnet (kredensial otomatis dibaca dari database OLT)
    const result = await onuProvisionSvc.cdataProvisionONU(olt, {
      pon: cleanPon,
      onuId: targetOnuId,
      sn: sn.trim(),
      name: name,
      authPolicy: cleanPolicy
    });

    req.session._msg = { 
      type: 'success', 
      text: `✅ ${result.message}` 
    };
  } catch (error) {
    logger.error('[Provision Error]:', error.message);
    req.session._msg = { 
      type: 'error', 
      text: 'Gagal Otorisasi ONU: ' + error.message 
    };
  }
  
  res.redirect('/admin/onu-provision');
});
// ============================================================================
// >>> AKHIR PERBAIKAN: ROUTE BIND ONU VIA TELNET (KREDENSIAL DARI DATABASE) <<<
// ============================================================================

// --- AWAL KODE BARU DELETE ONU SNMP ---
router.post('/onu-provision/delete', requireAdminSession, restrictToAdmin, express.json(), async (req, res) => {
  try {
    const { oltId, index, sn, params } = req.body || {};
    const targetIndex = index || params?.index || params?.onuId;
    const targetSn = sn || params?.sn;

    if (!targetIndex) {
      return res.status(400).json({ 
        success: false, 
        error: 'Data ONU tidak lengkap (Index ONU tidak ditemukan)' 
      });
    }

    // Ambil OLT dari database
    const targetOltId = oltId ? Number(oltId) : (oltSvc.getActiveOlts()[0]?.id || 1);

    logger.info(`[ONU Delete] Melakukan unbind ONU index ${targetIndex} (OLT ID: ${targetOltId}) via MIB SNMP...`);
    await oltSvc.unbindOnu(targetOltId, targetIndex, targetSn);

    return res.json({ 
      success: true, 
      message: 'ONU berhasil di-unbind dari OLT via MIB SNMP' 
    });
  } catch (error) {
    logger.error('[ONU Delete Error]:', error.message);
    return res.status(500).json({ 
      success: false, 
      error: error.message || 'Gagal unbind ONU dari OLT' 
    });
  }
});
// --- AKHIR KODE BARU DELETE ONU SNMP ---


// --- RADIUS SERVER MANAGEMENT ---
const radiusSvc = require('../services/radiusServerService');

router.get('/radius-settings', requireAdminSession, restrictToAdmin, async (req, res) => {
  try {
    const radiusStatus = radiusSvc.getStatus();
    const onlineSessions = radiusSvc.getOnlineSessions();
    const acctLogs = radiusSvc.getAccountingLogs(100);
    const nasList = db.prepare(`SELECT * FROM radius_nas ORDER BY id DESC`).all() || [];

    const todayStats = db.prepare(`
      SELECT 
        COUNT(1) as total_events,
        COALESCE(SUM(input_octets + output_octets), 0) as total_bytes
      FROM radius_accounting
      WHERE DATE(created_at) = DATE('now')
    `).get() || { total_events: 0, total_bytes: 0 };

    const todayTrafficMB = (todayStats.total_bytes / (1024 * 1024)).toFixed(1);
    const todayEvents = todayStats.total_events;

    const msg = req.session._msg || null;
    req.session._msg = null;

    let detectedServerIp = '192.168.8.88';
    try {
      const ifaces = os.networkInterfaces();
      for (const ifaceName in ifaces) {
        for (const alias of ifaces[ifaceName]) {
          if (alias.family === 'IPv4' && !alias.internal && alias.address !== '127.0.0.1') {
            detectedServerIp = alias.address;
            break;
          }
        }
        if (detectedServerIp !== '192.168.8.88') break;
      }
    } catch (e) {}

    res.render('admin/radius-settings', {
      title: 'Pengaturan RADIUS',
      company: company(),
      activePage: 'radius_settings',
      session: req.session,
      radiusStatus,
      onlineSessions,
      acctLogs,
      nasList,
      todayTrafficMB,
      todayEvents,
      serverIp: detectedServerIp,
      msg
    });
  } catch (error) {
    logger.error('Error rendering RADIUS settings page:', error);
    res.status(500).send('Internal Server Error: ' + error.message);
  }
});

router.post('/radius-settings', requireAdminSession, restrictToAdmin, async (req, res) => {
  try {
    const {
      radius_enabled,
      radius_secret,
      radius_auth_port,
      radius_acct_port,
      radius_isolir_action,
      radius_isolir_pool,
      radius_isolir_rate_limit,
      radius_isolir_ip_pool_enabled,
      radius_isolir_ip_pool_start,
      radius_isolir_ip_pool_end,
      radius_limit_simultaneous,
      radius_default_rate_limit,
      radius_ip_pool_enabled,
      radius_ip_pool_start,
      radius_ip_pool_end,
      radius_framed_pool
    } = req.body;

    saveSettings({
      radius_enabled: radius_enabled === '1' ? '1' : '0',
      radius_secret: String(radius_secret || 'secret123').trim(),
      radius_auth_port: String(radius_auth_port || '1812').trim(),
      radius_acct_port: String(radius_acct_port || '1813').trim(),
      radius_isolir_action: String(radius_isolir_action || 'pool').trim(),
      radius_isolir_pool: String(radius_isolir_pool || 'isolir').trim(),
      radius_isolir_rate_limit: String(radius_isolir_rate_limit || '512k/512k').trim(),
      radius_isolir_ip_pool_enabled: radius_isolir_ip_pool_enabled === '1' ? '1' : '0',
      radius_isolir_ip_pool_start: String(radius_isolir_ip_pool_start || '10.10.99.2').trim(),
      radius_isolir_ip_pool_end: String(radius_isolir_ip_pool_end || '10.10.99.254').trim(),
      radius_limit_simultaneous: radius_limit_simultaneous === '1' ? '1' : '0',
      radius_default_rate_limit: String(radius_default_rate_limit || '5M/10M').trim(),
      radius_ip_pool_enabled: radius_ip_pool_enabled === '1' ? '1' : '0',
      radius_ip_pool_start: String(radius_ip_pool_start || '10.10.10.2').trim(),
      radius_ip_pool_end: String(radius_ip_pool_end || '10.10.10.254').trim(),
      radius_framed_pool: String(radius_framed_pool || 'pool-pppoe').trim()
    });

    // Kontrol background service UDP RADIUS
    radiusSvc.stop();
    if (radius_enabled === '1') {
      radiusSvc.start();
    }

    req.session._msg = { type: 'success', text: 'Pengaturan RADIUS Server berhasil diperbarui.' };
  } catch (error) {
    logger.error('Error saving RADIUS settings:', error);
    req.session._msg = { type: 'danger', text: 'Gagal menyimpan pengaturan: ' + error.message };
  }
  res.redirect('/admin/radius-settings');
});

router.post('/radius/disconnect', requireAdminSession, restrictToAdmin, async (req, res) => {
  try {
    const { username, session_id, nas_ip } = req.body;
    if (!username) throw new Error('Username tidak boleh kosong');

    await radiusSvc.disconnectSession(username, session_id, nas_ip);
    req.session._msg = { type: 'success', text: `Sesi aktif RADIUS untuk user "${username}" berhasil diputus.` };
  } catch (e) {
    logger.error('Error disconnecting RADIUS session:', e);
    req.session._msg = { type: 'danger', text: 'Gagal memutus sesi RADIUS: ' + e.message };
  }
  res.redirect('/admin/radius-settings');
});

router.post('/radius/clear-stale', requireAdminSession, restrictToAdmin, async (req, res) => {
  try {
    const result = db.prepare(`
      UPDATE radius_accounting
      SET status_type = 2, terminate_cause = 10, updated_at = NOW_LOCAL()
      WHERE status_type IN (1, 3) AND updated_at < datetime('now', '-2 hours')
    `).run();
    req.session._msg = { type: 'success', text: `Berhasil membersihkan ${result.changes} sesi kadaluarsa / ghost.` };
  } catch (e) {
    logger.error('Error clearing stale RADIUS sessions:', e);
    req.session._msg = { type: 'danger', text: 'Gagal membersihkan sesi: ' + e.message };
  }
  res.redirect('/admin/radius-settings');
});

router.post('/radius/restart', requireAdminSession, restrictToAdmin, async (req, res) => {
  try {
    radiusSvc.stop();
    await new Promise(r => setTimeout(r, 500));
    radiusSvc.start();
    req.session._msg = { type: 'success', text: 'Layanan RADIUS Server (UDP Port 1812/1813) berhasil direstart.' };
  } catch (e) {
    logger.error('Error restarting RADIUS service:', e);
    req.session._msg = { type: 'danger', text: 'Gagal merestart layanan RADIUS: ' + e.message };
  }
  res.redirect('/admin/radius-settings');
});

router.post('/radius/nas/add', requireAdminSession, restrictToAdmin, async (req, res) => {
  try {
    const { nasname, shortname, secret, description } = req.body;
    if (!nasname || !secret) {
      throw new Error('IP NAS & Shared Secret wajib diisi.');
    }

    db.prepare(`
      INSERT INTO radius_nas (nasname, shortname, secret, description, is_active)
      VALUES (?, ?, ?, ?, 1)
      ON CONFLICT(nasname) DO UPDATE SET
        shortname = excluded.shortname,
        secret = excluded.secret,
        description = excluded.description,
        is_active = 1
    `).run(
      String(nasname).trim(),
      String(shortname || '').trim(),
      String(secret).trim(),
      String(description || '').trim()
    );

    req.session._msg = { type: 'success', text: `NAS ${nasname} berhasil ditambahkan.` };
  } catch (error) {
    logger.error('Error adding NAS:', error);
    req.session._msg = { type: 'danger', text: 'Gagal menambah NAS: ' + error.message };
  }
  res.redirect('/admin/radius-settings');
});

router.post('/radius/nas/edit', requireAdminSession, restrictToAdmin, async (req, res) => {
  try {
    const { id, nasname, shortname, secret, description, is_active } = req.body;
    if (!id || !nasname || !secret) {
      throw new Error('ID, IP NAS & Shared Secret wajib diisi.');
    }

    db.prepare(`
      UPDATE radius_nas
      SET nasname = ?, shortname = ?, secret = ?, description = ?, is_active = ?, updated_at = (NOW_LOCAL())
      WHERE id = ?
    `).run(
      String(nasname).trim(),
      String(shortname || '').trim(),
      String(secret).trim(),
      String(description || '').trim(),
      is_active === '1' || is_active === 1 ? 1 : 0,
      id
    );

    req.session._msg = { type: 'success', text: `Data NAS ${nasname} berhasil diperbarui.` };
  } catch (error) {
    logger.error('Error updating NAS:', error);
    req.session._msg = { type: 'danger', text: 'Gagal memperbarui NAS: ' + error.message };
  }
  res.redirect('/admin/radius-settings');
});

router.post('/radius/nas/toggle', requireAdminSession, restrictToAdmin, async (req, res) => {
  try {
    const { id } = req.body;
    const nas = db.prepare(`SELECT id, nasname, is_active FROM radius_nas WHERE id = ?`).get(id);
    if (nas) {
      const newStatus = nas.is_active ? 0 : 1;
      db.prepare(`UPDATE radius_nas SET is_active = ?, updated_at = (NOW_LOCAL()) WHERE id = ?`).run(newStatus, id);
      req.session._msg = { type: 'success', text: `Status NAS ${nas.nasname} diubah menjadi ${newStatus ? 'Aktif' : 'Non-Aktif'}.` };
    }
  } catch (error) {
    logger.error('Error toggling NAS status:', error);
    req.session._msg = { type: 'danger', text: 'Gagal mengubah status NAS: ' + error.message };
  }
  res.redirect('/admin/radius-settings');
});

router.post('/radius/nas/delete', requireAdminSession, restrictToAdmin, async (req, res) => {
  try {
    const { id } = req.body;
    db.prepare(`DELETE FROM radius_nas WHERE id = ?`).run(id);
    req.session._msg = { type: 'success', text: 'NAS Client berhasil dihapus.' };
  } catch (error) {
    logger.error('Error deleting NAS:', error);
    req.session._msg = { type: 'danger', text: 'Gagal menghapus NAS: ' + error.message };
  }
  res.redirect('/admin/radius-settings');
});

// ============================================================================
// >>> BACKGROUND WORKER: AKUMULASI TRAFIK BULANAN OTOMATIS (PPPoE, Hotspot & Binding) <<<
// ============================================================================

// 1. Pastikan kolom pendukung counter raw byte ada di database customers
try { db.prepare("ALTER TABLE customers ADD COLUMN last_raw_rx INTEGER DEFAULT 0").run(); } catch (e) {}
try { db.prepare("ALTER TABLE customers ADD COLUMN last_raw_tx INTEGER DEFAULT 0").run(); } catch (e) {}

// ==================== [AWAL: BACKGROUND WORKER TRAFIK ANTI-LONJAKAN / ANTI-TB] ====================
const backgroundTrafficWorkerInterval = 15000; // 15 detik

setInterval(async () => {
  try {
    const customersToSync = db.prepare(`
      SELECT id, router_id, connection_type, pppoe_username, hotspot_username, static_ip, mac_address,
             COALESCE(bytes_in, 0) as bytes_in,
             COALESCE(bytes_out, 0) as bytes_out,
             COALESCE(bytes_in_daily, 0) as bytes_in_daily,
             COALESCE(bytes_out_daily, 0) as bytes_out_daily,
             COALESCE(last_raw_rx, 0) as last_raw_rx,
             COALESCE(last_raw_tx, 0) as last_raw_tx
      FROM customers 
      WHERE (pppoe_username IS NOT NULL AND TRIM(pppoe_username) != '') 
         OR (hotspot_username IS NOT NULL AND TRIM(hotspot_username) != '')
         OR (static_ip IS NOT NULL AND TRIM(static_ip) != '')
    `).all();

    if (!customersToSync || customersToSync.length === 0) return;

    const routersMap = new Map();
    for (const c of customersToSync) {
      let rId = c.router_id ? Number(c.router_id) : null;
      if (!rId || rId <= 0) {
        const defR = mikrotikService.getAllRouters()?.[0];
        rId = defR ? defR.id : null;
      }
      if (!routersMap.has(rId)) routersMap.set(rId, []);
      routersMap.get(rId).push(c);
    }

    let totalUpdated = 0;

    for (const [routerId, custs] of routersMap.entries()) {
      let conn = null;
      try {
        conn = routerId ? await mikrotikService.getConnection(routerId) : await mikrotikService.getConnection();
        if (!conn || !conn.client) continue;

        // Ambil Simple Queues
        let simpleQueues = [];
        try { simpleQueues = await conn.client.menu('/queue/simple').get().catch(() => []); } catch (_) {}

        // Ambil Interfaces
        let interfaces = [];
        try { interfaces = await conn.client.menu('/interface').get().catch(() => []); } catch (_) {}

        const ifaceMap = new Map();
        for (const iface of (interfaces || [])) {
          ifaceMap.set(String(iface.name || '').toLowerCase(), iface);
        }

        for (const cust of custs) {
          const pppUname = String(cust.pppoe_username || '').trim().toLowerCase();
          const hsUname = String(cust.hotspot_username || '').trim().toLowerCase();
          const staticIp = String(cust.static_ip || '').trim().toLowerCase();

          let rawDownloadBytes = 0; // Download (RX)
          let rawUploadBytes = 0;   // Upload (TX)
          let foundSource = false;

          // 1. Cek dari Simple Queue (Untuk Hotspot / Static / Sesi yang pakai queue)
          if (simpleQueues.length > 0) {
            for (const q of simpleQueues) {
              const qName = String(q.name || '').toLowerCase().replace(/^<|>$/g, '');
              const targetRaw = String(q.target || q['target'] || '').toLowerCase();
              const targetIp = targetRaw.split('/')[0].trim();

              const matchIp = staticIp && targetIp === staticIp;
              let matchName = false;
              if (pppUname && qName === pppUname) matchName = true;
              if (hsUname) {
                const escaped = hsUname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const pattern = new RegExp(`^(hotspot-)?${escaped}(-[0-9]+)?$`, 'i');
                if (pattern.test(qName)) matchName = true;
              }

              if (matchIp || matchName) {
                const bytesStr = String(q.bytes || q['bytes'] || '').trim();
                if (bytesStr.includes('/')) {
                  const bParts = bytesStr.split('/');
                  rawUploadBytes   += (Number(bParts[0]) || 0);
                  rawDownloadBytes += (Number(bParts[1]) || 0);
                  foundSource = true;
                }
              }
            }
          }

          // 2. Cek dari Interface PPPoE (Untuk router tanpa queue)
          if (!foundSource && pppUname && ifaceMap.size > 0) {
            const iface = ifaceMap.get(`<pppoe-${pppUname}>`) || 
                          ifaceMap.get(`pppoe-${pppUname}`) || 
                          (interfaces || []).find(i => String(i.name || '').toLowerCase().includes(pppUname));
            
            if (iface) {
              rawUploadBytes   = numField(iface, ['rx-byte', 'rxBytes', 'bytes-in', 'bytesIn']);
              rawDownloadBytes = numField(iface, ['tx-byte', 'txBytes', 'bytes-out', 'bytesOut']);
              foundSource = true;
            }
          }

          if (!foundSource) continue;

          const lastRawRx = Number(cust.last_raw_rx || 0);
          const lastRawTx = Number(cust.last_raw_tx || 0);

          let deltaRx = 0;
          let deltaTx = 0;

          // PENGAMAN UTAMA: Jika raw saat ini lebih kecil dari sebelumnya (artinya router reboot / counter reset),
          // JANGAN TAMBAHKAN KE DELTA (Set 0) untuk mencegah lonjakan nilai TeraByte!
          if (rawDownloadBytes >= lastRawRx) {
            deltaRx = rawDownloadBytes - lastRawRx;
          } else {
            deltaRx = 0; // Reset aman, abaikan lonjakan negatif
          }

          if (rawUploadBytes >= lastRawTx) {
            deltaTx = rawUploadBytes - lastRawTx;
          } else {
            deltaTx = 0; // Reset aman, abaikan lonjakan negatif
          }

          // Batasi kewajaran delta per 15 detik (maksimal setara 1 Gbps penuh = ~1.8 GB per 15 detik)
          const MAX_WLAN_DELTA_BYTES = 2000 * 1024 * 1024; 
          if (deltaRx > MAX_WLAN_DELTA_BYTES) deltaRx = 0;
          if (deltaTx > MAX_WLAN_DELTA_BYTES) deltaTx = 0;

          if (deltaRx > 0 || deltaTx > 0) {
            db.prepare(`
              UPDATE customers 
              SET bytes_in_daily = bytes_in_daily + ?,  
                  bytes_out_daily = bytes_out_daily + ?,
                  bytes_in = bytes_in + ?,              
                  bytes_out = bytes_out + ?,
                  last_raw_rx = ?,
                  last_raw_tx = ?
              WHERE id = ?
            `).run(deltaRx, deltaTx, deltaRx, deltaTx, rawDownloadBytes, rawUploadBytes, cust.id);

            totalUpdated++;
          } else if (lastRawRx === 0 && lastRawTx === 0 && (rawDownloadBytes > 0 || rawUploadBytes > 0)) {
            db.prepare(`
              UPDATE customers 
              SET last_raw_rx = ?, last_raw_tx = ? 
              WHERE id = ?
            `).run(rawDownloadBytes, rawUploadBytes, cust.id);
          }
        }
      } catch (routerErr) {
        logger.warn(`[Traffic Worker] Gagal sinkronisasi router ${routerId}: ${routerErr.message}`);
      } finally {
        if (conn && conn.api) {
          try { conn.api.close(); } catch {}
        }
      }
    }
  } catch (err) {
    logger.error(`[Traffic Worker] Error: ${err.message}`);
  }
}, backgroundTrafficWorkerInterval);
// ==================== [AKHIR: BACKGROUND WORKER TRAFIK ANTI-LONJAKAN / ANTI-TB] ====================
// ============================================================================

/* ========================================================================= */
/* [AWAL FITUR]: API KONTROL & STATUS AI WATCHDOG (OUTAGE & SECURITY)       */
/* Fungsi: Menyediakan data status ODP padam, daftar blokir, dan simpan switch */
/* ========================================================================= */

const outageWatchdogSvc = require('../services/outageWatchdogService');
const securityWatchdogSvc = require('../services/securityWatchdogService');

// 1. Ambil Pengaturan & Ringkasan Status Kedua Watchdog
router.get('/api/watchdog/status', requireAdminSession, async (req, res) => {
  try {
    const outageStatus = await outageWatchdogSvc.scanNetworkOutages({ isManual: true }).catch(() => ({ scannedOdps: 0, activeIncidents: [], recoveredIncidents: [] }));
    const securityStatus = await securityWatchdogSvc.getDetailedSecurityStatus().catch(() => ({ appBlockedIps: [], mikrotikBlockedIps: [], mikrotikBlockedMacs: [], policy: {} }));

    return res.json({
      success: true,
      /* ========================================================================= */
/* [AWAL]: TAMBAHAN CONFIG NOTIFIKASI WA, TELE & BYPASS ODP                  */
/* ========================================================================= */
      config: {
        outage_enabled: String(getSetting('outage_watchdog_enabled', 'true')) === 'true',
        security_autoblock_enabled: String(getSetting('security_auto_block_enabled', 'true')) === 'true',
        soundbox_outage_enabled: String(getSetting('soundbox_outage_alert_enabled', 'true')) === 'true',
        soundbox_security_enabled: String(getSetting('soundbox_security_alert_enabled', 'true')) === 'true',
        outage_telegram_enabled: String(getSetting('outage_telegram_notif_enabled', 'true')) === 'true',
        outage_wa_enabled: String(getSetting('outage_wa_notif_enabled', 'true')) === 'true',
        outage_ignored_odps: String(getSetting('outage_ignored_odps', '') || ''),
		// Tambahan Security Watchdog:
        security_telegram_enabled: String(getSetting('security_telegram_notif_enabled', 'true')) === 'true',
        security_wa_enabled: String(getSetting('security_wa_notif_enabled', 'true')) === 'true',
        security_whitelisted_targets: String(getSetting('security_whitelisted_targets', '') || '')
      },
/* ========================================================================= */
/* [AKHIR]: CONFIG TAMBAHAN                                                  */
/* ========================================================================= */
      outage: outageStatus,
      security: securityStatus
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// 2. Simpan Perubahan Saklar Switch On / Off (Menggunakan saveSettings bawaan)
router.post('/api/watchdog/settings', requireAdminSession, express.json(), async (req, res) => {
  try {
    const { key, value } = req.body;
    if (!key) return res.status(400).json({ success: false, message: 'Key setting tidak valid' });

    saveSettings({ [key]: value });
    return res.json({ success: true, message: `Pengaturan ${key} berhasil disimpan` });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// 3. Tombol Eksekusi Buka Blokir (Unblock IP / MAC)
router.post('/api/watchdog/unblock', requireAdminSession, express.json(), async (req, res) => {
  try {
    const { target } = req.body;
    if (!target) return res.status(400).json({ success: false, message: 'Target IP/MAC tidak boleh kosong' });

    const result = await securityWatchdogSvc.unblockMikrotikTarget({ target });
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

/* [AKHIR FITUR]: API KONTROL & STATUS AI WATCHDOG                            */
/* ========================================================================= */

module.exports = router;
