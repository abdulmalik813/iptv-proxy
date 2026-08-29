import { getDb, initDatabase } from '../db';
import { AppSettings, VpnStatus, VpnType } from '../db/schema';
import { LogService } from './log.service';

export class SettingsService {
  static async getSettings(): Promise<AppSettings> {
    await initDatabase();
    const db = getDb();

    const res = await db.execute("SELECT * FROM app_settings WHERE id = 'global'");
    if (res.rows.length === 0) {
      const now = new Date().toISOString();
      await db.execute({
        sql: `INSERT INTO app_settings (
          id, active_vpn_type, active_vpn_profile_id, vpn_status, vpn_last_error, 
          vpn_connected_at, vpn_public_ip, vpn_country, log_retention_days, 
          initial_setup_completed, updated_at
        ) VALUES ('global', 'off', NULL, 'off', NULL, NULL, NULL, NULL, 7, 1, ?)`,
        args: [now],
      });
      return {
        id: 'global',
        active_vpn_type: 'off',
        active_vpn_profile_id: null,
        vpn_status: 'off',
        vpn_last_error: null,
        vpn_connected_at: null,
        vpn_public_ip: null,
        vpn_country: null,
        log_retention_days: 7,
        initial_setup_completed: 1,
        updated_at: now,
      };
    }

    const row = res.rows[0];
    return {
      id: String(row.id),
      active_vpn_type: String(row.active_vpn_type) as VpnType,
      active_vpn_profile_id: row.active_vpn_profile_id ? String(row.active_vpn_profile_id) : null,
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

  static async updateSettings(updates: {
    log_retention_days?: number;
  }): Promise<AppSettings> {
    await initDatabase();
    const db = getDb();
    const now = new Date().toISOString();

    if (updates.log_retention_days !== undefined) {
      await db.execute({
        sql: `UPDATE app_settings SET log_retention_days = ?, updated_at = ? WHERE id = 'global'`,
        args: [updates.log_retention_days, now],
      });

      await LogService.info('system', 'settings', `Updated log retention to ${updates.log_retention_days} days.`);
      await LogService.pruneOldLogs(updates.log_retention_days);
    }

    return this.getSettings();
  }

  static async updateVpnState(state: {
    active_vpn_type?: VpnType;
    active_vpn_profile_id?: string | null;
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

    if (state.active_vpn_type !== undefined) {
      fields.push('active_vpn_type = ?');
      args.push(state.active_vpn_type);
    }
    if (state.active_vpn_profile_id !== undefined) {
      fields.push('active_vpn_profile_id = ?');
      args.push(state.active_vpn_profile_id);
    }
    if (state.vpn_status !== undefined) {
      fields.push('vpn_status = ?');
      args.push(state.vpn_status);
    }
    if (state.vpn_last_error !== undefined) {
      fields.push('vpn_last_error = ?');
      args.push(state.vpn_last_error);
    }
    if (state.vpn_connected_at !== undefined) {
      fields.push('vpn_connected_at = ?');
      args.push(state.vpn_connected_at);
    }
    if (state.vpn_public_ip !== undefined) {
      fields.push('vpn_public_ip = ?');
      args.push(state.vpn_public_ip);
    }
    if (state.vpn_country !== undefined) {
      fields.push('vpn_country = ?');
      args.push(state.vpn_country);
    }

    args.push('global');
    await db.execute({
      sql: `UPDATE app_settings SET ${fields.join(', ')} WHERE id = ?`,
      args,
    });
  }
}
