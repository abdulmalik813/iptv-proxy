import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getDb, initDatabase } from '../db';

const execFileAsync = promisify(execFile);

export interface SystemHealthReport {
  timestamp: string;
  tunAvailable: boolean;
  tunPath: string;
  wireguardInstalled: boolean;
  openvpnInstalled: boolean;
  warpInstalled: boolean;
  ipRouteInstalled: boolean;
  dbPath: string;
  dbSizeFormatted: string;
  dbWalMode: boolean;
  activeProviders: number;
  totalProviders: number;
  totalLogs: number;
  environment: {
    nodeVersion: string;
    platform: string;
    arch: string;
    uptimeSeconds: number;
  };
}

export class SystemService {
  static async getHealth(): Promise<SystemHealthReport> {
    await initDatabase();
    const db = getDb();

    // Check TUN device
    const tunPath = '/dev/net/tun';
    let tunAvailable = false;
    try {
      tunAvailable = fs.existsSync(tunPath);
    } catch {
      tunAvailable = false;
    }

    // Check binaries
    let wireguardInstalled = false;
    try {
      await execFileAsync('which', ['wg-quick']);
      wireguardInstalled = true;
    } catch {
      wireguardInstalled = false;
    }

    let openvpnInstalled = false;
    try {
      await execFileAsync('which', ['openvpn']);
      openvpnInstalled = true;
    } catch {
      openvpnInstalled = false;
    }

    let warpInstalled = false;
    try {
      await execFileAsync('which', ['warp-cli']);
      warpInstalled = true;
    } catch {
      warpInstalled = false;
    }

    let ipRouteInstalled = false;
    try {
      await execFileAsync('which', ['ip']);
      ipRouteInstalled = true;
    } catch {
      ipRouteInstalled = false;
    }

    // Database stats
    const providersRes = await db.execute('SELECT COUNT(*) as total, SUM(enabled) as active FROM iptv_providers');
    const totalProviders = Number(providersRes.rows[0]?.total || 0);
    const activeProviders = Number(providersRes.rows[0]?.active || 0);

    const logsRes = await db.execute('SELECT COUNT(*) as total FROM logs');
    const totalLogs = Number(logsRes.rows[0]?.total || 0);

    let dbWalMode = false;
    try {
      const pragmaRes = await db.execute('PRAGMA journal_mode;');
      dbWalMode = String(pragmaRes.rows[0]?.journal_mode || '').toLowerCase() === 'wal';
    } catch {
      dbWalMode = false;
    }

    const dbPath = process.env.DATABASE_PATH || '/data/iptv-proxy.db';
    let dbSizeFormatted = 'N/A';
    try {
      if (fs.existsSync(dbPath)) {
        const stat = fs.statSync(dbPath);
        const bytes = stat.size;
        if (bytes < 1024) dbSizeFormatted = `${bytes} B`;
        else if (bytes < 1024 * 1024) dbSizeFormatted = `${(bytes / 1024).toFixed(1)} KB`;
        else dbSizeFormatted = `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
      }
    } catch {
      dbSizeFormatted = 'Unknown';
    }

    return {
      timestamp: new Date().toISOString(),
      tunAvailable,
      tunPath,
      wireguardInstalled,
      openvpnInstalled,
      warpInstalled,
      ipRouteInstalled,
      dbPath,
      dbSizeFormatted,
      dbWalMode,
      activeProviders,
      totalProviders,
      totalLogs,
      environment: {
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        uptimeSeconds: Math.floor(process.uptime()),
      },
    };
  }
}
