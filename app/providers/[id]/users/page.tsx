'use client';

import * as React from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft, Edit3, Plus, RefreshCw, Trash2, UserRound, Users } from 'lucide-react';
import { AppShell } from '@/components/layout/app-shell';
import { PageHeader } from '@/components/layout/page-header';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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

interface ProviderInfo {
  id: string;
  name: string;
  route: string;
  enabled: number;
}

interface ProviderUser {
  id: string;
  provider_id: string;
  username: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

type Envelope<T = unknown> = {
  success?: boolean;
  data?: T;
  error?: string;
  registryRefreshed?: boolean;
};

export default function ProviderUsersPage() {
  const params = useParams<{ id: string }>();
  const providerId = params.id;
  const [provider, setProvider] = React.useState<ProviderInfo | null>(null);
  const [users, setUsers] = React.useState<ProviderUser[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [pageError, setPageError] = React.useState<string | null>(null);
  const [message, setMessage] = React.useState<string | null>(null);

  const [editorOpen, setEditorOpen] = React.useState(false);
  const [editingUser, setEditingUser] = React.useState<ProviderUser | null>(null);
  const [username, setUsername] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [enabled, setEnabled] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [formError, setFormError] = React.useState<string | null>(null);

  const [deleteUser, setDeleteUser] = React.useState<ProviderUser | null>(null);
  const [deleting, setDeleting] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    setPageError(null);
    try {
      const [providerResponse, usersResponse] = await Promise.all([
        fetch(apiPath(`/api/providers/${providerId}`), { cache: 'no-store' }),
        fetch(apiPath(`/api/providers/${providerId}/users`), { cache: 'no-store' }),
      ]);
      const [providerPayload, usersPayload] = await Promise.all([
        readJson<Envelope<ProviderInfo>>(providerResponse),
        readJson<Envelope<ProviderUser[]>>(usersResponse),
      ]);
      if (!providerResponse.ok || !providerPayload.success || !providerPayload.data) {
        throw new Error(providerPayload.error || 'Unable to load provider.');
      }
      if (!usersResponse.ok || !usersPayload.success || !usersPayload.data) {
        throw new Error(usersPayload.error || 'Unable to load provider users.');
      }
      setProvider(providerPayload.data);
      setUsers(usersPayload.data);
    } catch (error) {
      setPageError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [providerId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const openCreate = () => {
    setEditingUser(null);
    setUsername('');
    setPassword('');
    setEnabled(true);
    setFormError(null);
    setEditorOpen(true);
  };

  const openEdit = (user: ProviderUser) => {
    setEditingUser(user);
    setUsername(user.username);
    setPassword('');
    setEnabled(user.enabled === 1);
    setFormError(null);
    setEditorOpen(true);
  };

  const saveUser = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setFormError(null);
    setMessage(null);
    try {
      const body: Record<string, unknown> = { username: username.trim(), enabled };
      if (password) body.password = password;
      const response = await fetch(
        apiPath(editingUser ? `/api/providers/${providerId}/users/${editingUser.id}` : `/api/providers/${providerId}/users`),
        {
          method: editingUser ? 'PUT' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      const payload = await readJson<Envelope<ProviderUser>>(response);
      if (!response.ok || !payload.success) throw new Error(payload.error || 'Unable to save user.');
      setEditorOpen(false);
      setMessage(
        payload.registryRefreshed === false
          ? 'User saved. The proxy core will apply it on the next registry sync.'
          : editingUser
            ? 'User updated and applied to the proxy core.'
            : 'User added and applied to the proxy core.',
      );
      await load();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const removeUser = async () => {
    if (!deleteUser) return;
    setDeleting(true);
    setPageError(null);
    setMessage(null);
    try {
      const response = await fetch(apiPath(`/api/providers/${providerId}/users/${deleteUser.id}`), { method: 'DELETE' });
      const payload = await readJson<Envelope>(response);
      if (!response.ok || !payload.success) throw new Error(payload.error || 'Unable to remove user.');
      setDeleteUser(null);
      setMessage(
        payload.registryRefreshed === false
          ? 'User removed. The proxy core will apply it on the next registry sync.'
          : 'User removed and access revoked from the proxy core.',
      );
      await load();
    } catch (error) {
      setPageError(error instanceof Error ? error.message : String(error));
    } finally {
      setDeleting(false);
    }
  };

  const enabledCount = users.filter((user) => user.enabled === 1).length;

  return (
    <AppShell>
      <PageHeader
        title={provider ? `${provider.name} users` : 'Provider users'}
        description="Create separate client logins for this provider. Password changes and removals are applied to the proxy core immediately."
        actions={
          <>
            <Link href="/providers" className={buttonVariants({ variant: 'outline' })}>
              <ArrowLeft className="size-4" />Providers
            </Link>
            <Button onClick={openCreate} disabled={!provider}>
              <Plus className="size-4" />Add user
            </Button>
          </>
        }
      />

      {pageError && <Alert variant="destructive"><AlertDescription>{pageError}</AlertDescription></Alert>}
      {message && <Alert variant="success"><AlertDescription>{message}</AlertDescription></Alert>}

      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader className="pb-2"><CardDescription>Provider</CardDescription><CardTitle className="text-lg">{provider?.name || 'Loading…'}</CardTitle></CardHeader>
          <CardContent className="text-sm text-muted-foreground">Route: /{provider?.route || '…'}</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardDescription>Client users</CardDescription><CardTitle className="text-2xl">{users.length}</CardTitle></CardHeader>
          <CardContent className="text-sm text-muted-foreground">{enabledCount} enabled</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardDescription>Provider status</CardDescription><CardTitle className="text-lg"><Badge variant={provider?.enabled === 1 ? 'success' : 'secondary'}>{provider?.enabled === 1 ? 'Enabled' : 'Disabled'}</Badge></CardTitle></CardHeader>
          <CardContent className="text-sm text-muted-foreground">Disabled providers reject all client access.</CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-4">
          <div>
            <CardTitle className="flex items-center gap-2"><Users className="size-4" />Client access</CardTitle>
            <CardDescription>Each user gets an independent username and password for the same upstream provider.</CardDescription>
          </div>
          <Button variant="ghost" size="icon" onClick={() => void load()} disabled={loading} aria-label="Refresh users">
            <RefreshCw className={loading ? 'animate-spin' : ''} />
          </Button>
        </CardHeader>
        <CardContent className="p-0">
          {loading && users.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">Loading users…</div>
          ) : users.length === 0 ? (
            <div className="p-6">
              <EmptyState
                icon={<UserRound className="size-6" />}
                title="No client users"
                description="This provider cannot be used by IPTV clients until you add a user."
                action={<Button size="sm" onClick={openCreate}><Plus className="size-4" />Add user</Button>}
              />
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Username</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Updated</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.map((user) => (
                  <TableRow key={user.id}>
                    <TableCell className="font-medium">{user.username}</TableCell>
                    <TableCell><Badge variant={user.enabled === 1 ? 'success' : 'secondary'}>{user.enabled === 1 ? 'Enabled' : 'Disabled'}</Badge></TableCell>
                    <TableCell className="text-sm text-muted-foreground">{new Date(user.updated_at).toLocaleString()}</TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="icon" onClick={() => openEdit(user)} aria-label={`Edit ${user.username}`}><Edit3 className="size-4" /></Button>
                        <Button variant="ghost" size="icon" onClick={() => setDeleteUser(user)} aria-label={`Delete ${user.username}`}><Trash2 className="size-4" /></Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={editorOpen} onOpenChange={(open) => { setEditorOpen(open); if (!open) setFormError(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingUser ? 'Edit client user' : 'Add client user'}</DialogTitle>
            <DialogDescription>
              {editingUser ? 'Change the username, password, or access status. Leave the password blank to keep it unchanged.' : 'Create a login for an IPTV client.'}
            </DialogDescription>
          </DialogHeader>
          {formError && <Alert variant="destructive"><AlertDescription>{formError}</AlertDescription></Alert>}
          <form id="provider-user-form" onSubmit={saveUser} className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="provider-user-name">Username</Label>
              <Input id="provider-user-name" value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="off" required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="provider-user-password">Password</Label>
              <Input
                id="provider-user-password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="new-password"
                placeholder={editingUser ? 'Leave blank to keep current password' : ''}
                required={!editingUser}
              />
            </div>
            <label className="flex items-center justify-between gap-4 rounded-lg border p-4 text-sm">
              <div><div className="font-medium">Enabled</div><div className="text-xs text-muted-foreground">Disabled users are rejected immediately.</div></div>
              <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} className="size-4" />
            </label>
          </form>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditorOpen(false)} disabled={saving}>Cancel</Button>
            <Button type="submit" form="provider-user-form" disabled={saving}>{saving ? 'Saving…' : editingUser ? 'Save changes' : 'Add user'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(deleteUser)} onOpenChange={(open) => { if (!open) setDeleteUser(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove client user?</DialogTitle>
            <DialogDescription>
              {deleteUser ? `${deleteUser.username} will immediately lose access to this provider. Existing metadata cache remains shared and unchanged.` : 'This action cannot be undone.'}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteUser(null)} disabled={deleting}>Cancel</Button>
            <Button variant="destructive" onClick={() => void removeUser()} disabled={deleting}>{deleting ? 'Removing…' : 'Remove user'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppShell>
  );
}
