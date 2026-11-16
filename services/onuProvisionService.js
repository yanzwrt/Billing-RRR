// ============================================================================
// >>> FULL FINAL: ONU PROVISION SERVICE (TELNET C-DATA HANDSHAKE & CLI) <<<
// ============================================================================
const { Client } = require('ssh2');
const net = require('net');
const { logger } = require('../config/logger');
const { getSetting } = require('../config/settingsManager');

function sanitizeCliInput(val) {
  if (val === undefined || val === null) return '';
  return String(val).replace(/[\r\n]+/g, ' ').trim();
}

function sanitizeParams(params) {
  const clean = {};
  if (!params || typeof params !== 'object') return clean;
  for (const k of Object.keys(params)) {
    clean[k] = typeof params[k] === 'string'
      ? params[k].replace(/[\r\n]+/g, ' ').trim()
      : params[k];
  }
  return clean;
}

/**
 * Parsing Index OLT C-Data FD16xx (misal 4718626 -> PON 1, ONU 34)
 */
function parseCDataIndex(index) {
  const n = parseInt(index, 10);
  if (!Number.isFinite(n)) {
    const parts = String(index).split(/[:/]+/);
    if (parts.length >= 2) {
      return {
        port: parseInt(parts[parts.length - 2], 10) || 1,
        onuId: parseInt(parts[parts.length - 1], 10) || 1
      };
    }
    return { port: 1, onuId: 1 };
  }
  
  // Untuk OLT FD1601S (1 port), port fisik selalu 1
  let port = 1;
  let onuId = n > 4718592 ? (n - 4718592) : (n & 0xff);
  if (onuId === 0) onuId = 1;

  return { port, onuId };
}

class ONUProvisionService {
  constructor() {
    this.connections = new Map();
  }

  /**
   * Helper Telnet C-Data Engine dengan Filter IAC dan Handshake Multi-Stage
   */
  async executeTelnetCommands(oltConfig, commands) {
    const host = oltConfig.host;
    const port = Number(oltConfig.telnet_port || oltConfig.port) || 23;
    const user = String(oltConfig.web_user || oltConfig.username || 'root').trim();
    const pass = String(oltConfig.web_password || oltConfig.password || 'admin').trim();
    const enablePass = String(oltConfig.enable_password || pass).trim();

    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      socket.setTimeout(25000);

      let buf = '';
      let stage = 'INIT'; // INIT -> USER_SENT -> PASS_SENT -> PRIVILEGED_CHECK -> READY

      const cleanup = () => {
        socket.removeAllListeners();
        socket.destroy();
      };

      socket.connect(port, host, () => {
        logger.info(`[Telnet] Terhubung ke ${host}:${port}, menunggu prompt login...`);
        // Kirim enter awal setelah jeda 300ms untuk memancing respons OLT
        setTimeout(() => {
          try { socket.write('\r\n'); } catch (e) {}
        }, 300);
      });

      socket.on('data', (chunk) => {
        // Filter Telnet Negotiation IAC (0xFF)
        let cleanChunk = '';
        for (let i = 0; i < chunk.length; i++) {
          if (chunk[i] === 255) {
            i += 2; // Lewati byte negosiasi
            continue;
          }
          cleanChunk += String.fromCharCode(chunk[i]);
        }

        buf += cleanChunk;

        // Bypass prompt --More-- jika ada
        if (buf.includes('--More--') || buf.includes('--Press Enter--') || buf.includes('--More ( Press')) {
          socket.write(' ');
          return;
        }

        // 1. Deteksi Prompt Username ("User name:", "Username:", "login:")
        if ((stage === 'INIT' || stage === 'CONNECT') && /(user\s*name|username|login)\s*[:>]/i.test(buf)) {
          stage = 'USER_SENT';
          buf = '';
          logger.info(`[Telnet] Mengirim username (${user})...`);
          socket.write(user + '\r\n');
          return;
        }

        // 2. Deteksi Prompt Password ("Password:", "passwd:")
        if (stage === 'USER_SENT' && /(password|passwd)\s*[:>]/i.test(buf)) {
          stage = 'PASS_SENT';
          buf = '';
          logger.info(`[Telnet] Mengirim password login...`);
          socket.write(pass + '\r\n');
          return;
        }

        // 3. Masuk User Mode (akhiran '>') -> Kirim 'enable'
        if (stage === 'PASS_SENT' && />\s*$/.test(buf.trim())) {
          stage = 'ENABLE_SENT';
          buf = '';
          logger.info(`[Telnet] Berada di mode user (>), mengirim 'enable'...`);
          socket.write('enable\r\n');
          return;
        }

        // 4. Jika 'enable' meminta password lagi
        if (stage === 'ENABLE_SENT' && /(password|passwd)\s*[:>]/i.test(buf)) {
          buf = '';
          logger.info(`[Telnet] Mengirim enable password...`);
          socket.write(enablePass + '\r\n');
          return;
        }

        // 5. Berhasil masuk Privileged Mode ('#')
        if ((stage === 'PASS_SENT' || stage === 'ENABLE_SENT' || stage === 'INIT') && /#\s*$/.test(buf.trim())) {
          stage = 'READY';
          buf = '';
          socket.removeAllListeners('data');
          logger.info(`[Telnet] Berhasil masuk Privileged Mode (#). Mengeksekusi CLI...`);

          this._runTelnetSequence(socket, commands, /[#\$]\s*$/m)
            .then((out) => {
              cleanup();
              resolve(out);
            })
            .catch((err) => {
              cleanup();
              reject(err);
            });
        }
      });

      socket.on('error', (err) => {
        cleanup();
        reject(new Error(`Koneksi Telnet gagal: ${err.message}`));
      });

      socket.on('timeout', () => {
        cleanup();
        reject(new Error(`Koneksi Telnet Timeout pada stage [${stage}]. Pastikan IP, Telnet Port, dan Kredensial di Manajemen OLT sudah benar.`));
      });
    });
  }

  async _runTelnetSequence(socket, commands, promptRe) {
    let output = '';
    for (const cmd of commands) {
      socket.write(cmd + '\r\n');
      const stepOut = await new Promise((res, rej) => {
        let stepBuf = '';
        const onData = (data) => {
          const s = data.toString('utf8');
          stepBuf += s;
          if (stepBuf.includes('--More--') || stepBuf.includes('--More ( Press')) {
            socket.write(' ');
          }
          if (promptRe.test(stepBuf)) {
            socket.off('data', onData);
            res(stepBuf);
          }
        };
        const t = setTimeout(() => {
          socket.off('data', onData);
          rej(new Error(`Timeout mengeksekusi perintah CLI: ${cmd}`));
        }, 15000);

        socket.on('data', onData);
      });
      output += '\n' + stepOut;
    }
    return output;
  }

  /**
   * C-Data - Otorisasi / Bind ONU Resmi via CLI Telnet
   */
  async cdataProvisionONU(oltConfig, params) {
    params = sanitizeParams(params);
    let { pon, onuId, sn, name, authPolicy } = params;

    const portNum = String(pon || '1').includes('/') ? pon.split('/').pop() : (pon || '1');
    const cleanName = (name || `ONT_${onuId}`).replace(/["'\s]+/g, '_').slice(0, 32);
    const targetOnuId = parseInt(onuId, 10) || 1;
    const policy = authPolicy || 'default-mult-srv-profile';

    // Rangkaian perintah resmi C-Data GPON CLI
    const cmds = [
      'config',
      'interface gpon 0/0',
      `ont add ${portNum} ${targetOnuId} sn-auth ${sn} mult-srv-profile profile-name ${policy}`,
      `ont description ${portNum} ${targetOnuId} ${cleanName}`,
      'exit',
      'save'
    ];

    logger.info(`[C-Data Telnet] Memulai otorisasi Port: ${portNum}, ID: ${targetOnuId}, SN: ${sn}, Policy: ${policy}...`);
    const output = await this.executeTelnetCommands(oltConfig, cmds);
    logger.info(`[C-Data Telnet] Output:\n${output}`);

    if (output.includes('onu create failed') || output.includes('Error:') || output.includes('% Unknown command') || output.includes('conflict') || output.includes('failed')) {
      const errorMatch = output.split('\n').find(l => 
        l.includes('onu create failed') || 
        l.includes('Error:') || 
        l.includes('% Unknown command') ||
        l.includes('conflict') ||
        l.includes('failed')
      ) || 'Ditolak oleh OLT C-Data';
      throw new Error(errorMatch.trim());
    }

    return { 
      success: true, 
      message: `ONU ${cleanName} (ID: ${targetOnuId}) berhasil diotorisasi pada Port ${portNum}!` 
    };
  }

  /**
   * C-Data - Hapus / Unbind ONU via CLI Telnet
   */
  async cdataDeleteONU(oltConfig, params) {
    params = sanitizeParams(params);
    let { pon, onuId, index } = params;

    if (index && (!pon || !onuId)) {
      const parsed = parseCDataIndex(index);
      pon = parsed.port;
      onuId = parsed.onuId;
    }

    if (!onuId) onuId = 1;
    const portId = String(pon || '1').includes('/') ? pon.split('/').pop() : pon;

    const cmds = [
      'config',
      'interface gpon 0/0',
      `ont delete ${portId} ${onuId}`,
      'exit',
      'save'
    ];

    logger.info(`[C-Data Telnet] Menghapus ONT Port ${portId} ID ${onuId}...`);
    const output = await this.executeTelnetCommands(oltConfig, cmds);

    if (output.includes('% Unknown command') || output.includes('Error:')) {
      return { success: false, message: `Gagal menghapus ONT: ${output}` };
    }
    
    return { success: true, message: `ONT Port ${portId} ID ${onuId} berhasil dihapus dari OLT C-Data` };
  }

  async deleteONU(oltConfig, vendor, params) {
    return this.cdataDeleteONU(oltConfig, params);
  }
}

module.exports = new ONUProvisionService();
// ============================================================================
// >>> AKHIR FULL FINAL: ONU PROVISION SERVICE <<<
// ============================================================================