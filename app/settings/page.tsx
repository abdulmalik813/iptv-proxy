'use client';

import * as React from 'react';
import { Database, HardDrive, KeyRound, Save, Server, Settings2 } from 'lucide-react';
import { AppShell } from '@/components/layout/app-shell';
import { PageHeader } from '@/components/layout/page-header';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiPath, readJson } from '@/lib/client/api';

interface AppSettings {
  id: string;
  active_vpn_type: string;
  active_vpn_profile_id: string | null;
  vpn_status: string;
  public_ip: string | null;
  log_retention_days: number;
  initial_setup_completed: number;
}

interface HealthData {
  dbPath: string;
  dbSizeFormatted: string;
  dbWalMode: boolean;
  totalProviders: number;
  activeProviders: number;
  totalLogs: number;
  environment: {
    nodeVersion: string;
    platform: string;
    arch: string;
    uptimeSeconds: number;
  };
}

type Envelope<T = unknown> = {
  success?: boolean;
  data?: T;
  error?: string;
  message?: string;
};

function formatUptime(seconds = 0) {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  return days > 0 ? `${days}d ${hours}h` : `${hours}h ${minutes}m`;
}

function DetailRows({ rows }: { rows: Array<[string, React.ReactNode]> }) {
  return (
    <div className="divide-y rounded-lg border">
      {rows.map(([label, value]) => (
        <div key={label} className="flex items-start justify-between gap-6 px-4 py-3 text-sm">
          <span className="text-muted-foreground">{label}</span>
          <span className="max-w-[65%] break-words text-right font-medium">{value}</span>
        </div>
      ))}
    </div>
  );
}

export default function SettingsPage() {
  const [settings, setSettings] = React.useState<AppSettings | null>(null);
  const [health, setHealth] = React.useState<HealthData | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [logRetentionDays, setLogRetentionDays] = React.useState(30);
  const [saving, setSaving] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const [currentPassword, setCurrentPassword] = React.useState('');
  const [newPassword, setNewPassword] = React.useState('');
  const [confirmPassword, setConfirmPassword] = React.useState('');
  const [passwordSaving, setPasswordSaving] = React.useState(false);
  const [passwordError, setPasswordError] = React.useState<string | null>(null);
  const [passwordMessage, setPasswordMessage] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [settingsResponse, healthResponse] = await Promise.all([
        fetch(apiPath('/api/settings'), { cache: 'no-store' }),
        fetch(apiPath('/api/system/health'), { cache: 'no-store' }),
      ]);
      const [settingsPayload, healthPayload] = await Promise.all([
        readJson<Envelope<AppSettings>>(settingsResponse),
        readJson<Envelope<HealthData>>(healthResponse),
      ]);
      if (!settingsResponse.ok || !settingsPayload.success || !settingsPayload.data) {
        throw new Error(settingsPayload.error || 'Unable to load settings.');
      }
      setSettings(settingsPayload.data);
      setLogRetentionDays(settingsPayload.data.log_retention_days || 30);
      if (healthResponse.ok && healthPayload.success && healthPayload.data) setHealth(healthPayload.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(apiPath('/api/settings'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ log_retention_days: Number(logRetentionDays) }),
      });
      const payload = await readJson<Envelope<AppSettings>>(response);
      if (!response.ok || !payload.success) throw new Error(payload.error || 'Unable to save settings.');
      if (payload.data) setSettings(payload.data);
      setMessage('Settings saved.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const changePassword = async (event: React.FormEvent) => {
    event.preventDefault();
    setPasswordSaving(true);
    setPasswordError(null);
    setPasswordMessage(null);
    try {
      if (newPassword.length < 8) throw new Error('New password must contain at least 8 characters.');
      if (newPassword !== confirmPassword) throw new Error('New password confirmation does not match.');
      const response = await fetch(apiPath('/api/auth/password'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
      });
      const payload = await readJson<Envelope>(response);
      if (!response.ok || !payload.success) throw new Error(payload.error || 'Unable to update password.');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setPasswordMessage(payload.message || 'Password updated. Other sessions were signed out.');
    } catch (err) {
      setPasswordError(err instanceof Error ? err.message : String(err));
    } finally {
      setPasswordSaving(false);
    }
  };

  return (
    <AppShell>
      <PageHeader title="Settings" description="Security, retention, storage, and runtime information." />

      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
      {message && <Alert variant="success"><AlertDescription>{message}</AlertDescription></Alert>}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><KeyRound className="size-4" />Administrator password</CardTitle>
            <CardDescription>Changing your password signs out every other administrator session immediately.</CardDescription>
          </CardHeader>
          <CardContent>
            {passwordError && <Alert variant="destructive" className="mb-5"><AlertDescription>{passwordError}</AlertDescription></Alert>}
            {passwordMessage && <Alert variant="success" className="mb-5"><AlertDescription>{passwordMessage}</AlertDescription></Alert>}
            <form onSubmit={changePassword} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="current-password">Current password</Label>
                <Input id="current-password" type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} autoComplete="current-password" required />
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="new-password">New password</Label>
                  <Input id="new-password" type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} autoComplete="new-password" minLength={8} required />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="confirm-password">Confirm password</Label>
                  <Input id="confirm-password" type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} autoComplete="new-password" minLength={8} required />
                </div>
              </div>
              <Button type="submit" disabled={passwordSaving}>{passwordSaving ? 'Updating…' : 'Update password'}</Button>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Settings2 className="size-4" />Log retention</CardTitle>
            <CardDescription>Choose how long historical application logs remain in SQLite.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={save} className="space-y-5">
              <div className="space-y-2">
                <Label htmlFor="log-retention-days">Retention period</Label>
                <div className="flex max-w-xs items-center gap-2">
                  <Input id="log-retention-days" type="number" min={1} max={365} value={logRetentionDays} onChange={(event) => setLogRetentionDays(Number.parseInt(event.target.value, 10) || 1)} disabled={loading} />
                  <span className="text-sm text-muted-foreground">days</span>
                </div>
                <p className="text-xs text-muted-foreground">Valid range: 1–365 days.</p>
              </div>
              <Button type="submit" disabled={saving || loading}><Save />{saving ? 'Saving…' : 'Save settings'}</Button>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Database className="size-4" />Storage</CardTitle>
            <CardDescription>Current SQLite database state.</CardDescription>
          </CardHeader>
          <CardContent>
            <DetailRows rows={[
              ['Database', health?.dbPath || '/data/iptv-proxy.db'],
              ['Journal mode', health?.dbWalMode ? <Badge key="wal" variant="success">WAL</Badge> : <Badge key="standard" variant="secondary">Standard</Badge>],
              ['Size', health?.dbSizeFormatted || 'N/A'],
              ['Providers', `${health?.activeProviders ?? 0} enabled / ${health?.totalProviders ?? 0} total`],
              ['Log records', health?.totalLogs ?? 0],
            ]} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Server className="size-4" />Runtime</CardTitle>
            <CardDescription>Host process information reported by the application.</CardDescription>
          </CardHeader>
          <CardContent>
            <DetailRows rows={[
              ['Node.js', health?.environment.nodeVersion || 'N/A'],
              ['Platform', health ? `${health.environment.platform} / ${health.environment.arch}` : 'N/A'],
              ['Uptime', formatUptime(health?.environment.uptimeSeconds)],
              ['Setup', settings?.initial_setup_completed ? <Badge key="complete" variant="success">Complete</Badge> : <Badge key="pending" variant="warning">Pending</Badge>],
            ]} />
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><HardDrive className="size-4" />Network state</CardTitle>
            <CardDescription>Persisted VPN state recorded by the control plane.</CardDescription>
          </CardHeader>
          <CardContent>
            <DetailRows rows={[
              ['VPN', settings?.active_vpn_type || 'off'],
              ['Status', settings?.vpn_status || 'off'],
              ['Public IP', settings?.public_ip || 'Unknown'],
            ]} />
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}
