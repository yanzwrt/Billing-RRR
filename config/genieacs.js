const axios = require('axios');
require('dotenv').config();
const { logger } = require('./logger');
const db = require('./database');
const { getSetting } = require('./settingsManager');

// ─── Built-in ACS Helpers ────────────────────────────────────────────────────

/** Check if built-in ACS mode is active */
function isBuiltinAcsEnabled() {
  return getSetting('use_builtin_acs', false) === true || getSetting('use_builtin_acs', false) === 'true';
}

/**
 * Inflate flat params object into nested GenieACS-style structure.
 * e.g. { "InternetGatewayDevice.DeviceInfo.SerialNumber": "ABC" }
 * becomes { InternetGatewayDevice: { DeviceInfo: { SerialNumber: { _value: "ABC" } } } }
 */
function inflateParams(flatObj) {
  const result = {};
  for (const [key, value] of Object.entries(flatObj)) {
    const parts = key.split('.');
    let current = result;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (i === parts.length - 1) {
        current[part] = { _value: value, _type: typeof value === 'number' ? 'xsd:unsignedInt' : 'xsd:string', _timestamp: new Date().toISOString() };
      } else {
        if (!current[part] || typeof current[part] !== 'object' || current[part]._value !== undefined) {
          current[part] = {};
        }
        current = current[part];
      }
    }
  }
  return result;
}

/** Convert a builtin acs_devices row into GenieACS-compatible device object */
function builtinRowToDevice(row) {
  if (!row) return null;
  let params = {};
  try { params = JSON.parse(row.params || '{}'); } catch (e) { /* ignore */ }
  let tags = [];
  try { tags = JSON.parse(row.tags || '[]'); } catch (e) { /* ignore */ }
  tags = tags.filter(t => t !== 'bootstrapped');

  const device = inflateParams(params);
  device._id = row.id;
  device._tags = tags;
  device._lastInform = row.last_inform;
  device._updatedAt = row.updated_at;
  device._registered = row.created_at;
  device._acs_server_id = 'builtin';
  device._acs_server_name = 'Built-in ACS';

  // Set GenieACS special _deviceId root property
  device._deviceId = {
    _SerialNumber: row.serial_number || '',
    _Manufacturer: row.manufacturer || '',
    _ProductClass: row.product_class || '',
    _OUI: row.oui || ''
  };

  // Set DeviceID structure as strings (GenieACS standard)
  device.DeviceID = {
    SerialNumber: row.serial_number || '',
    Manufacturer: row.manufacturer || '',
    ProductClass: row.product_class || '',
    OUI: row.oui || ''
  };

  return device;
}

// === AWAL TAMBAHAN: HELPER RESOLUSI PELANGGAN BILLING DARI DATA TR-069 ===
/**
 * Mencari data pelanggan di tabel `customers` SQLite berdasarkan PPPoE username, SN, Tag, atau No HP
 */
function findCustomerForDevice(pppoeUsername, serialNumber, deviceId, tags = []) {
  try {
    // 1. Prioritas Utama: Cari berdasarkan PPPoE username
    if (pppoeUsername && pppoeUsername !== 'Unknown' && pppoeUsername !== '-') {
      const cleanPppoe = String(pppoeUsername).trim();
      const row = db.prepare(
        'SELECT id, name, phone, address, pppoe_username, area FROM customers WHERE LOWER(pppoe_username) = LOWER(?) LIMIT 1'
      ).get(cleanPppoe);
      if (row) return row;
    }

    // 2. Prioritas Kedua: Cari berdasarkan Serial Number / Tag / MAC
    const cleanSn = String(serialNumber || '').trim();
    if (cleanSn && cleanSn !== 'Unknown' && cleanSn.length >= 4) {
      const row = db.prepare(
        'SELECT id, name, phone, address, pppoe_username, area FROM customers WHERE genieacs_tag = ? OR mac_address = ? LIMIT 1'
      ).get(cleanSn, cleanSn);
      if (row) return row;
    }

    // 3. Prioritas Ketiga: Cari dari kumpulan Tag GenieACS
    if (Array.isArray(tags) && tags.length > 0) {
      for (const tag of tags) {
        if (!tag) continue;
        const cleanTag = String(tag).trim();
        const row = db.prepare(
          'SELECT id, name, phone, address, pppoe_username, area FROM customers WHERE genieacs_tag = ? OR pppoe_username = ? OR phone LIKE ? LIMIT 1'
        ).get(cleanTag, cleanTag, `%${cleanTag}%`);
        if (row) return row;
      }
    }

    // 4. Prioritas Keempat: Cocokkan Device ID (misal ZTE-00259E) ke tag
    if (deviceId) {
      const shortId = deviceId.split('-')[2] || deviceId;
      const row = db.prepare(
        'SELECT id, name, phone, address, pppoe_username, area FROM customers WHERE genieacs_tag LIKE ? LIMIT 1'
      ).get(`%${shortId}%`);
      if (row) return row;
    }
  } catch (err) {
    logger.debug(`[GenieACS Monitoring] Error matching customer: ${err.message}`);
  }
  return null;
}
// === AKHIR TAMBAHAN: HELPER RESOLUSI PELANGGAN BILLING ===

/** Parse GenieACS-style query filter for SQLite */
function matchesQuery(device, query) {
  if (!query || Object.keys(query).length === 0) return true;
  for (const [key, condition] of Object.entries(query)) {
    if (key === '$or') {
      if (!Array.isArray(condition)) return false;
      const anyMatch = condition.some(sub => matchesQuery(device, sub));
      if (!anyMatch) return false;
      continue;
    }
    if (key === '$and') {
      if (!Array.isArray(condition)) return false;
      const allMatch = condition.every(sub => matchesQuery(device, sub));
      if (!allMatch) return false;
      continue;
    }
    // Get value from nested device object
    const parts = key.split('.');
    let val = device;
    for (const p of parts) {
      if (val && typeof val === 'object') {
        val = val[p];
      } else {
        val = undefined;
        break;
      }
    }
    if (val && val._value !== undefined) val = val._value;

    // Handle condition types
    if (condition && typeof condition === 'object' && !Array.isArray(condition)) {
      if ('$exists' in condition) {
        const exists = val !== undefined && val !== null;
        if (condition.$exists !== exists) return false;
      }
      if ('$ne' in condition) {
        if (Array.isArray(condition.$ne) && condition.$ne.length === 0) {
          if (!Array.isArray(val) || val.length === 0) return false;
        } else if (val === condition.$ne) return false;
      }
      if ('$not' in condition) {
        if (condition.$not && typeof condition.$not === 'object' && '$size' in condition.$not) {
          if (Array.isArray(val) && val.length === condition.$not.$size) return false;
        }
      }
    } else {
      // Direct equality
      if (key === '_tags') {
        if (!Array.isArray(device._tags) || !device._tags.includes(condition)) return false;
      } else if (key === '_id') {
        if (device._id !== condition) return false;
      } else {
        if (String(val) !== String(condition)) return false;
      }
    }
  }
  return true;
}

/**
 * Create a proxy object that mimics axios interface but operates on local SQLite.
 * This is the core of the adapter pattern - all downstream code using
 * createAxiosInstance() will transparently use local DB when builtin ACS is active.
 */
function createBuiltinAxiosProxy() {
  return {
    get: async (url, config = {}) => {
      const params = config.params || {};
      
      // GET /devices
      if (url === '/devices' || url === '/devices/') {
        let rows = [];
        try {
          const limit = params.limit || 999999;
          rows = db.prepare('SELECT * FROM acs_devices ORDER BY last_inform DESC LIMIT ?').all(limit);
        } catch (e) {
          logger.error(`[BuiltinACS] Error querying devices: ${e.message}`);
        }
        
        let devices = rows.map(builtinRowToDevice);
        
        // Apply query filter
        if (params.query) {
          try {
            const queryObj = typeof params.query === 'string' ? JSON.parse(params.query) : params.query;
            devices = devices.filter(d => matchesQuery(d, queryObj));
          } catch (e) {
            logger.debug(`[BuiltinACS] Query parse error: ${e.message}`);
          }
        }
        
        return { data: devices, status: 200 };
      }
      
      // GET /devices/:id
      const deviceMatch = url.match(/^\/devices\/(.+)$/);
      if (deviceMatch) {
        const deviceId = decodeURIComponent(deviceMatch[1]);
        const row = db.prepare('SELECT * FROM acs_devices WHERE id = ?').get(deviceId);
        if (!row) {
          const err = new Error(`Device ${deviceId} not found`);
          err.response = { status: 404, data: 'Not found' };
          throw err;
        }
        return { data: builtinRowToDevice(row), status: 200 };
      }
      
      return { data: [], status: 200 };
    },
    
    post: async (url, data = {}, config = {}) => {
      // POST /devices/:id/tasks
      const taskMatch = url.match(/^\/devices\/(.+)\/tasks$/);
      if (taskMatch) {
        const deviceId = decodeURIComponent(taskMatch[1]);
        const taskName = data.name || 'unknown';
        const payload = JSON.stringify(data);
        const now = new Date().toISOString();
        
        try {
          const result = db.prepare(
            'INSERT INTO acs_tasks (device_id, name, payload, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
          ).run(deviceId, taskName, payload, 'pending', now, now);
          
          logger.info(`[BuiltinACS] Task '${taskName}' created for device ${deviceId}, id=${result.lastInsertRowid}`);
          
          // Trigger connection request asynchronously
          try {
            const acsService = require('../services/acsServerService');
            acsService.triggerConnectionRequest(deviceId).catch(() => {});
          } catch (e) { /* service not loaded yet */ }
          
          return { data: { _id: String(result.lastInsertRowid), name: taskName, device: deviceId }, status: 202 };
        } catch (e) {
          logger.error(`[BuiltinACS] Error creating task: ${e.message}`);
          return { data: {}, status: 500 };
        }
      }
      
      return { data: {}, status: 200 };
    },
    
    put: async (url, data = {}, config = {}) => {
      // PUT /devices/:id — update tags
      const deviceMatch = url.match(/^\/devices\/(.+)$/);
      if (deviceMatch) {
        const deviceId = decodeURIComponent(deviceMatch[1]);
        const now = new Date().toISOString();
        
        if (data._tags) {
          try {
            db.prepare('UPDATE acs_devices SET tags = ?, updated_at = ? WHERE id = ?')
              .run(JSON.stringify(data._tags), now, deviceId);
            return { data: {}, status: 200 };
          } catch (e) {
            logger.error(`[BuiltinACS] Error updating tags: ${e.message}`);
          }
        }
      }
      return { data: {}, status: 200 };
    },
    
    delete: async (url, config = {}) => {
      const deviceMatch = url.match(/^\/devices\/(.+)$/);
      if (deviceMatch) {
        const deviceId = decodeURIComponent(deviceMatch[1]);
        try {
          db.prepare('DELETE FROM acs_devices WHERE id = ?').run(deviceId);
          db.prepare('DELETE FROM acs_tasks WHERE device_id = ?').run(deviceId);
          return { data: {}, status: 200 };
        } catch (e) {
          logger.error(`[BuiltinACS] Error deleting device: ${e.message}`);
        }
      }
      return { data: {}, status: 200 };
    }
  };
}

// Import WhatsApp notification function
let sendMonitoringAlert = null;
(async () => {
  try {
    const whatsappBot = await import('../services/whatsappBot.mjs');
    sendMonitoringAlert = whatsappBot.sendMonitoringAlert;
    logger.info('[GenieACS] WhatsApp monitoring alert integration loaded');
  } catch (error) {
    logger.warn('[GenieACS] WhatsApp bot not available for monitoring alerts');
  }
})();

// Konfigurasi GenieACS API (Legacy - untuk backward compatibility)
const GENIEACS_URL = process.env.GENIEACS_URL || 'http://localhost:7557';
const GENIEACS_USERNAME = process.env.GENIEACS_USERNAME;
const GENIEACS_PASSWORD = process.env.GENIEACS_PASSWORD;

// Helper: Get all ACS servers from database
function getAllACSServers() {
    try {
        const servers = [];

        if (isBuiltinAcsEnabled()) {
            servers.push({
                id: 'builtin',
                name: 'Built-in ACS',
                url: 'local',
                status: 'active'
            });
        }

        const legacyUrl = getSetting('genieacs_url', GENIEACS_URL);
        const legacyUser = getSetting('genieacs_username', GENIEACS_USERNAME);
        const legacyPass = getSetting('genieacs_password', GENIEACS_PASSWORD);
        // Add legacy server if configured
        if (legacyUrl) {
            servers.push({
                id: 'legacy',
                name: 'Default ACS',
                url: legacyUrl,
                username: legacyUser,
                password: legacyPass,
                status: 'active'
            });
        }
        
        // Add servers from database
        const dbServers = db.prepare('SELECT * FROM genieacs_servers WHERE status = ?').all('active');
        servers.push(...dbServers);
        
        return servers;
    } catch (error) {
        logger.error(`[GenieACS] Error getting ACS servers: ${error.message}`);
        return [];
    }
}

// Helper: Get specific ACS server by ID
function getACSServer(serverId) {
    if (!serverId) {
        if (isBuiltinAcsEnabled()) {
            return {
                id: 'builtin',
                name: 'Built-in ACS',
                url: 'local',
                status: 'active'
            };
        }
        const legacyUrl = getSetting('genieacs_url', GENIEACS_URL);
        const legacyUser = getSetting('genieacs_username', GENIEACS_USERNAME);
        const legacyPass = getSetting('genieacs_password', GENIEACS_PASSWORD);
        if (legacyUrl) {
            return {
                id: 'legacy',
                name: 'Default ACS',
                url: legacyUrl,
                username: legacyUser,
                password: legacyPass,
                status: 'active'
            };
        }
        return null;
    }

    if (serverId === 'builtin') {
        return {
            id: 'builtin',
            name: 'Built-in ACS',
            url: 'local',
            status: 'active'
        };
    }
    
    if (serverId === 'legacy') {
        const legacyUrl = getSetting('genieacs_url', GENIEACS_URL);
        const legacyUser = getSetting('genieacs_username', GENIEACS_USERNAME);
        const legacyPass = getSetting('genieacs_password', GENIEACS_PASSWORD);
        
        if (legacyUrl) {
            return {
                id: 'legacy',
                name: 'Default ACS',
                url: legacyUrl,
                username: legacyUser,
                password: legacyPass,
                status: 'active'
            };
        }
        return null;
    }
    
    try {
        const server = db.prepare('SELECT * FROM genieacs_servers WHERE id = ?').get(serverId);
        return server || null;
    } catch (error) {
        logger.error(`[GenieACS] Error getting ACS server ${serverId}: ${error.message}`);
        return null;
    }
}

// Helper: Create axios instance for specific server
function createAxiosInstance(server) {
    // Built-in ACS: return proxy object that mimics axios but uses SQLite
    if (server && (server.id === 'builtin' || server.url === 'local')) {
        return createBuiltinAxiosProxy();
    }
    
    const config = {
        baseURL: server.url.endsWith('/') ? server.url.slice(0, -1) : server.url,
        timeout: 30000,
        headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json'
        }
    };
    
    if (server.username && server.password) {
        config.auth = {
            username: server.username,
            password: server.password
        };
    }
    
    return axios.create(config);
}

// Legacy axios instance (untuk backward compatibility)
const axiosInstance = axios.create({
    baseURL: GENIEACS_URL,
    timeout: 30000,
    auth: {
        username: GENIEACS_USERNAME,
        password: GENIEACS_PASSWORD
    },
    headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json'
    }
});

// GenieACS API wrapper
const genieacsApi = {
    // Get devices from all servers or specific server
    async getDevices(serverId = null) {
        try {
            logger.debug('[GenieACS] Getting all devices...');
            
            const servers = serverId ? [getACSServer(serverId)].filter(Boolean) : getAllACSServers();
            const allDevices = [];
            
            for (const server of servers) {
                try {
                    const instance = createAxiosInstance(server);
                    let response;
                    try {
                        response = await instance.get('/devices', {
                            timeout: 45000
                        });
                    } catch (e) {
                        response = await instance.get('/api/devices', {
                            timeout: 45000
                        });
                    }
                    
                    const devices = response.data || [];
                    // Add server info to each device
                    devices.forEach(device => {
                        device._acs_server_id = server.id;
                        device._acs_server_name = server.name;
                    });
                    
                    allDevices.push(...devices);
                    logger.debug(`[GenieACS] Found ${devices.length} devices from ${server.name}`);
                } catch (error) {
                    logger.error(`[GenieACS] Error getting devices from ${server.name}: ${error.message}`);
                }
            }
            
            logger.debug(`[GenieACS] Total devices found: ${allDevices.length}`);
            return allDevices;
        } catch (error) {
            logger.error(`[GenieACS] Error getting devices: ${error.message}`);
            throw error;
        }
    },

    // Find device by phone number across all servers (returns full device data)
    async findDeviceByPhoneNumber(phoneNumber, serverId = null) {
        try {
            logger.debug(`[GenieACS] Finding device with phone number: ${phoneNumber}`);
            
            const servers = serverId ? [getACSServer(serverId)].filter(Boolean) : getAllACSServers();
            
            for (const server of servers) {
                try {
                    const instance = createAxiosInstance(server);
                    // Don't use projection - get full device data
                    let response;
                    try {
                        response = await instance.get('/devices', {
                            params: {
                                'query': JSON.stringify({
                                    '_tags': phoneNumber
                                })
                            },
                            timeout: 15000
                        });
                    } catch (e) {
                        response = await instance.get('/api/devices', {
                            params: {
                                'query': JSON.stringify({
                                    '_tags': phoneNumber
                                })
                            },
                            timeout: 15000
                        });
                    }

                    if (response.data && response.data.length > 0) {
                        const device = response.data[0];
                        device._acs_server_id = server.id;
                        device._acs_server_name = server.name;
                        logger.debug(`[GenieACS] Device found on ${server.name} with full data`);
                        return device;
                    }
                } catch (error) {
                    logger.debug(`[GenieACS] Device not found on ${server.name}: ${error.message}`);
                }
            }
            
            throw new Error(`No device found with phone number: ${phoneNumber}`);
        } catch (error) {
            logger.error(`[GenieACS] Error finding device with phone number ${phoneNumber}: ${error.message}`);
            throw error;
        }
    },

    async getDeviceByPhoneNumber(phoneNumber, serverId = null) {
        try {
            // findDeviceByPhoneNumber already returns full device data
            return await this.findDeviceByPhoneNumber(phoneNumber, serverId);
        } catch (error) {
            logger.error(`[GenieACS] Error getting device by phone number ${phoneNumber}: ${error.message}`);
            throw error;
        }
    },

    async getDevice(deviceId, serverId = null) {
        try {
            // If serverId provided, use that server
            if (serverId) {
                const server = getACSServer(serverId);
                if (!server) {
                    throw new Error(`ACS Server ${serverId} not found`);
                }
                const instance = createAxiosInstance(server);
                const response = await instance.get(`/devices/${encodeURIComponent(deviceId)}`);
                const device = response.data;
                device._acs_server_id = server.id;
                device._acs_server_name = server.name;
                return device;
            }
            
            // Otherwise, search all servers
            const servers = getAllACSServers();
            for (const server of servers) {
                try {
                    const instance = createAxiosInstance(server);
                    const response = await instance.get(`/devices/${encodeURIComponent(deviceId)}`);
                    const device = response.data;
                    device._acs_server_id = server.id;
                    device._acs_server_name = server.name;
                    return device;
                } catch (error) {
                    // Continue to next server
                }
            }
            
            throw new Error(`Device ${deviceId} not found on any server`);
        } catch (error) {
            logger.error(`[GenieACS] Error getting device ${deviceId}: ${error.message}`);
            throw error;
        }
    },

    async setParameterValues(deviceId, parameters, serverId = null) {
        try {
            logger.debug(`[GenieACS] Setting parameters for device: ${deviceId}`);

            // Format parameter values untuk GenieACS
            const parameterValues = [];
            for (const [path, value] of Object.entries(parameters)) {
                // Handle SSID update
                if (path.includes('SSID')) {
                    parameterValues.push(
                        ["InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID", value],
                        ["Device.WiFi.SSID.1.SSID", value]
                    );
                }
                // Handle WiFi password update
                else if (path.includes('Password') || path.includes('KeyPassphrase')) {
                    parameterValues.push(
                        ["InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.PreSharedKey.1.KeyPassphrase", value],
                        ["InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.KeyPassphrase", value],
                        ["InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.PreSharedKey.1.PreSharedKey", value]
                    );
                }
                // Handle other parameters
                else {
                    parameterValues.push([path, value]);
                }
            }

            logger.debug(`[GenieACS] Formatted parameter values count: ${parameterValues.length}`);

            // Get server instance
            const server = serverId ? getACSServer(serverId) : (isBuiltinAcsEnabled() ? getACSServer('builtin') : null);
            const instance = server ? createAxiosInstance(server) : axiosInstance;

            // Kirim task ke GenieACS
            const task = {
                name: "setParameterValues",
                parameterValues: parameterValues
            };

            const response = await instance.post(
                `/devices/${encodeURIComponent(deviceId)}/tasks`,
                task
            );

            logger.debug('[GenieACS] Parameter update task queued');

            // Kirim refresh task
            const refreshTask = {
                name: "refreshObject",
                objectName: "InternetGatewayDevice.LANDevice.1.WLANConfiguration.1"
            };

            const refreshResponse = await instance.post(
                `/devices/${encodeURIComponent(deviceId)}/tasks`,
                refreshTask
            );

            logger.debug('[GenieACS] Refresh task queued');

            return response.data;
        } catch (error) {
            logger.error(`[GenieACS] Error setting parameters for device ${deviceId}: ${error.response?.data ? JSON.stringify(error.response.data) : error.message}`);
            throw error;
        }
    },

    async reboot(deviceId, serverId = null) {
        try {
            const server = serverId ? getACSServer(serverId) : (isBuiltinAcsEnabled() ? getACSServer('builtin') : null);
            const instance = server ? createAxiosInstance(server) : axiosInstance;
            
            const task = {
                name: "reboot",
                timestamp: new Date().toISOString()
            };
            const response = await instance.post(
                `/devices/${encodeURIComponent(deviceId)}/tasks`,
                task
            );
            return response.data;
        } catch (error) {
            logger.error(`[GenieACS] Error rebooting device ${deviceId}: ${error.response?.data ? JSON.stringify(error.response.data) : error.message}`);
            throw error;
        }
    },

    async factoryReset(deviceId, serverId = null) {
        try {
            const server = serverId ? getACSServer(serverId) : (isBuiltinAcsEnabled() ? getACSServer('builtin') : null);
            const instance = server ? createAxiosInstance(server) : axiosInstance;
            
            const task = {
                name: "factoryReset",
                timestamp: new Date().toISOString()
            };
            const response = await instance.post(
                `/devices/${encodeURIComponent(deviceId)}/tasks`,
                task
            );
            return response.data;
        } catch (error) {
            logger.error(`[GenieACS] Error factory resetting device ${deviceId}: ${error.response?.data ? JSON.stringify(error.response.data) : error.message}`);
            throw error;
        }
    },

    async getDeviceParameters(deviceId, parameterNames) {
        try {
            if (isBuiltinAcsEnabled()) {
                const instance = createBuiltinAxiosProxy();
                const response = await instance.get(`/devices/${encodeURIComponent(deviceId)}`);
                return response.data;
            }
            const queryString = parameterNames.map(name => `query=${encodeURIComponent(name)}`).join('&');
            const response = await axiosInstance.get(`/devices/${encodeURIComponent(deviceId)}?${queryString}`);
            return response.data;
        } catch (error) {
            logger.error(`[GenieACS] Error getting parameters for device ${deviceId}: ${error.response?.data ? JSON.stringify(error.response.data) : error.message}`);
            throw error;
        }
    },

    async getDeviceInfo(deviceId) {
        try {
            logger.debug(`[GenieACS] Getting device info for device ID: ${deviceId}`);
            
            // Built-in ACS mode
            if (isBuiltinAcsEnabled()) {
                const instance = createBuiltinAxiosProxy();
                const response = await instance.get(`/devices/${encodeURIComponent(deviceId)}`);
                return response.data;
            }
            
            // Mendapatkan device detail
            const deviceResponse = await axios.get(`${GENIEACS_URL}/devices/${encodeURIComponent(deviceId)}`, {
                auth: {
                    username: GENIEACS_USERNAME,
                    password: GENIEACS_PASSWORD
                }
            });

            if (!deviceResponse.data) {
                logger.warn('[GenieACS] No device data found');
                return null;
            }

            logger.debug('[GenieACS] Device data retrieved successfully');
            return deviceResponse.data;
        } catch (error) {
            logger.error(`[GenieACS] Error getting device info: ${error.response?.data ? JSON.stringify(error.response.data) : error.message}`);
            return null;
        }
    },

    async getVirtualParameters(deviceId) {
        try {
            logger.debug(`[GenieACS] Getting virtual parameters for device ID: ${deviceId}`);
            
            // Built-in ACS mode: return device data directly (params already stored)
            if (isBuiltinAcsEnabled()) {
                const instance = createBuiltinAxiosProxy();
                try {
                    const response = await instance.get(`/devices/${encodeURIComponent(deviceId)}`);
                    return response.data;
                } catch (e) {
                    return null;
                }
            }
            
            const virtualParams = [
                // Serial Number
                'InternetGatewayDevice.DeviceInfo.SerialNumber',
                'Device.DeviceInfo.SerialNumber',
                'VirtualParameters.getSerialNumber',
                
                // Device Uptime
                'InternetGatewayDevice.DeviceInfo.UpTime',
                'Device.DeviceInfo.UpTime',
                'VirtualParameters.getdeviceuptime',
                
                // PPPoE Uptime
                'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.UpTime',
                'Device.PPP.Interface.1.UpTime',
                'VirtualParameters.getpppuptime',
                
                // Active Devices
                'InternetGatewayDevice.LANDevice.1.Hosts.HostNumberOfEntries',
                'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.TotalAssociations',
                'Device.Hosts.HostNumberOfEntries',
                'VirtualParameters.activedevices',
                'VirtualParameters.getactivedevices',
                
                // RX Power
                'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.XPON.RxPower',
                'Device.XPON.Interface.1.RxPower',
                'VirtualParameters.RXPower',
                'VirtualParameters.redaman',
                
                // PON MAC
                'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.MACAddress',
                'Device.Ethernet.Interface.1.MACAddress',
                'VirtualParameters.PonMac',
                
                // WAN IP
                'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.ExternalIPAddress',
                'Device.IP.Interface.1.IPv4Address.1.IPAddress',
                'VirtualParameters.WanIP',
                
                // PPP IP
                'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.ExternalIPAddress',
                'Device.PPP.Interface.1.IPCP.LocalIPAddress',
                'VirtualParameters.pppIP',
                'VirtualParameters.pppoeIP',
                
                // Temperature
                'InternetGatewayDevice.DeviceInfo.Temperature',
                'Device.DeviceInfo.Temperature',
                'VirtualParameters.gettemp'
            ];

            // Menggunakan tasks endpoint untuk mendapatkan parameter values
            const response = await axios.post(`${GENIEACS_URL}/tasks`, [{
                name: "getParameterValues",
                parameterNames: virtualParams,
                device: deviceId
            }], {
                auth: {
                    username: GENIEACS_USERNAME,
                    password: GENIEACS_PASSWORD
                }
            });

            logger.debug('[GenieACS] Virtual parameters retrieved successfully');
            return response.data;
        } catch (error) {
            logger.error(`[GenieACS] Error getting virtual parameters: ${error.response?.data ? JSON.stringify(error.response.data) : error.message}`);
            return null;
        }
    },
};

// === AWAL PERUBAHAN: MONITORING REDAMAN TINGGI TERINTEGRASI TEMPLATE & PELANGGAN ===
async function monitorRXPower(thresholdParam = null) {
  try {
    // 1. Cek Saklar ON/OFF Monitoring
    const isEnabled = getSetting('genieacs_monitoring_enabled', false);
    if (!isEnabled) {
      logger.debug('[RXPower] Monitoring alert sedang dinonaktifkan di pengaturan.');
      return { success: true, message: 'Monitoring disabled' };
    }

    // Ambil threshold dari settings jika tidak dipassing khusus
    const threshold = thresholdParam !== null ? thresholdParam : parseFloat(getSetting('genieacs_rxpower_threshold', -27));
    logger.info(`[RXPower] Memulai pemantauan RXPower dengan threshold ${threshold} dBm`);

    const devices = await genieacsApi.getDevices();
    const criticalDevices = [];

    for (const device of devices) {
      try {
        const rxPowerPaths = [
          'VirtualParameters.RXPower',
          'VirtualParameters.redaman',
          'InternetGatewayDevice.WANDevice.1.WANPONInterfaceConfig.RXPower',
          'Device.XPON.Interface.1.Stats.RXPower'
        ];

        let rxPower = null;
        for (const path of rxPowerPaths) {
          const val = getRXPowerValue(device, path);
          if (val !== null && val !== undefined && val !== '') {
            rxPower = val;
            break;
          }
        }

        if (rxPower !== null && parseFloat(rxPower) < threshold) {
          const serialNumber = getDeviceSerialNumber(device);
          const deviceId = device._id;
          const shortDeviceId = deviceId.split('-')[2] || deviceId;

          // Ambil PPPoE username dari TR-069 jika ada
          let pppoeUsername =
            device.InternetGatewayDevice?.WANDevice?.['1']?.WANConnectionDevice?.['1']?.WANPPPConnection?.['1']?.Username?._value ||
            device.InternetGatewayDevice?.WANDevice?.['0']?.WANConnectionDevice?.['0']?.WANPPPConnection?.['0']?.Username?._value ||
            device.VirtualParameters?.pppoeUsername?._value ||
            'Unknown';

          // Jika PPPoE masih Unknown, cari dari tag
          if (pppoeUsername === 'Unknown' && Array.isArray(device._tags)) {
            const pppTag = device._tags.find(t => t.startsWith('pppoe:'));
            if (pppTag) pppoeUsername = pppTag.replace('pppoe:', '');
          }

          // Cari data lengkap pelanggan dari database billing
          const customer = findCustomerForDevice(pppoeUsername, serialNumber, deviceId, device._tags);

          criticalDevices.push({
            id: device._id,
            shortId: shortDeviceId,
            rxPower,
            serialNumber,
            lastInform: device._lastInform,
            customerName: customer ? customer.name : 'Belum Terdaftar di Billing',
            pppoeUsername: (customer && customer.pppoe_username) ? customer.pppoe_username : pppoeUsername,
            address: (customer && customer.address) ? customer.address : '-',
            phone: (customer && customer.phone) ? customer.phone : '-'
          });
        }
      } catch (deviceError) {
        logger.error(`[RXPower] Error memeriksa perangkat ${device._id}: ${deviceError.message}`);
      }
    }

    if (criticalDevices.length > 0) {
      // 2. Susun Baris Daftar Perangkat Lengkap
      let daftarPerangkatText = '';
      criticalDevices.forEach((d, idx) => {
        daftarPerangkatText += `${idx + 1}. 👤 *${d.customerName}* (PPPoE: \`${d.pppoeUsername}\`)\n`;
        daftarPerangkatText += `   📍 *Alamat:* ${d.address}\n`;
        if (d.phone && d.phone !== '-') daftarPerangkatText += `   📞 *No. WA:* ${d.phone}\n`;
        daftarPerangkatText += `   📡 *RX Power:* *${d.rxPower} dBm*\n`;
        daftarPerangkatText += `   📟 *SN:* ${d.serialNumber} (ID: ${d.shortId})\n`;
        daftarPerangkatText += `   🕒 *Last Inform:* ${d.lastInform ? new Date(d.lastInform).toLocaleString('id-ID') : '-'}\n\n`;
      });

      // 3. Ambil Template dari Database
      const defaultRedamanTmpl = 
`🚨 *PERINGATAN: REDAMAN TINGGI (DROP RX)*
Total: {{total_redaman}} Perangkat (Drop < {{threshold}} dBm)

{{daftar_perangkat}}
Mohon segera diperiksa redaman / kabel optiknya.
_Sistem Monitoring {{company}}_`;

      let tmpl = db.getAppSetting('whatsapp_device_rxpower_message', defaultRedamanTmpl) || defaultRedamanTmpl;
      const companyName = getSetting('company_header', 'Internet Service');

      let finalMessage = tmpl
        .replace(/{{daftar_perangkat}}/gi, daftarPerangkatText)
        .replace(/{{total_redaman}}/gi, String(criticalDevices.length))
        .replace(/{{threshold}}/gi, String(threshold))
        .replace(/{{company}}/gi, companyName);

      // 4. Kirim Alert ke Admin & Seluruh Teknisi
      if (sendMonitoringAlert) {
        try {
          const result = await sendMonitoringAlert(finalMessage, 'high');
          logger.info(`[RXPower] Alert terkirim ke Admin & Teknisi: ${result.message}`);
        } catch (err) {
          logger.error(`[RXPower] Gagal kirim WA alert: ${err.message}`);
        }
      }
    } else {
      logger.info('[RXPower] Semua perangkat dalam batas redaman normal.');
    }

    return { success: true, count: criticalDevices.length };
  } catch (error) {
    logger.error(`[RXPower] Error monitoring: ${error.message}`);
    return { success: false, error: error.message };
  }
}

// === AWAL FUNGSI HELPER GENIEACS SERIAL NUMBER & RXPOWER ===
// Helper function untuk mendapatkan serial number dari perangkat
function getDeviceSerialNumber(device) {
  try {
    const serialPaths = [
      'DeviceID.SerialNumber',
      'InternetGatewayDevice.DeviceInfo.SerialNumber',
      'Device.DeviceInfo.SerialNumber'
    ];
    
    for (const path of serialPaths) {
      const parts = path.split('.');
      let current = device;
      
      for (const part of parts) {
        if (!current) break;
        current = current[part];
      }
      
      if (current && current._value !== undefined) {
        return current._value;
      }
    }
    
    // Fallback ke ID perangkat jika serial number tidak ditemukan di parameter
    if (device && device._id) {
      const parts = device._id.split('-');
      if (parts.length >= 3) {
        return parts[2];
      }
      return device._id;
    }
    
    return 'Unknown';
  } catch (error) {
    logger.error('Error getting device serial number:', error);
    return 'Unknown';
  }
}

// Helper function untuk mendapatkan nilai RXPower
function getRXPowerValue(device, path) {
  try {
    const parts = path.split('.');
    let current = device;
    
    for (const part of parts) {
      if (!current) return null;
      current = current[part];
    }
    
    if (current && current._value !== undefined) {
      return current._value;
    }
    
    return null;
  } catch (error) {
    return null;
  }
}
// === AKHIR FUNGSI HELPER GENIEACS SERIAL NUMBER & RXPOWER ===

// === MONITORING PERANGKAT OFFLINE TERINTEGRASI TEMPLATE & PELANGGAN ===
async function monitorOfflineDevices(thresholdHoursParam = null) {
  try {
    // 1. Cek Saklar ON/OFF Monitoring
    const isEnabled = getSetting('genieacs_monitoring_enabled', false);
    if (!isEnabled) {
      logger.debug('[Offline] Monitoring alert sedang dinonaktifkan di pengaturan.');
      return { success: true, message: 'Monitoring disabled' };
    }

    const thresholdHours = thresholdHoursParam !== null ? thresholdHoursParam : parseInt(getSetting('genieacs_offline_threshold_hours', 24), 10);
    logger.info(`[Offline] Memulai pemantauan perangkat offline (> ${thresholdHours} jam)`);

    const devices = await genieacsApi.getDevices();
    const offlineDevices = [];
    const now = new Date();
    const thresholdMs = thresholdHours * 60 * 60 * 1000;

    for (const device of devices) {
      try {
        if (!device._lastInform) continue;

        const lastInformTime = new Date(device._lastInform).getTime();
        const timeDiff = now.getTime() - lastInformTime;

        if (timeDiff > thresholdMs) {
          const serialNumber = getDeviceSerialNumber(device);
          const deviceId = device._id;
          const shortDeviceId = deviceId.split('-')[2] || deviceId;

          let pppoeUsername =
            device.InternetGatewayDevice?.WANDevice?.['1']?.WANConnectionDevice?.['1']?.WANPPPConnection?.['1']?.Username?._value ||
            device.InternetGatewayDevice?.WANDevice?.['0']?.WANConnectionDevice?.['0']?.WANPPPConnection?.['0']?.Username?._value ||
            device.VirtualParameters?.pppoeUsername?._value ||
            'Unknown';

          if (pppoeUsername === 'Unknown' && Array.isArray(device._tags)) {
            const pppTag = device._tags.find(t => t.startsWith('pppoe:'));
            if (pppTag) pppoeUsername = pppTag.replace('pppoe:', '');
          }

          // Cari data lengkap pelanggan dari database billing
          const customer = findCustomerForDevice(pppoeUsername, serialNumber, deviceId, device._tags);

          offlineDevices.push({
            id: device._id,
            shortId: shortDeviceId,
            serialNumber,
            lastInform: device._lastInform,
            offlineHours: Math.round(timeDiff / (60 * 60 * 1000) * 10) / 10,
            customerName: customer ? customer.name : 'Belum Terdaftar di Billing',
            pppoeUsername: (customer && customer.pppoe_username) ? customer.pppoe_username : pppoeUsername,
            address: (customer && customer.address) ? customer.address : '-',
            phone: (customer && customer.phone) ? customer.phone : '-'
          });
        }
      } catch (deviceError) {
        logger.error(`[Offline] Error memeriksa perangkat ${device._id}: ${deviceError.message}`);
      }
    }

    if (offlineDevices.length > 0) {
      // 2. Susun Baris Daftar Perangkat Offline
      let daftarPerangkatText = '';
      offlineDevices.forEach((d, idx) => {
        daftarPerangkatText += `${idx + 1}. 👤 *${d.customerName}* (PPPoE: \`${d.pppoeUsername}\`)\n`;
        daftarPerangkatText += `   📍 *Alamat:* ${d.address}\n`;
        if (d.phone && d.phone !== '-') daftarPerangkatText += `   📞 *No. WA:* ${d.phone}\n`;
        daftarPerangkatText += `   ⏱️ *Offline:* *${d.offlineHours} Jam*\n`;
        daftarPerangkatText += `   📟 *SN:* ${d.serialNumber} (ID: ${d.shortId})\n`;
        daftarPerangkatText += `   🕒 *Last Inform:* ${d.lastInform ? new Date(d.lastInform).toLocaleString('id-ID') : '-'}\n\n`;
      });

      // 3. Ambil Template dari Database
      const defaultOfflineTmpl = 
`⚠️ *PERINGATAN: PERANGKAT OFFLINE*
Total: {{total_offline}} Perangkat (> {{threshold_jam}} Jam)

{{daftar_perangkat}}
Mohon tim teknisi segera melakukan pengecekan lapangan.
_Sistem Monitoring {{company}}_`;

      let tmpl = db.getAppSetting('whatsapp_device_offline_message', defaultOfflineTmpl) || defaultOfflineTmpl;
      const companyName = getSetting('company_header', 'Internet Service');

      let finalMessage = tmpl
        .replace(/{{daftar_perangkat}}/gi, daftarPerangkatText)
        .replace(/{{total_offline}}/gi, String(offlineDevices.length))
        .replace(/{{threshold_jam}}/gi, String(thresholdHours))
        .replace(/{{company}}/gi, companyName);

      // 4. Kirim Alert ke Admin & Seluruh Teknisi
      if (sendMonitoringAlert) {
        try {
          const result = await sendMonitoringAlert(finalMessage, 'medium');
          logger.info(`[Offline] Alert terkirim ke Admin & Teknisi: ${result.message}`);
        } catch (err) {
          logger.error(`[Offline] Gagal kirim WA alert: ${err.message}`);
        }
      }
    } else {
      logger.info('[Offline] Tidak ada perangkat yang offline melebihi batas threshold.');
    }

    return { success: true, count: offlineDevices.length };
  } catch (error) {
    logger.error(`[Offline] Error monitoring: ${error.message}`);
    return { success: false, error: error.message };
  }
}

// === PENJADWALAN DINAMIS SESUAI INTERVAL DATABASE ===
function scheduleMonitoring() {
  // Jalankan 5 menit setelah aplikasi start (agar Baileys & database terkoneksi sempurna)
  setTimeout(async () => {
    try {
      await monitorRXPower();
      await monitorOfflineDevices();
    } catch (e) {
      logger.error('[Monitoring] Error pemeriksaan awal: ' + e.message);
    }

    // Interval berulang (Default: setiap 6 jam atau sesuai input di database)
    const runScheduled = async () => {
      try {
        await monitorRXPower();
        await monitorOfflineDevices();
      } catch (e) {
        logger.error('[Monitoring] Error pemeriksaan berkala: ' + e.message);
      }
      
      // Ambil kembali interval dari setting (fleksibel jika baru diubah oleh admin)
      const intervalHours = Math.max(1, parseInt(getSetting('genieacs_monitoring_interval_hours', 6), 10));
      setTimeout(runScheduled, intervalHours * 60 * 60 * 1000);
    };

    const intervalHours = Math.max(1, parseInt(getSetting('genieacs_monitoring_interval_hours', 6), 10));
    setTimeout(runScheduled, intervalHours * 60 * 60 * 1000);
  }, 5 * 60 * 1000);
}
// === AKHIR PERUBAHAN: MONITORING REDAMAN TINGGI & OFFLINE ===

// Jalankan penjadwalan monitoring
scheduleMonitoring();

module.exports = {
    // Multi-server helpers
    getAllACSServers,
    getACSServer,
    createAxiosInstance,
    isBuiltinAcsEnabled,
    
    // GenieACS API methods (now support multi-server)
    getDevices: genieacsApi.getDevices,
    getDevice: genieacsApi.getDevice,
    getDeviceInfo: genieacsApi.getDeviceInfo,
    findDeviceByPhoneNumber: genieacsApi.findDeviceByPhoneNumber,
    getDeviceByPhoneNumber: genieacsApi.getDeviceByPhoneNumber,
    setParameterValues: genieacsApi.setParameterValues,
    reboot: genieacsApi.reboot,
    factoryReset: genieacsApi.factoryReset,
    getVirtualParameters: genieacsApi.getVirtualParameters,
    
    // Monitoring functions (automatically support multi-server)
    monitorRXPower,
    monitorOfflineDevices
};
