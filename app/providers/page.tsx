'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Tv,
  Plus,
  Edit2,
  Trash2,
  CheckCircle,
  Star,
  RefreshCw,
  Search,
  Check,
  X,
  AlertTriangle,
  Play,
  ArrowRight,
  HelpCircle,
} from 'lucide-react';
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

export default function ProvidersPage() {
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [user, setUser] = useState<{ username: string } | null>(null);
  const [providers, setProviders] = useState<ProviderItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  // Modal State
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Form Fields
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

  // Delete Confirm Modal
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Route Resolver Tester State
  const [testPath, setTestPath] = useState('/bedroom/player_api.php');
  const [testResult, setTestResult] = useState<{
    matchedBy?: string;
    provider?: ProviderItem | null;
    remainingPath?: string;
    resolvedTargetUrl?: string | null;
  } | null>(null);
  const [testingRoute, setTestingRoute] = useState(false);

  const loadProviders = React.useCallback(async () => {
    try {
      const [authRes, provRes] = await Promise.all([
        fetch('/api/auth/me'),
        fetch('/api/providers'),
      ]);

      if (authRes.status === 401) {
        router.push('/login');
        return;
      }
      const authData = await authRes.json();
      if (authData.authenticated) setUser(authData.user);

      if (provRes.ok) {
        const json = await provRes.json();
        if (json.success) setProviders(json.data);
      }
    } catch {
      // Ignore
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    let ignore = false;
    async function init() {
      try {
        const [authRes, provRes] = await Promise.all([
          fetch('/api/auth/me'),
          fetch('/api/providers'),
        ]);

        if (authRes.status === 401) {
          router.push('/login');
          return;
        }
        const authData = await authRes.json();
        if (ignore) return;
        if (authData.authenticated) setUser(authData.user);

        if (provRes.ok) {
          const json = await provRes.json();
          if (ignore) return;
          if (json.success) setProviders(json.data);
        }
      } catch {
        // Ignore
      } finally {
        if (!ignore) setLoading(false);
      }
    }

    void init();
    return () => {
      ignore = true;
    };
  }, [router]);

  const openCreateModal = () => {
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
    setModalOpen(true);
  };

  const openEditModal = (p: ProviderItem) => {
    setEditingId(p.id);
    setName(p.name);
    setHost(p.host);
    setRoute(p.route);
    setUpstreamUsername(p.upstream_username);
    setUpstreamPassword('••••••••');
    setLocalUsername(p.local_username);
    setLocalPassword('••••••••');
    setIsDefault(p.is_default === 1);
    setCacheHours(p.cache_duration_hours);
    setEnabled(p.enabled === 1);
    setFormError(null);
    setModalOpen(true);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setSaving(true);

    try {
      const payload: Record<string, unknown> = {
        name,
        host,
        route,
        upstream_username: upstreamUsername,
        local_username: localUsername,
        is_default: isDefault,
        cache_duration_hours: Number(cacheHours),
        enabled,
      };

      if (upstreamPassword && upstreamPassword !== '••••••••') {
        payload.upstream_password = upstreamPassword;
      }
      if (localPassword && localPassword !== '••••••••') {
        payload.local_password = localPassword;
      }

      const url = editingId ? `/api/providers/${editingId}` : '/api/providers';
      const method = editingId ? 'PUT' : 'POST';

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        setFormError(data.error || 'Failed to save IPTV provider');
        setSaving(false);
        return;
      }

      setModalOpen(false);
      await loadProviders();
    } catch {
      setFormError('Network or server error');
    } finally {
      setSaving(false);
    }
  };

  const handleSetDefault = async (id: string) => {
    try {
      const res = await fetch(`/api/providers/${id}/default`, { method: 'POST' });
      if (res.ok) {
        await loadProviders();
      }
    } catch {
      // Ignore
    }
  };

  const handleDelete = async () => {
    if (!deleteId) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/providers/${deleteId}`, { method: 'DELETE' });
      if (res.ok) {
        setDeleteId(null);
        await loadProviders();
      }
    } catch {
      // Ignore
    } finally {
      setDeleting(false);
    }
  };

  const handleTestRoute = async (e: React.FormEvent) => {
    e.preventDefault();
    setTestingRoute(true);
    try {
      const res = await fetch('/api/providers/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: testPath }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setTestResult(data.data);
      }
    } catch {
      // Ignore
    } finally {
      setTestingRoute(false);
    }
  };

  const filteredProviders = providers.filter(
    (p) =>
      p.name.toLowerCase().includes(search.toLowerCase()) ||
      p.route.toLowerCase().includes(search.toLowerCase()) ||
      p.host.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="flex h-screen bg-black text-neutral-200 font-mono overflow-hidden">
      <Sidebar
        user={user}
        onLogout={() => router.push('/login')}
        mobileOpen={mobileOpen}
        setMobileOpen={setMobileOpen}
      />

      <div className="flex-1 flex flex-col min-w-0 overflow-y-auto">
        <TopBar onToggleMobile={() => setMobileOpen(true)} />

        <main className="p-4 sm:p-6 lg:p-8 space-y-6 max-w-7xl">
          {/* Header */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-neutral-800 pb-4">
            <div>
              <h1 className="text-base sm:text-lg font-bold text-white uppercase tracking-tight flex items-center gap-2">
                <Tv className="w-5 h-5" />
                <span>IPTV Providers</span>
              </h1>
              <p className="text-xs text-neutral-500">
                Manage upstream Xtream Codes accounts, unique local routes, caching, and credentials.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                id="btn-add-provider"
                onClick={openCreateModal}
                className="px-3.5 py-2 bg-white text-black font-bold text-xs uppercase tracking-wider hover:bg-neutral-200 transition-colors border border-white flex items-center gap-2 cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Add Provider</span>
              </button>
            </div>
          </div>

          {/* Search & Stats Bar */}
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 bg-neutral-950 border border-neutral-800 p-3">
            <div className="relative flex-1 max-w-md">
              <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Filter by name, route, or host..."
                className="w-full pl-9 pr-3 py-1.5 bg-black border border-neutral-800 text-xs text-white placeholder-neutral-600 focus:border-white focus:outline-none"
              />
            </div>
            <div className="flex items-center gap-3 text-xs text-neutral-400">
              <span>
                Total: <strong className="text-white">{providers.length}</strong>
              </span>
              <span>•</span>
              <span>
                Enabled:{' '}
                <strong className="text-emerald-400">
                  {providers.filter((p) => p.enabled === 1).length}
                </strong>
              </span>
              <button
                onClick={loadProviders}
                title="Refresh List"
                className="p-1 border border-neutral-800 bg-black hover:bg-neutral-900 text-neutral-400 hover:text-white"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
              </button>
            </div>
          </div>

          {/* Providers Table */}
          <div className="border border-neutral-800 bg-neutral-950">
            {loading && providers.length === 0 ? (
              <div className="p-8 text-center text-xs text-neutral-500">
                <RefreshCw className="w-4 h-4 animate-spin mx-auto mb-2" />
                <span>Loading providers from SQLite...</span>
              </div>
            ) : filteredProviders.length === 0 ? (
              <div className="p-8 text-center text-xs text-neutral-500 space-y-3">
                <p>No IPTV providers match your filter.</p>
                {providers.length === 0 && (
                  <button
                    onClick={openCreateModal}
                    className="px-3 py-1.5 bg-white text-black font-semibold text-xs uppercase"
                  >
                    Add Provider
                  </button>
                )}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-neutral-900 text-neutral-400 uppercase text-[10px] border-b border-neutral-800 select-none">
                    <tr>
                      <th className="p-3 font-semibold">Name</th>
                      <th className="p-3 font-semibold">Local Route</th>
                      <th className="p-3 font-semibold">Upstream Host</th>
                      <th className="p-3 font-semibold">Default</th>
                      <th className="p-3 font-semibold">Metadata Cache</th>
                      <th className="p-3 font-semibold">Enabled</th>
                      <th className="p-3 font-semibold text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-neutral-900">
                    {filteredProviders.map((p) => (
                      <tr key={p.id} className="hover:bg-neutral-900/40 transition-colors">
                        <td className="p-3 font-medium text-white">
                          <div className="flex items-center gap-2">
                            <span>{p.name}</span>
                          </div>
                        </td>
                        <td className="p-3 font-mono">
                          <span className="bg-black border border-neutral-800 px-2 py-0.5 text-[11px] text-neutral-200">
                            /{p.route}
                          </span>
                        </td>
                        <td className="p-3 text-neutral-400 truncate max-w-[200px]" title={p.host}>
                          {p.host}
                        </td>
                        <td className="p-3">
                          {p.is_default === 1 ? (
                            <span className="bg-white text-black font-bold text-[9px] px-2 py-0.5 uppercase tracking-wider inline-flex items-center gap-1">
                              <Star className="w-2.5 h-2.5 fill-black" />
                              DEFAULT
                            </span>
                          ) : (
                            <button
                              onClick={() => handleSetDefault(p.id)}
                              className="text-[10px] text-neutral-500 hover:text-white border border-neutral-800 hover:border-neutral-600 px-1.5 py-0.5 bg-black transition-colors"
                            >
                              Make Default
                            </button>
                          )}
                        </td>
                        <td className="p-3 text-neutral-300">
                          {p.cache_duration_hours === 0 ? (
                            <span className="text-neutral-500 text-[11px]">Disabled (0h)</span>
                          ) : (
                            <span className="text-[11px]">{p.cache_duration_hours}h retention</span>
                          )}
                        </td>
                        <td className="p-3">
                          {p.enabled === 1 ? (
                            <span className="text-emerald-400 text-[10px] font-semibold uppercase flex items-center gap-1">
                              <span className="w-1.5 h-1.5 bg-emerald-500 inline-block" />
                              Active
                            </span>
                          ) : (
                            <span className="text-neutral-600 text-[10px] font-semibold uppercase flex items-center gap-1">
                              <span className="w-1.5 h-1.5 bg-neutral-600 inline-block" />
                              Disabled
                            </span>
                          )}
                        </td>
                        <td className="p-3 text-right">
                          <div className="flex items-center justify-end gap-1.5">
                            <button
                              id={`btn-edit-provider-${p.id}`}
                              onClick={() => openEditModal(p)}
                              title="Edit Provider"
                              className="p-1.5 border border-neutral-800 bg-black hover:bg-neutral-900 text-neutral-300 hover:text-white transition-colors"
                            >
                              <Edit2 className="w-3.5 h-3.5" />
                            </button>
                            <button
                              id={`btn-delete-provider-${p.id}`}
                              onClick={() => setDeleteId(p.id)}
                              title="Delete Provider"
                              className="p-1.5 border border-neutral-800 bg-black hover:bg-rose-950/60 text-neutral-400 hover:text-rose-300 transition-colors"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Interactive Route Resolution Engine Tester */}
          <div className="border border-neutral-800 bg-neutral-950 p-4 sm:p-5 space-y-4">
            <div className="flex items-center gap-2 border-b border-neutral-800 pb-3">
              <Play className="w-4 h-4 text-white" />
              <div>
                <h2 className="text-xs font-bold uppercase tracking-wider text-white">
                  Route Resolution Simulator
                </h2>
                <p className="text-[11px] text-neutral-500">
                  Simulate incoming IPTV/Xtream client request paths and verify target provider routing.
                </p>
              </div>
            </div>

            <form onSubmit={handleTestRoute} className="flex flex-col sm:flex-row gap-2">
              <div className="flex-1">
                <input
                  type="text"
                  value={testPath}
                  onChange={(e) => setTestPath(e.target.value)}
                  placeholder="/bedroom/player_api.php or /get.php"
                  className="w-full px-3 py-2 bg-black border border-neutral-800 text-xs text-white font-mono focus:border-white focus:outline-none"
                />
              </div>
              <button
                type="submit"
                disabled={testingRoute}
                className="px-4 py-2 bg-white text-black font-bold text-xs uppercase tracking-wider hover:bg-neutral-200 transition-colors border border-white cursor-pointer disabled:opacity-50"
              >
                {testingRoute ? 'Testing...' : 'Test Route Resolution'}
              </button>
            </form>

            {testResult && (
              <div className="p-3 bg-black border border-neutral-900 text-xs space-y-2 font-mono">
                <div className="flex items-center justify-between border-b border-neutral-900 pb-1.5">
                  <span className="text-neutral-500 text-[10px] uppercase">Match Result:</span>
                  {testResult.matchedBy === 'route' ? (
                    <span className="text-emerald-400 font-bold text-[11px]">
                      MATCHED BY ROUTE (/{testResult.provider?.route})
                    </span>
                  ) : testResult.matchedBy === 'default' ? (
                    <span className="text-amber-400 font-bold text-[11px]">
                      ROUTED TO GLOBAL DEFAULT ({testResult.provider?.name})
                    </span>
                  ) : (
                    <span className="text-rose-400 font-bold text-[11px]">
                      NO ROUTE OR DEFAULT PROVIDER FOUND (404)
                    </span>
                  )}
                </div>

                {testResult.provider && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px]">
                    <div>
                      <span className="text-neutral-500">Provider: </span>
                      <span className="text-white font-semibold">{testResult.provider.name}</span>
                    </div>
                    <div>
                      <span className="text-neutral-500">Upstream Host: </span>
                      <span className="text-white">{testResult.provider.host}</span>
                    </div>
                    <div className="sm:col-span-2">
                      <span className="text-neutral-500">Resolved Proxy Target: </span>
                      <code className="text-emerald-300 break-all">{testResult.resolvedTargetUrl}</code>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </main>
      </div>

      {/* Add / Edit Provider Modal */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-xs">
          <div className="w-full max-w-xl border border-neutral-800 bg-neutral-950 p-6 space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-neutral-800 pb-3">
              <h2 className="text-sm font-bold text-white uppercase tracking-tight">
                {editingId ? 'Edit IPTV Provider' : 'Add New IPTV Provider'}
              </h2>
              <button
                onClick={() => setModalOpen(false)}
                className="text-neutral-500 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {formError && (
              <div className="p-3 bg-rose-950/40 border border-rose-800 text-rose-300 text-xs flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{formError}</span>
              </div>
            )}

            <form onSubmit={handleSave} className="space-y-4 text-xs">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-neutral-400 text-[11px] font-semibold mb-1 uppercase">
                    Provider Name *
                  </label>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    required
                    placeholder="Bedroom TV / Main IPTV"
                    className="w-full px-3 py-2 bg-black border border-neutral-800 text-white focus:border-white focus:outline-none"
                  />
                </div>

                <div>
                  <label className="block text-neutral-400 text-[11px] font-semibold mb-1 uppercase">
                    Local Route * (e.g. &quot;bedroom&quot;)
                  </label>
                  <div className="flex items-center">
                    <span className="px-2 py-2 bg-neutral-900 border border-r-0 border-neutral-800 text-neutral-500">
                      /
                    </span>
                    <input
                      type="text"
                      value={route}
                      onChange={(e) => setRoute(e.target.value)}
                      required
                      placeholder="bedroom"
                      className="w-full px-3 py-2 bg-black border border-neutral-800 text-white focus:border-white focus:outline-none font-mono"
                    />
                  </div>
                </div>
              </div>

              <div>
                <label className="block text-neutral-400 text-[11px] font-semibold mb-1 uppercase">
                  Upstream Host URL *
                </label>
                <input
                  type="url"
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                  required
                  placeholder="http://provider.example.com:8080"
                  className="w-full px-3 py-2 bg-black border border-neutral-800 text-white focus:border-white focus:outline-none font-mono"
                />
              </div>

              {/* Upstream Credentials */}
              <div className="p-3 bg-black border border-neutral-900 space-y-3">
                <span className="text-[10px] font-bold text-neutral-400 uppercase tracking-wider">
                  Upstream Xtream Account Credentials
                </span>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-neutral-400 text-[10px] uppercase mb-1">
                      Upstream Username *
                    </label>
                    <input
                      type="text"
                      value={upstreamUsername}
                      onChange={(e) => setUpstreamUsername(e.target.value)}
                      required
                      placeholder="provider_user"
                      className="w-full px-2.5 py-1.5 bg-neutral-950 border border-neutral-800 text-white focus:border-white focus:outline-none text-xs"
                    />
                  </div>
                  <div>
                    <label className="block text-neutral-400 text-[10px] uppercase mb-1">
                      Upstream Password *
                    </label>
                    <input
                      type="password"
                      value={upstreamPassword}
                      onChange={(e) => setUpstreamPassword(e.target.value)}
                      required={!editingId}
                      placeholder={editingId ? '•••••••• (unchanged)' : 'password'}
                      className="w-full px-2.5 py-1.5 bg-neutral-950 border border-neutral-800 text-white focus:border-white focus:outline-none text-xs"
                    />
                  </div>
                </div>
              </div>

              {/* Local Proxy Credentials */}
              <div className="p-3 bg-black border border-neutral-900 space-y-3">
                <span className="text-[10px] font-bold text-neutral-400 uppercase tracking-wider">
                  Local Client Access Credentials
                </span>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-neutral-400 text-[10px] uppercase mb-1">
                      Local Client Username *
                    </label>
                    <input
                      type="text"
                      value={localUsername}
                      onChange={(e) => setLocalUsername(e.target.value)}
                      required
                      placeholder="client_user"
                      className="w-full px-2.5 py-1.5 bg-neutral-950 border border-neutral-800 text-white focus:border-white focus:outline-none text-xs"
                    />
                  </div>
                  <div>
                    <label className="block text-neutral-400 text-[10px] uppercase mb-1">
                      Local Client Password *
                    </label>
                    <input
                      type="password"
                      value={localPassword}
                      onChange={(e) => setLocalPassword(e.target.value)}
                      required={!editingId}
                      placeholder={editingId ? '•••••••• (unchanged)' : 'client_password'}
                      className="w-full px-2.5 py-1.5 bg-neutral-950 border border-neutral-800 text-white focus:border-white focus:outline-none text-xs"
                    />
                  </div>
                </div>
              </div>

              {/* Cache Duration */}
              <div>
                <div className="flex justify-between items-center mb-1">
                  <label className="text-neutral-400 text-[11px] font-semibold uppercase">
                    Metadata Cache Duration ({cacheHours} Hours)
                  </label>
                  <span className="text-neutral-500 text-[10px]">
                    {cacheHours === 0 ? 'Disabled' : `${cacheHours}h cache`}
                  </span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="24"
                  value={cacheHours}
                  onChange={(e) => setCacheHours(parseInt(e.target.value, 10))}
                  className="w-full accent-white"
                />
                <div className="flex justify-between text-[9px] text-neutral-600 mt-0.5 font-mono">
                  <span>0h (Off)</span>
                  <span>12h</span>
                  <span>24h</span>
                </div>
              </div>

              {/* Toggles */}
              <div className="flex items-center justify-between pt-2 border-t border-neutral-900">
                <label className="flex items-center gap-2 cursor-pointer text-neutral-300">
                  <input
                    type="checkbox"
                    checked={isDefault}
                    onChange={(e) => setIsDefault(e.target.checked)}
                    className="accent-white"
                  />
                  <span>Set as Default Provider</span>
                </label>

                <label className="flex items-center gap-2 cursor-pointer text-neutral-300">
                  <input
                    type="checkbox"
                    checked={enabled}
                    onChange={(e) => setEnabled(e.target.checked)}
                    className="accent-white"
                  />
                  <span>Enabled</span>
                </label>
              </div>

              {/* Actions */}
              <div className="flex items-center justify-end gap-2 pt-4 border-t border-neutral-800">
                <button
                  type="button"
                  onClick={() => setModalOpen(false)}
                  className="px-4 py-2 border border-neutral-800 text-neutral-400 hover:text-white bg-black uppercase tracking-wider text-xs"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="px-4 py-2 bg-white text-black font-bold uppercase tracking-wider text-xs hover:bg-neutral-200 border border-white cursor-pointer disabled:opacity-50"
                >
                  {saving ? 'Saving...' : editingId ? 'Update Provider' : 'Create Provider'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deleteId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-xs">
          <div className="w-full max-w-sm border border-neutral-800 bg-neutral-950 p-6 space-y-4">
            <div className="flex items-center gap-3 text-rose-400">
              <AlertTriangle className="w-5 h-5" />
              <h2 className="text-sm font-bold uppercase tracking-tight text-white">Delete Provider</h2>
            </div>
            <p className="text-xs text-neutral-400">
              Are you sure you want to delete this provider? Any clients connecting via its route will lose access immediately.
            </p>
            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={() => setDeleteId(null)}
                className="px-3 py-1.5 border border-neutral-800 text-neutral-400 hover:text-white text-xs uppercase"
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="px-3 py-1.5 bg-rose-600 text-white font-bold text-xs uppercase hover:bg-rose-500 disabled:opacity-50"
              >
                {deleting ? 'Deleting...' : 'Confirm Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
