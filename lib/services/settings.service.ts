import { getDb, initDatabase } from '../db';
import { AppSettings, VpnStatus, VpnType } from '../db/schema';
import { LogService } from './log.service';

function rowToSettings(row: Record<string, unknown>): AppSettings {
  return {
    id: String(row.id),
    active_vpn_type: String(row.active_vpn_type) as VpnType,
    active_vpn_profile_id: row.active_vpn_profile_id ? String(row.active_vpn_profile_id) : null,
    active_vpn_label: row.active_vpn_label ? String(row.active_vpn_label) : null,
    vpn_status: String(row.vpn_status) as VpnStatus,
    vpn_last_error: row.vpn_last_error ? String(row.vpn_last_error) : null,
    vpn_connected_at: row.vpn_connected_at ? String(row.vpn_connected_at) : null,
    vpn_public_ip: row.vpn_public_ip ? String(row.vpn_public_ip) : null,
    vpn_country: row.vpn_country ? String(row.vpn_country) : null,
    log_retention_days: Number(row.log_retention_days ?? 7),
    initial_setup_completed: Number(row.initial_setup_completed ?? 0),
    updated_at: String(row.updated_at),
  };
}

export class SettingsService {
  static async getSettings(): Promise<AppSettings> {
    await initDatabase();
    const db = getDb();
    const res = await db.execute("SELECT * FROM app_settings WHERE id = 'global'");
    if (res.rows.length === 0) {
      throw new Error('Global application settings row is missing.');
    }
    return rowToSettings(res.rows[0] as unknown as Record<string, unknown>);
  }

  static async updateSettings(updates: { log_retention_days?: number }): Promise<AppSettings> {
    await initDatabase();
    const db = getDb();
    const now = new Date().toISOString();

    if (updates.log_retention_days !== undefined) {
      const days = Math.max(1, Math.min(365, Math.trunc(updates.log_retention_days)));
      await db.execute({
        sql: "UPDATE app_settings SET log_retention_days = ?, updated_at = ? WHERE id = 'global'",
        args: [days, now],
      });
      await LogService.info('system', 'settings', `Updated log retention to ${days} days.`);
      await LogService.pruneOldLogs(days);
    }

    return this.getSettings();
  }

  static async updateVpnState(state: {
    active_vpn_type?: VpnType;
    active_vpn_profile_id?: string | null;
    active_vpn_label?: string | null;
    vpn_status?: VpnStatus;
    vpn_last_error?: string | null;
    vpn_connected_at?: string | null;
    vpn_public_ip?: string | null;
    vpn_country?: string | null;
  }): Promise<void> {
    await initDatabase();
    const db = getDb();
    const now = new Date().toISOString();

    const fields: string[] = ['updated_at = ?'];
    const args: (string | number | null)[] = [now];

    const add = (column: string, value: string | null) => {
      fields.push(`${column} = ?`);
      args.push(value);
    };

    if (state.active_vpn_type !== undefined) add('active_vpn_type', state.active_vpn_type);
    if (state.active_vpn_profile_id !== undefined) add('active_vpn_profile_id', state.active_vpn_profile_id);
    if (state.active_vpn_label !== undefined) add('active_vpn_label', state.active_vpn_label);
    if (state.vpn_status !== undefined) add('vpn_status', state.vpn_status);
    if (state.vpn_last_error !== undefined) add('vpn_last_error', state.vpn_last_error);
    if (state.vpn_connected_at !== undefined) add('vpn_connected_at', state.vpn_connected_at);
    if (state.vpn_public_ip !== undefined) add('vpn_public_ip', state.vpn_public_ip);
    if (state.vpn_country !== undefined) add('vpn_country', state.vpn_country);

    args.push('global');
    await db.execute({
      sql: `UPDATE app_settings SET ${fields.join(', ')} WHERE id = ?`,
      args,
    });
  }
}
