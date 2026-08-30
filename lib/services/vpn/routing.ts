import { execFile } from 'child_process';
import { promisify } from 'util';
import { LogService } from '../log.service';

const execFileAsync = promisify(execFile);
const BYPASS_TABLE = '100';
const RULE_PRIORITY_START = 100;
const PRIVATE_NETWORKS = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'];

function bypassPorts(): number[] {
  const raw = process.env.VPN_BYPASS_TCP_PORTS || '3000,8080';
  return Array.from(
    new Set(
      raw
        .split(',')
        .map((part) => Number.parseInt(part.trim(), 10))
        .filter((port) => Number.isInteger(port) && port > 0 && port <= 65535)
    )
  );
}

async function runIp(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('ip', args, { timeout: 8_000 });
  return stdout.trim();
}

async function deleteRule(priority: number): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    try {
      await runIp(['-4', 'rule', 'del', 'priority', String(priority)]);
    } catch {
      break;
    }
  }
}

export class RoutingService {
  /**
   * Creates a clean policy-routing table containing the container's direct
   * Docker routes before a VPN is started. Replies originating from the admin
   * and future Go proxy listen ports are forced through this table so an
   * all-traffic VPN route cannot make the services unreachable.
   */
  static async prepareBypassRouting(): Promise<void> {
    try {
      await this.cleanupBypassRouting();

      const mainRoutes = await runIp(['-4', 'route', 'show', 'table', 'main']);
      const routes = mainRoutes
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((line) => !line.includes(' dev tun') && !line.includes(' dev wg'));

      for (const route of routes) {
        const tokens = route.split(/\s+/);
        try {
          await runIp(['-4', 'route', 'add', 'table', BYPASS_TABLE, ...tokens]);
        } catch (error) {
          await LogService.debug('vpn', 'routing', `Skipped direct route snapshot entry: ${route}`, {
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }

      let priority = RULE_PRIORITY_START;
      for (const port of bypassPorts()) {
        await runIp([
          '-4',
          'rule',
          'add',
          'priority',
          String(priority),
          'ipproto',
          'tcp',
          'sport',
          String(port),
          'lookup',
          BYPASS_TABLE,
        ]);
        priority += 1;
      }

      for (const network of PRIVATE_NETWORKS) {
        await runIp([
          '-4',
          'rule',
          'add',
          'priority',
          String(priority),
          'to',
          network,
          'lookup',
          BYPASS_TABLE,
        ]);
        priority += 1;
      }

      await LogService.debug('vpn', 'routing', 'Installed VPN bypass policy routes.', {
        table: BYPASS_TABLE,
        tcp_ports: bypassPorts(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await LogService.error('vpn', 'routing', `Failed to prepare VPN bypass routing: ${message}`);
      throw new Error(`Unable to preserve inbound service routing: ${message}`);
    }
  }

  static async cleanupBypassRouting(): Promise<void> {
    const ruleCount = bypassPorts().length + PRIVATE_NETWORKS.length;
    for (let i = 0; i < ruleCount; i += 1) {
      await deleteRule(RULE_PRIORITY_START + i);
    }

    try {
      await runIp(['-4', 'route', 'flush', 'table', BYPASS_TABLE]);
    } catch {
      // The table may not exist yet.
    }
  }
}
