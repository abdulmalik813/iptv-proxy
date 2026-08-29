import { execFile } from 'child_process';
import { promisify } from 'util';
import { LogService } from '../log.service';

const execFileAsync = promisify(execFile);

export interface WarpStatusResult {
  installed: boolean;
  registered: boolean;
  connected: boolean;
  mode?: string;
  accountType?: string;
  deviceId?: string;
  details: string;
}

export class WarpService {
  /**
   * Checks if warp-cli is installed in the Linux environment
   */
  static async isWarpInstalled(): Promise<boolean> {
    try {
      await execFileAsync('which', ['warp-cli']);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Retrieves full status and registration info from warp-cli
   */
  static async getStatus(): Promise<WarpStatusResult> {
    const installed = await this.isWarpInstalled();
    if (!installed) {
      return {
        installed: false,
        registered: false,
        connected: false,
        details: 'Cloudflare WARP client (warp-cli) is not installed in the current environment.',
      };
    }

    try {
      const { stdout: statusOut } = await execFileAsync('warp-cli', ['--accept-tos', 'status']);
      const isConnected = statusOut.toLowerCase().includes('connected') && !statusOut.toLowerCase().includes('disconnected');

      let isRegistered = false;
      let accountType = 'Free';
      let deviceId = '';

      try {
        const { stdout: regOut } = await execFileAsync('warp-cli', ['--accept-tos', 'registration', 'show']);
        isRegistered = !regOut.toLowerCase().includes('not registered') && !regOut.toLowerCase().includes('error');
        
        const deviceMatch = regOut.match(/Device\s*ID:\s*([a-f0-9-]+)/i);
        if (deviceMatch) deviceId = deviceMatch[1];

        const accountMatch = regOut.match(/Account\s*Type:\s*([^\n]+)/i);
        if (accountMatch) accountType = accountMatch[1].trim();
      } catch {
        // Not registered
      }

      return {
        installed: true,
        registered: isRegistered,
        connected: isConnected,
        accountType,
        deviceId: deviceId || undefined,
        details: statusOut.trim(),
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        installed: true,
        registered: false,
        connected: false,
        details: `WARP query error: ${msg}`,
      };
    }
  }

  /**
   * Registers a new Cloudflare WARP client instance
   */
  static async register(): Promise<{ success: boolean; message: string }> {
    const installed = await this.isWarpInstalled();
    if (!installed) {
      throw new Error('warp-cli binary not found in container.');
    }

    try {
      const { stdout } = await execFileAsync('warp-cli', ['--accept-tos', 'registration', 'new']);
      await LogService.info('warp', 'registration', 'Registered new Cloudflare WARP device token.');
      return { success: true, message: stdout.trim() || 'Registration successful.' };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      await LogService.error('warp', 'registration', `Failed to register WARP device: ${msg}`);
      throw new Error(`WARP Registration failed: ${msg}`);
    }
  }

  /**
   * Connects to Cloudflare WARP
   */
  static async connect(): Promise<{ success: boolean; error?: string }> {
    const installed = await this.isWarpInstalled();
    if (!installed) {
      return { success: false, error: 'warp-cli binary not installed.' };
    }

    try {
      await execFileAsync('warp-cli', ['--accept-tos', 'connect']);
      return { success: true };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: msg };
    }
  }

  /**
   * Disconnects from Cloudflare WARP
   */
  static async disconnect(): Promise<{ success: boolean; error?: string }> {
    const installed = await this.isWarpInstalled();
    if (!installed) {
      return { success: true };
    }

    try {
      await execFileAsync('warp-cli', ['--accept-tos', 'disconnect']);
      return { success: true };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: msg };
    }
  }

  /**
   * Resets/re-registers WARP
   */
  static async reset(): Promise<{ success: boolean; message: string }> {
    const installed = await this.isWarpInstalled();
    if (!installed) {
      throw new Error('warp-cli binary not found.');
    }

    try {
      await this.disconnect();
      await execFileAsync('warp-cli', ['--accept-tos', 'registration', 'delete']);
      const res = await this.register();
      await LogService.warn('warp', 'reset', 'Cloudflare WARP credentials reset and re-registered.');
      return res;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      await LogService.error('warp', 'reset', `WARP Reset failed: ${msg}`);
      throw new Error(`WARP Reset failed: ${msg}`);
    }
  }
}
