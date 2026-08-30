import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getDatabasePath, getDb, initDatabase } from '../db';
import { WarpService } from './vpn/warp';

const execFileAsync = promisify(execFile);

export interface SystemHealthReport {
  timestamp: string;
  tunAvailable: boolean;
  tunPath: string;
  wireguardInstalled: boolean;
  openvpnInstalled: boolean;
  warpInstalled: boolean;
  warpServiceRunning: boolean;
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

async function binaryExists(binary: string): Promise<boolean> {
  try {
    await execFileAsync('which', [binary], { timeout: 3_000 });
    return true;
  } catch {
    return false;
  }
}

export class SystemService {
  static async getHealth(): Promise<SystemHealthReport> {
    await initDatabase();
    const db = getDb();
    const tunPath = '/dev/net/tun';
    const tunAvailable = fs.existsSync(tunPath);

    const [wireguardInstalled, openvpnInstalled, ipRouteInstalled, warpInstalled] = await Promise.all([
      binaryExists('wg-quick'),
      binaryExists('openvpn'),
      binaryExists('ip'),
      WarpService.isWarpInstalled(),
    ]);
    const warpServiceRunning = warpInstalled ? (await WarpService.getStatus()).daemonRunning : false;

    const providersRes = await db.execute('SELECT COUNT(*) AS total, COALESCE(SUM(enabled), 0) AS active FROM iptv_providers');
    const logsRes = await db.execute('SELECT COUNT(*) AS total FROM logs');
    const pragmaRes = await db.execute('PRAGMA journal_mode;');
    const dbWalMode = String(pragmaRes.rows[0]?.journal_mode || '').toLowerCase() === 'wal';

    const dbPath = getDatabasePath();
    let dbSizeFormatted = '0 B';
    try {
      const bytes = fs.statSync(dbPath).size;
      if (bytes < 1024) dbSizeFormatted = `${bytes} B`;
      else if (bytes < 1024 * 1024) dbSizeFormatted = `${(bytes / 1024).toFixed(1)} KB`;
      else dbSizeFormatted = `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
    } catch {
      dbSizeFormatted = 'Unavailable';
    }

    return {
      timestamp: new Date().toISOString(),
      tunAvailable,
      tunPath,
      wireguardInstalled,
      openvpnInstalled,
      warpInstalled,
      warpServiceRunning,
      ipRouteInstalled,
      dbPath,
      dbSizeFormatted,
      dbWalMode,
      activeProviders: Number(providersRes.rows[0]?.active || 0),
      totalProviders: Number(providersRes.rows[0]?.total || 0),
      totalLogs: Number(logsRes.rows[0]?.total || 0),
      environment: {
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        uptimeSeconds: Math.floor(process.uptime()),
      },
    };
  }
}
