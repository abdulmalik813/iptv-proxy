'use client';

import * as React from 'react';
import { AlertCircle, LoaderCircle, LockKeyhole } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiPath, readJson } from '@/lib/client/api';

type AuthPayload = {
  authenticated?: boolean;
  needsSetup?: boolean;
  success?: boolean;
  error?: string;
};

const brandLogoPath = `${process.env.NEXT_PUBLIC_UI_BASE_PATH || ''}/iptv-proxy-logo.png`;

export default function LoginPage() {
  const router = useRouter();
  const [isSetup, setIsSetup] = React.useState(false);
  const [username, setUsername] = React.useState('admin');
  const [password, setPassword] = React.useState('');
  const [confirmPassword, setConfirmPassword] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const [checkingAuth, setCheckingAuth] = React.useState(true);

  React.useEffect(() => {
    let cancelled = false;

    async function checkAuth() {
      try {
        const response = await fetch(apiPath('/api/auth/me'), { cache: 'no-store' });
        const payload = await readJson<AuthPayload>(response);
        if (payload.authenticated) {
          router.replace('/dashboard');
          return;
        }
        if (!cancelled) setIsSetup(Boolean(payload.needsSetup));
      } finally {
        if (!cancelled) setCheckingAuth(false);
      }
    }

    void checkAuth();
    return () => {
      cancelled = true;
    };
  }, [router]);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);

    if (isSetup && password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch(apiPath(isSetup ? '/api/auth/setup' : '/api/auth/login'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const payload = await readJson<AuthPayload>(response);
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || 'Unable to sign in.');
      }
      router.replace('/dashboard');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to sign in.');
    } finally {
      setSubmitting(false);
    }
  };

  if (checkingAuth) {
    return (
      <div className="grid min-h-screen place-items-center bg-muted/20 p-6">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin" />
          Loading
        </div>
      </div>
    );
  }

  return (
    <div className="grid min-h-screen place-items-center bg-muted/20 p-4 sm:p-6">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex justify-center">
          <img src={brandLogoPath} alt="IPTV Proxy" className="h-auto w-full max-w-[260px] object-contain" width={600} height={200} />
        </div>

        <Card>
          <CardHeader>
            <CardTitle>{isSetup ? 'Create administrator' : 'Sign in'}</CardTitle>
            <CardDescription>
              {isSetup
                ? 'Set the credentials for the first administrator account.'
                : 'Use your administrator credentials to continue.'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {error && (
              <Alert id="login-error-banner" variant="destructive" className="mb-5">
                <AlertCircle className="mb-2 size-4" />
                <AlertTitle>Authentication failed</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="login-input-username">Username</Label>
                <Input
                  id="login-input-username"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  autoComplete="username"
                  required
                  autoFocus
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="login-input-password">Password</Label>
                <Input
                  id="login-input-password"
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete={isSetup ? 'new-password' : 'current-password'}
                  required
                />
              </div>

              {isSetup && (
                <div className="space-y-2">
                  <Label htmlFor="login-input-confirm-password">Confirm password</Label>
                  <Input
                    id="login-input-confirm-password"
                    type="password"
                    value={confirmPassword}
                    onChange={(event) => setConfirmPassword(event.target.value)}
                    autoComplete="new-password"
                    required
                  />
                </div>
              )}

              <Button id="btn-login-submit" type="submit" className="w-full" disabled={submitting}>
                {submitting ? <LoaderCircle className="animate-spin" /> : <LockKeyhole />}
                {submitting ? 'Please wait' : isSetup ? 'Create administrator' : 'Sign in'}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
