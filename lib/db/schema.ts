export interface User {
  id: string;
  username: string;
  password_hash: string;
  session_version: number;
  created_at: string;
  updated_at: string;
}

export interface IptvProviderUser {
  id: string;
  provider_id: string;
  username: string;
  password_hash: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface IptvProvider {
  id: string;
  name: string;
  host: string;
  route: string;
  upstream_username: string;
  upstream_password: string;
  local_username: string;
  local_password: string;
  users?: IptvProviderUser[];
  is_default: number;
  cache_duration_hours: number;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export type VpnType = 'off' | 'wireguard' | 'openvpn' | 'warp';
export type VpnStatus = 'off' | 'connecting' | 'connected' | 'error';

export interface AppSettings {
  id: string;
  active_vpn_type: VpnType;
  active_vpn_profile_id: string | null;
  active_vpn_label: string | null;
  vpn_status: VpnStatus;
  vpn_last_error: string | null;
  vpn_connected_at: string | null;
  vpn_public_ip: string | null;
  vpn_country: string | null;
  log_retention_days: number;
  initial_setup_completed: number;
  updated_at: string;
}

export interface WireguardProfile {
  id: string;
  name: string;
  config: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface WireguardProfileSummary {
  id: string;
  name: string;
  address: string | null;
  endpoint: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export type OpenvpnSource = 'uploaded' | 'vpngate';

export interface OpenvpnProfile {
  id: string;
  name: string;
  config: string;
  username: string | null;
  password: string | null;
  source: OpenvpnSource;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface OpenvpnProfileSummary {
  id: string;
  name: string;
  remotes: string[];
  proto: string | null;
  dev: string | null;
  hasCredentials: boolean;
  source: OpenvpnSource;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export type LogLevel = 'debug' | 'info' | 'warning' | 'error';
export type LogSource =
  | 'auth'
  | 'provider'
  | 'vpn'
  | 'wireguard'
  | 'openvpn'
  | 'warp'
  | 'vpngate'
  | 'system'
  | 'proxy';

export interface LogEntry {
  id: string;
  timestamp: string;
  level: LogLevel;
  source: LogSource;
  category: string;
  message: string;
  metadata_json: string | null;
  created_at: string;
}

export interface VpnGateServer {
  id: string;
  ip: string;
  hostname: string;
  countryLong: string;
  countryShort: string;
  ping: number;
  speed: number;
  score: number;
  sessions: number;
  uptime: number;
  ovpnConfigBase64: string;
}

export type PublicVpnGateServer = Omit<VpnGateServer, 'ovpnConfigBase64'>;
