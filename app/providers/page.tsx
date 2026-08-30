'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AlertTriangle, Edit2, FlaskConical, Plus, RefreshCw, Search, Star, Trash2, Tv, X } from 'lucide-react';
import { Sidebar } from '@/components/layout/sidebar';
import { TopBar } from '@/components/layout/top-bar';

interface ProviderItem {
  id: string;
  name: string;
  host: string;
  route: string;
  upstream_username: string;
  upstream_password?: string;
  local_username: string;
  local_password?: string;
  is_default: number;
  cache_duration_hours: number;
  enabled: number;
  created_at: string;
}

type ProviderPayload = {
  name: string;
  host: string;
  route: string;
  upstream_username: string;
  upstream_password?: string;
  local_username: string;
  local_password?: string;
  is_default: boolean;
  cache_duration_hours: number;
  enabled: boolean;
};

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  const raw = await response.text();
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { success: false, error: raw };
  }
}

export default function ProvidersPage() {
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [user, setUser] = useState<{ username: string } | null>(null);
  const [providers, setProviders] = useState<ProviderItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [pageError, setPageError] = useState<string | null>(null);

  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [name, setName] = useState('');
  const [host, setHost] = useState('');
  const [route, setRoute] = useState('');
  const [upstreamUsername, setUpstreamUsername] = useState('');
  const [upstreamPassword, setUpstreamPassword] = useState('');
  const [localUsername, setLocalUsername] = useState('');
  const [localPassword, setLocalPassword] = useState('');
  const [isDefault, setIsDefault] = useState(false);
  const [cacheHours, setCacheHours] = useState(1);
  const [enabled, setEnabled] = useState(true);

  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const loadProviders = useCallback(async () => {
    setLoading(true);
    setPageError(null);
    try {
      const [authRes, providerRes] = await Promise.all([
        fetch('/api/auth/me', { cache: 'no-store' }),
        fetch('/api/providers', { cache: 'no-store' }),
      ]);

      if (authRes.status === 401) {
        router.replace('/login');
        return;
      }

      const auth = await responseJson(authRes);
      const providerPayload = await responseJson(providerRes);
      if (auth.authenticated) setUser(auth.user as { username: string });
      if (!providerRes.ok || !providerPayload.success) {
        throw new Error(String(providerPayload.error || `Unable to load providers (HTTP ${providerRes.status}).`));
      }
      setProviders(providerPayload.data as ProviderItem[]);
    } catch (error) {
      setPageError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    void loadProviders();
  }, [loadProviders]);

  const resetForm = () => {
    setEditingId(null);
    setName('');
    setHost('http://');
    setRoute('');
    setUpstreamUsername('');
    setUpstreamPassword('');
    setLocalUsername('user');
    setLocalPassword('pass');
    setIsDefault(providers.length === 0);
    setCacheHours(1);
    setEnabled(true);
    setFormError(null);
  };

  const openCreate = () => {
    resetForm();
    setModalOpen(true);
  };

  const openEdit = (provider: ProviderItem) => {
    setEditingId(provider.id);
    setName(provider.name);
    setHost(provider.host);
    setRoute(provider.route);
    setUpstreamUsername(provider.upstream_username);
    setUpstreamPassword('••••••••');
    setLocalUsername(provider.local_username);
    setLocalPassword('••••••••');
    setIsDefault(provider.is_default === 1);
    setCacheHours(provider.cache_duration_hours);
    setEnabled(provider.enabled === 1);
    setFormError(null);
    setModalOpen(true);
  };

  const saveProvider = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setFormError(null);

    const payload: ProviderPayload = {
      name,
      host,
      route,
      upstream_username: upstreamUsername,
      local_username: localUsername,
      is_default: isDefault,
      cache_duration_hours: Number(cacheHours),
      enabled,
    };
    if (upstreamPassword && upstreamPassword !== '••••••••') payload.upstream_password = upstreamPassword;
    if (localPassword && localPassword !== '••••••••') payload.local_password = localPassword;

    try {
      const response = await fetch(editingId ? `/api/providers/${editingId}` : '/api/providers', {
        method: editingId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const result = await responseJson(response);
      if (!response.ok || !result.success) throw new Error(String(result.error || 'Failed to save provider.'));
      setModalOpen(false);
      await loadProviders();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const setDefaultProvider = async (id: string) => {
    setPageError(null);
    try {
      const response = await fetch(`/api/providers/${id}/default`, { method: 'POST' });
      const result = await responseJson(response);
      if (!response.ok || !result.success) throw new Error(String(result.error || 'Failed to set default provider.'));
      await loadProviders();
    } catch (error) {
      setPageError(error instanceof Error ? error.message : String(error));
    }
  };

  const deleteProvider = async () => {
    if (!deleteId) return;
    setDeleting(true);
    setPageError(null);
    try {
      const response = await fetch(`/api/providers/${deleteId}`, { method: 'DELETE' });
      const result = await responseJson(response);
      if (!response.ok || !result.success) throw new Error(String(result.error || 'Failed to delete provider.'));
      setDeleteId(null);
      await loadProviders();
    } catch (error) {
      setPageError(error instanceof Error ? error.message : String(error));
    } finally {
      setDeleting(false);
    }
  };

  const filtered = providers.filter((provider) => {
    const value = search.toLowerCase();
    return provider.name.toLowerCase().includes(value) || provider.route.toLowerCase().includes(value) || provider.host.toLowerCase().includes(value);
  });

  return (
    <div className="flex h-screen overflow-hidden bg-black font-mono text-neutral-200">
      <Sidebar user={user} onLogout={() => router.push('/login')} mobileOpen={mobileOpen} setMobileOpen={setMobileOpen} />
      <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
        <TopBar onToggleMobile={() => setMobileOpen(true)} />
        <main className="max-w-7xl space-y-6 p-4 sm:p-6 lg:p-8">
          <div className="flex flex-col gap-4 border-b border-neutral-800 pb-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h1 className="flex items-center gap-2 text-base font-bold uppercase tracking-tight text-white sm:text-lg"><Tv className="h-5 w-5" /> IPTV Providers</h1>
              <p className="text-xs text-neutral-500">Manage upstream Xtream accounts, local routes, credentials, and metadata cache settings.</p>
            </div>
            <div className="flex gap-2">
              <Link href="/providers/tests" className="flex items-center gap-2 border border-neutral-700 bg-black px-3 py-2 text-xs font-bold uppercase text-neutral-200 hover:border-white"><FlaskConical className="h-3.5 w-3.5" /> Account Tests</Link>
              <button onClick={openCreate} className="flex items-center gap-2 border border-white bg-white px-3.5 py-2 text-xs font-bold uppercase tracking-wider text-black hover:bg-neutral-200"><Plus className="h-3.5 w-3.5" /> Add Provider</button>
            </div>
          </div>

          {pageError && <div className="border border-rose-900 bg-rose-950/30 p-3 text-xs text-rose-300"><pre className="whitespace-pre-wrap break-all">{pageError}</pre></div>}

          <div className="flex flex-col gap-3 border border-neutral-800 bg-neutral-950 p-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="relative max-w-md flex-1">
              <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-neutral-500" />
              <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Filter by name, route, or host..." className="w-full border border-neutral-800 bg-black py-1.5 pl-9 pr-3 text-xs text-white outline-none focus:border-white" />
            </div>
            <div className="flex items-center gap-3 text-xs text-neutral-400">
              <span>Total: <strong className="text-white">{providers.length}</strong></span>
              <span>Enabled: <strong className="text-emerald-400">{providers.filter((provider) => provider.enabled === 1).length}</strong></span>
              <button onClick={() => void loadProviders()} title="Refresh" className="border border-neutral-800 bg-black p-1 text-neutral-400 hover:text-white"><RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} /></button>
            </div>
          </div>

          <div className="border border-neutral-800 bg-neutral-950">
            {loading && providers.length === 0 ? (
              <div className="p-8 text-center text-xs text-neutral-500"><RefreshCw className="mx-auto mb-2 h-4 w-4 animate-spin" />Loading providers...</div>
            ) : filtered.length === 0 ? (
              <div className="p-8 text-center text-xs text-neutral-500">No providers match this filter.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-neutral-800 bg-neutral-900 text-[10px] uppercase text-neutral-400">
                    <tr><th className="p-3">Name</th><th className="p-3">Route</th><th className="p-3">Upstream</th><th className="p-3">Cache</th><th className="p-3">Status</th><th className="p-3">Default</th><th className="p-3 text-right">Actions</th></tr>
                  </thead>
                  <tbody className="divide-y divide-neutral-900">
                    {filtered.map((provider) => (
                      <tr key={provider.id} className="hover:bg-neutral-900/40">
                        <td className="p-3 font-medium text-white">{provider.name}</td>
                        <td className="p-3"><span className="border border-neutral-800 bg-black px-2 py-0.5 text-[11px]">/{provider.route}</span></td>
                        <td className="max-w-[260px] truncate p-3 text-neutral-400" title={provider.host}>{provider.host}</td>
                        <td className="p-3 text-neutral-300">{provider.cache_duration_hours === 0 ? 'Off' : `${provider.cache_duration_hours}h`}</td>
                        <td className="p-3"><span className={provider.enabled === 1 ? 'text-emerald-400' : 'text-neutral-600'}>{provider.enabled === 1 ? 'ACTIVE' : 'DISABLED'}</span></td>
                        <td className="p-3">
                          {provider.is_default === 1 ? <span className="inline-flex items-center gap-1 bg-white px-2 py-0.5 text-[9px] font-bold text-black"><Star className="h-2.5 w-2.5 fill-black" /> DEFAULT</span> : <button onClick={() => void setDefaultProvider(provider.id)} className="border border-neutral-800 bg-black px-2 py-0.5 text-[10px] text-neutral-500 hover:text-white">Make Default</button>}
                        </td>
                        <td className="p-3 text-right">
                          <div className="flex justify-end gap-1.5">
                            <button onClick={() => openEdit(provider)} title="Edit" className="border border-neutral-800 bg-black p-1.5 text-neutral-300 hover:text-white"><Edit2 className="h-3.5 w-3.5" /></button>
                            <button onClick={() => setDeleteId(provider.id)} title="Delete" className="border border-neutral-800 bg-black p-1.5 text-neutral-400 hover:text-rose-300"><Trash2 className="h-3.5 w-3.5" /></button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </main>
      </div>

      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-xs">
          <div className="max-h-[90vh] w-full max-w-xl space-y-4 overflow-y-auto border border-neutral-800 bg-neutral-950 p-6">
            <div className="flex items-center justify-between border-b border-neutral-800 pb-3">
              <h2 className="text-sm font-bold uppercase text-white">{editingId ? 'Edit IPTV Provider' : 'Add IPTV Provider'}</h2>
              <button onClick={() => setModalOpen(false)} className="text-neutral-500 hover:text-white"><X className="h-4 w-4" /></button>
            </div>

            {formError && <div className="flex items-start gap-2 border border-rose-800 bg-rose-950/40 p-3 text-xs text-rose-300"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><pre className="whitespace-pre-wrap break-all">{formError}</pre></div>}

            <form onSubmit={saveProvider} className="space-y-4 text-xs">
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="space-y-1"><span className="block text-[11px] font-semibold uppercase text-neutral-400">Provider Name *</span><input required value={name} onChange={(event) => setName(event.target.value)} className="w-full border border-neutral-800 bg-black px-3 py-2 text-white outline-none focus:border-white" /></label>
                <label className="space-y-1"><span className="block text-[11px] font-semibold uppercase text-neutral-400">Local Route *</span><input required value={route} onChange={(event) => setRoute(event.target.value)} placeholder="bedroom" className="w-full border border-neutral-800 bg-black px-3 py-2 text-white outline-none focus:border-white" /></label>
              </div>

              <label className="space-y-1"><span className="block text-[11px] font-semibold uppercase text-neutral-400">Upstream Host URL *</span><input required type="url" value={host} onChange={(event) => setHost(event.target.value)} placeholder="http://provider.example.com:8080" className="w-full border border-neutral-800 bg-black px-3 py-2 text-white outline-none focus:border-white" /></label>

              <div className="space-y-3 border border-neutral-900 bg-black p-3">
                <div className="text-[10px] font-bold uppercase tracking-wider text-neutral-400">Upstream Xtream Credentials</div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="space-y-1"><span className="block text-[10px] uppercase text-neutral-400">Username *</span><input required value={upstreamUsername} onChange={(event) => setUpstreamUsername(event.target.value)} className="w-full border border-neutral-800 bg-neutral-950 px-2.5 py-1.5 text-white outline-none focus:border-white" /></label>
                  <label className="space-y-1"><span className="block text-[10px] uppercase text-neutral-400">Password *</span><input required={!editingId} type="password" value={upstreamPassword} onChange={(event) => setUpstreamPassword(event.target.value)} placeholder={editingId ? '•••••••• (unchanged)' : 'password'} className="w-full border border-neutral-800 bg-neutral-950 px-2.5 py-1.5 text-white outline-none focus:border-white" /></label>
                </div>
              </div>

              <div className="space-y-3 border border-neutral-900 bg-black p-3">
                <div className="text-[10px] font-bold uppercase tracking-wider text-neutral-400">Local Client Credentials</div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="space-y-1"><span className="block text-[10px] uppercase text-neutral-400">Username *</span><input required value={localUsername} onChange={(event) => setLocalUsername(event.target.value)} className="w-full border border-neutral-800 bg-neutral-950 px-2.5 py-1.5 text-white outline-none focus:border-white" /></label>
                  <label className="space-y-1"><span className="block text-[10px] uppercase text-neutral-400">Password *</span><input required={!editingId} type="password" value={localPassword} onChange={(event) => setLocalPassword(event.target.value)} placeholder={editingId ? '•••••••• (unchanged)' : 'client password'} className="w-full border border-neutral-800 bg-neutral-950 px-2.5 py-1.5 text-white outline-none focus:border-white" /></label>
                </div>
              </div>

              <div>
                <div className="mb-1 flex items-center justify-between"><span className="text-[11px] font-semibold uppercase text-neutral-400">Metadata Cache</span><span className="text-[10px] text-neutral-500">{cacheHours === 0 ? 'Disabled' : `${cacheHours}h`}</span></div>
                <input type="range" min="0" max="24" value={cacheHours} onChange={(event) => setCacheHours(Number.parseInt(event.target.value, 10))} className="w-full accent-white" />
              </div>

              <div className="flex items-center justify-between border-t border-neutral-900 pt-3">
                <label className="flex items-center gap-2 text-neutral-300"><input type="checkbox" checked={isDefault} onChange={(event) => setIsDefault(event.target.checked)} className="accent-white" /> Set as Default</label>
                <label className="flex items-center gap-2 text-neutral-300"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} className="accent-white" /> Enabled</label>
              </div>

              <div className="flex justify-end gap-2 border-t border-neutral-800 pt-4">
                <button type="button" onClick={() => setModalOpen(false)} className="border border-neutral-800 bg-black px-4 py-2 text-xs uppercase text-neutral-400 hover:text-white">Cancel</button>
                <button type="submit" disabled={saving} className="border border-white bg-white px-4 py-2 text-xs font-bold uppercase text-black hover:bg-neutral-200 disabled:opacity-50">{saving ? 'Saving...' : editingId ? 'Update Provider' : 'Create Provider'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {deleteId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-xs">
          <div className="w-full max-w-sm space-y-4 border border-neutral-800 bg-neutral-950 p-6">
            <div className="flex items-center gap-3"><AlertTriangle className="h-5 w-5 text-rose-400" /><h2 className="text-sm font-bold uppercase text-white">Delete Provider</h2></div>
            <p className="text-xs text-neutral-400">Delete this provider? Clients using its route will lose access immediately.</p>
            <div className="flex justify-end gap-2"><button onClick={() => setDeleteId(null)} className="border border-neutral-800 px-3 py-1.5 text-xs uppercase text-neutral-400">Cancel</button><button onClick={() => void deleteProvider()} disabled={deleting} className="bg-rose-600 px-3 py-1.5 text-xs font-bold uppercase text-white disabled:opacity-50">{deleting ? 'Deleting...' : 'Confirm Delete'}</button></div>
          </div>
        </div>
      )}
    </div>
  );
}
