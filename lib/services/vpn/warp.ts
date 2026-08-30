import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { LogService } from '../log.service';

const execFileAsync = promisify(execFile);

export interface WarpStatusResult {
  installed: boolean;
  daemonRunning: boolean;
  registered: boolean;
  connected: boolean;
  mode?: string;
  accountType?: string;
  deviceId?: string;
  details: string;
}

async function runWarp(args: string[], timeout = 10_000): Promise<string> {
  const { stdout } = await execFileAsync('warp-cli', ['--accept-tos', ...args], { timeout });
  return stdout.trim();
}

export class WarpService {
  static async isWarpInstalled(): Promise<boolean> {
    try {
      await execFileAsync('which', ['warp-cli'], { timeout: 3_000 });
      await execFileAsync('which', ['warp-svc'], { timeout: 3_000 });
      return true;
    } catch { return false; }
  }

  static async ensureDaemon(): Promise<boolean> {
    if (!(await this.isWarpInstalled())) return false;
    try { await runWarp(['status'], 4_000); return true; } catch {}
    try {
      const proc = spawn('warp-svc', [], { detached: true, stdio: 'ignore' });
      proc.on('error', () => {});
      proc.unref();
      for (let i = 0; i < 10; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        try { await runWarp(['status'], 4_000); return true; } catch {}
      }
    } catch { return false; }
    return false;
  }

  static async getStatus(): Promise<WarpStatusResult> {
    const installed = await this.isWarpInstalled();
    if (!installed) return { installed:false, daemonRunning:false, registered:false, connected:false, details:'Cloudflare WARP client is not installed in this environment.' };
    const daemonRunning = await this.ensureDaemon();
    if (!daemonRunning) return { installed:true, daemonRunning:false, registered:false, connected:false, details:'warp-svc is installed but its service socket is not available.' };
    try {
      const statusOut = await runWarp(['status']);
      const lower = statusOut.toLowerCase();
      const connected = /\bconnected\b/.test(lower) && !/\bdisconnected\b/.test(lower);
      let registered = false;
      let accountType = 'Free';
      let deviceId = '';
      try {
        const registration = await runWarp(['registration', 'show']);
        const registrationLower = registration.toLowerCase();
        registered = !registrationLower.includes('not registered') && !registrationLower.includes('error');
        const deviceMatch = registration.match(/Device\s*ID:\s*([^\s]+)/i);
        if (deviceMatch) deviceId = deviceMatch[1];
        const accountMatch = registration.match(/Account\s*Type:\s*([^\n]+)/i);
        if (accountMatch) accountType = accountMatch[1].trim();
      } catch { registered = false; }
      let mode: string | undefined;
      try {
        const settings = await runWarp(['settings']);
        const modeMatch = settings.match(/Mode:\s*([^\n]+)/i);
        if (modeMatch) mode = modeMatch[1].trim();
      } catch {}
      return { installed:true, daemonRunning:true, registered, connected, accountType, deviceId:deviceId||undefined, mode, details:statusOut };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { installed:true, daemonRunning:true, registered:false, connected:false, details:`WARP status error: ${message}` };
    }
  }

  static async register(): Promise<{ success: boolean; message: string }> {
    if (!(await this.ensureDaemon())) throw new Error('Cloudflare WARP service is unavailable.');
    const current = await this.getStatus();
    if (current.registered) return { success:true, message:'WARP client is already registered.' };
    try {
      const output = await runWarp(['registration', 'new'], 20_000);
      try { await runWarp(['mode', 'warp']); } catch {}
      await LogService.info('warp', 'registration', 'Registered a new Cloudflare WARP device.');
      return { success:true, message:output || 'Registration successful.' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await LogService.error('warp', 'registration', `Failed to register WARP device: ${message}`);
      throw new Error(`WARP registration failed: ${message}`);
    }
  }

  static async connect(): Promise<{ success: boolean; error?: string }> {
    try {
      if (!(await this.ensureDaemon())) return { success:false, error:'warp-svc is unavailable.' };
      const current = await this.getStatus();
      if (!current.registered) await this.register();
      try { await runWarp(['mode', 'warp']); } catch {}
      await runWarp(['connect'], 20_000);
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 750));
        if ((await this.getStatus()).connected) return { success:true };
      }
      return { success:false, error:'Cloudflare WARP did not reach Connected state within 30 seconds.' };
    } catch (error) { return { success:false, error:error instanceof Error ? error.message : String(error) }; }
  }

  static async disconnect(): Promise<{ success: boolean; error?: string }> {
    if (!(await this.isWarpInstalled())) return { success:true };
    try {
      if (!(await this.ensureDaemon())) return { success:true };
      await runWarp(['disconnect'], 15_000);
      return { success:true };
    } catch (error) { return { success:false, error:error instanceof Error ? error.message : String(error) }; }
  }

  static async rotate(): Promise<{ success: boolean; message: string; reconnected: boolean }> {
    if (!(await this.ensureDaemon())) throw new Error('Cloudflare WARP service is unavailable.');
    const before = await this.getStatus();
    const wasConnected = before.connected;
    try {
      if (wasConnected) await this.disconnect();
      try { await runWarp(['registration', 'delete'], 15_000); } catch {}
      await this.register();
      if (wasConnected) {
        const reconnect = await this.connect();
        if (!reconnect.success) throw new Error(reconnect.error || 'WARP did not reconnect after rotation.');
      }
      await LogService.warn('warp', 'rotate', `Cloudflare WARP registration was rotated${wasConnected ? ' and the tunnel was reconnected' : ''}.`);
      return { success:true, message:'WARP registration rotated successfully.', reconnected:wasConnected };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await LogService.error('warp', 'rotate', `WARP rotation failed: ${message}`);
      throw new Error(`WARP rotation failed: ${message}`);
    }
  }
}
