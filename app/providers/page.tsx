'use client';

import * as React from 'react';
import Link from 'next/link';
import { Edit3, FlaskConical, Plus, RefreshCw, Search, Star, Trash2, Tv, Users } from 'lucide-react';
import { AppShell } from '@/components/layout/app-shell';
import { PageHeader } from '@/components/layout/page-header';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { apiPath, readJson } from '@/lib/client/api';

interface ProviderUserSummary {
  id: string;
  username: string;
  enabled: number;
}

interface ProviderItem {
  id: string;
  name: string;
  host: string;
  route: string;
  upstream_username: string;
  upstream_password?: string;
  users?: ProviderUserSummary[];
  is_default: number;
  cache_duration_hours: number;
  enabled: number;
  created_at: string;
}

type Envelope<T = unknown> = { success?: boolean; data?: T; error?: string };

export default function ProvidersPage() {
  const [providers, setProviders] = React.useState<ProviderItem[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [search, setSearch] = React.useState('');
  const [pageError, setPageError] = React.useState<string | null>(null);
  const [modalOpen, setModalOpen] = React.useState(false);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [formError, setFormError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [deleteId, setDeleteId] = React.useState<string | null>(null);
  const [deleting, setDeleting] = React.useState(false);

  const [name, setName] = React.useState('');
  const [host, setHost] = React.useState('http://');
  const [route, setRoute] = React.useState('');
  const [upstreamUsername, setUpstreamUsername] = React.useState('');
  const [upstreamPassword, setUpstreamPassword] = React.useState('');
  const [initialUsername, setInitialUsername] = React.useState('');
  const [initialPassword, setInitialPassword] = React.useState('');
  const [isDefault, setIsDefault] = React.useState(false);
  const [cacheHours, setCacheHours] = React.useState(1);
  const [enabled, setEnabled] = React.useState(true);

  const loadProviders = React.useCallback(async () => {
    setLoading(true);
    setPageError(null);
    try {
      const response = await fetch(apiPath('/api/providers'), { cache: 'no-store' });
      const payload = await readJson<Envelope<ProviderItem[]>>(response);
      if (!response.ok || !payload.success || !payload.data) {
        throw new Error(payload.error || `Unable to load providers (HTTP ${response.status}).`);
      }
      setProviders(payload.data);
    } catch (error) {
      setPageError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void loadProviders();
  }, [loadProviders]);

  const resetForm = () => {
    setEditingId(null);
    setName('');
    setHost('http://');
    setRoute('');
    setUpstreamUsername('');
    setUpstreamPassword('');
    setInitialUsername('');
    setInitialPassword('');
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
    setUpstreamPassword('');
    setInitialUsername('');
    setInitialPassword('');
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

    const body: Record<string, unknown> = {
      name: name.trim(),
      host: host.trim(),
      route: route.trim(),
      upstream_username: upstreamUsername.trim(),
      is_default: isDefault,
      cache_duration_hours: Number(cacheHours),
      enabled,
    };
    if (upstreamPassword) body.upstream_password = upstreamPassword;
    if (!editingId) {
      body.local_username = initialUsername.trim();
      body.local_password = initialPassword;
    }

    try {
      const response = await fetch(apiPath(editingId ? `/api/providers/${editingId}` : '/api/providers'), {
        method: editingId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const result = await readJson<Envelope>(response);
      if (!response.ok || !result.success) throw new Error(result.error || 'Failed to save provider.');
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
      const response = await fetch(apiPath(`/api/providers/${id}/default`), { method: 'POST' });
      const result = await readJson<Envelope>(response);
      if (!response.ok || !result.success) throw new Error(result.error || 'Failed to set default provider.');
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
      const response = await fetch(apiPath(`/api/providers/${deleteId}`), { method: 'DELETE' });
      const result = await readJson<Envelope>(response);
      if (!response.ok || !result.success) throw new Error(result.error || 'Failed to delete provider.');
      setDeleteId(null);
      await loadProviders();
    } catch (error) {
      setPageError(error instanceof Error ? error.message : String(error));
    } finally {
      setDeleting(false);
    }
  };

  const filtered = React.useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return providers;
    return providers.filter((provider) =>
      provider.name.toLowerCase().includes(query)
      || provider.route.toLowerCase().includes(query)
      || provider.host.toLowerCase().includes(query),
    );
  }, [providers, search]);

  const selectedForDelete = providers.find((provider) => provider.id === deleteId);

  return (
    <AppShell>
      <PageHeader
        title="Providers"
        description="Manage upstream Xtream providers, client access, routes, and metadata caching."
        actions={
          <>
            <Link href="/providers/tests" className={buttonVariants({ variant: 'outline' })}>
              <FlaskConical className="size-4" />
              Test providers
            </Link>
            <Button onClick={openCreate}>
              <Plus />
              Add provider
            </Button>
          </>
        }
      />

      {pageError && <Alert variant="destructive"><AlertDescription>{pageError}</AlertDescription></Alert>}

      <Card>
        <CardContent className="p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="relative w-full max-w-md">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search providers" className="pl-9" />
            </div>
            <div className="flex items-center gap-3 text-sm text-muted-foreground">
              <span>{providers.length} total</span>
              <span>{providers.filter((provider) => provider.enabled === 1).length} enabled</span>
              <Button variant="ghost" size="icon" onClick={() => void loadProviders()} disabled={loading} aria-label="Refresh providers">
                <RefreshCw className={loading ? 'animate-spin' : ''} />
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {loading && providers.length === 0 ? (
        <Card><CardContent className="p-8 text-center text-sm text-muted-foreground">Loading providers…</CardContent></Card>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<Tv className="size-6" />}
          title={providers.length === 0 ? 'No providers configured' : 'No providers found'}
          description={providers.length === 0 ? 'Add your first Xtream provider to begin routing traffic.' : 'Try a different search.'}
          action={providers.length === 0 ? <Button size="sm" onClick={openCreate}><Plus />Add provider</Button> : undefined}
        />
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Provider</TableHead>
                  <TableHead>Route</TableHead>
                  <TableHead>Client users</TableHead>
                  <TableHead>Cache</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((provider) => {
                  const enabledUsers = provider.users?.filter((user) => user.enabled === 1).length ?? 0;
                  const totalUsers = provider.users?.length ?? 0;
                  return (
                    <TableRow key={provider.id}>
                      <TableCell>
                        <div className="flex flex-wrap items-center gap-2 font-medium">
                          {provider.name}
                          {provider.is_default === 1 && <Badge variant="secondary"><Star className="mr-1 size-3" />Default</Badge>}
                        </div>
                        <div className="mt-1 max-w-72 truncate text-xs text-muted-foreground" title={provider.host}>{provider.host}</div>
                      </TableCell>
                      <TableCell className="font-mono text-xs">/{provider.route}</TableCell>
                      <TableCell>
                        <div className="font-medium">{enabledUsers} enabled</div>
                        <div className="text-xs text-muted-foreground">{totalUsers} total</div>
                      </TableCell>
                      <TableCell>{provider.cache_duration_hours === 0 ? 'Off' : `${provider.cache_duration_hours}h`}</TableCell>
                      <TableCell><Badge variant={provider.enabled === 1 ? 'success' : 'secondary'}>{provider.enabled === 1 ? 'Enabled' : 'Disabled'}</Badge></TableCell>
                      <TableCell>
                        <div className="flex justify-end gap-1">
                          <Link href={`/providers/${provider.id}/users`} className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
                            <Users className="size-4" />
                            Users
                          </Link>
                          {provider.is_default !== 1 && (
                            <Button variant="ghost" size="sm" onClick={() => void setDefaultProvider(provider.id)}>Set default</Button>
                          )}
                          <Button variant="ghost" size="icon" onClick={() => openEdit(provider)} aria-label={`Edit ${provider.name}`}><Edit3 /></Button>
                          <Button variant="ghost" size="icon" onClick={() => setDeleteId(provider.id)} aria-label={`Delete ${provider.name}`}><Trash2 /></Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <Dialog open={modalOpen} onOpenChange={(open) => { setModalOpen(open); if (!open) setFormError(null); }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editingId ? 'Edit provider' : 'Add provider'}</DialogTitle>
            <DialogDescription>
              {editingId ? 'Update the upstream connection and routing settings.' : 'Connect an upstream provider and create the first client login.'}
            </DialogDescription>
          </DialogHeader>

          {formError && <Alert variant="destructive"><AlertDescription>{formError}</AlertDescription></Alert>}

          <form id="provider-form" onSubmit={saveProvider} className="space-y-6">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="provider-name">Name</Label>
                <Input id="provider-name" value={name} onChange={(event) => setName(event.target.value)} required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="provider-route">Route</Label>
                <Input id="provider-route" value={route} onChange={(event) => setRoute(event.target.value)} placeholder="strong" required />
                <p className="text-xs text-muted-foreground">Public path: /{route || 'route'}/…</p>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="provider-host">Upstream URL</Label>
              <Input id="provider-host" type="url" value={host} onChange={(event) => setHost(event.target.value)} placeholder="http://provider.example.com:8080" required />
            </div>

            <div className="grid gap-4 rounded-lg border p-4 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <div className="text-sm font-medium">Upstream credentials</div>
                <div className="text-xs text-muted-foreground">The account issued by the IPTV provider. These credentials remain server-side.</div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="upstream-username">Username</Label>
                <Input id="upstream-username" value={upstreamUsername} onChange={(event) => setUpstreamUsername(event.target.value)} required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="upstream-password">Password</Label>
                <Input id="upstream-password" type="password" value={upstreamPassword} onChange={(event) => setUpstreamPassword(event.target.value)} placeholder={editingId ? 'Leave blank to keep current password' : ''} required={!editingId} />
              </div>
            </div>

            {!editingId ? (
              <div className="grid gap-4 rounded-lg border p-4 sm:grid-cols-2">
                <div className="sm:col-span-2">
                  <div className="text-sm font-medium">Initial client user</div>
                  <div className="text-xs text-muted-foreground">Create the first login your IPTV player will use. More users can be added after saving.</div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="initial-username">Username</Label>
                  <Input id="initial-username" value={initialUsername} onChange={(event) => setInitialUsername(event.target.value)} required />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="initial-password">Password</Label>
                  <Input id="initial-password" type="password" value={initialPassword} onChange={(event) => setInitialPassword(event.target.value)} required />
                </div>
              </div>
            ) : (
              <Alert>
                <AlertDescription>Client usernames and passwords are managed separately so provider edits cannot accidentally change client access.</AlertDescription>
              </Alert>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="cache-hours">Metadata cache (hours)</Label>
                <Input id="cache-hours" type="number" min={0} max={24} value={cacheHours} onChange={(event) => setCacheHours(Number(event.target.value))} />
                <p className="text-xs text-muted-foreground">Set to 0 to bypass metadata caching.</p>
              </div>
              <div className="space-y-3 rounded-lg border p-4">
                <label className="flex items-center justify-between gap-4 text-sm"><span>Enabled</span><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} className="size-4" /></label>
                <label className="flex items-center justify-between gap-4 text-sm"><span>Default provider</span><input type="checkbox" checked={isDefault} onChange={(event) => setIsDefault(event.target.checked)} className="size-4" /></label>
              </div>
            </div>
          </form>

          <DialogFooter>
            {editingId && (
              <Link href={`/providers/${editingId}/users`} className={buttonVariants({ variant: 'outline' })} onClick={() => setModalOpen(false)}>
                <Users className="size-4" />Manage users
              </Link>
            )}
            <Button variant="outline" type="button" onClick={() => setModalOpen(false)}>Cancel</Button>
            <Button type="submit" form="provider-form" disabled={saving}>{saving ? 'Saving…' : editingId ? 'Save changes' : 'Add provider'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(deleteId)} onOpenChange={(open) => { if (!open) setDeleteId(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete provider?</DialogTitle>
            <DialogDescription>
              {selectedForDelete ? `This permanently removes ${selectedForDelete.name}, all of its client users, and its routing configuration.` : 'This action cannot be undone.'}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteId(null)} disabled={deleting}>Cancel</Button>
            <Button variant="destructive" onClick={() => void deleteProvider()} disabled={deleting}>{deleting ? 'Deleting…' : 'Delete provider'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppShell>
  );
}
