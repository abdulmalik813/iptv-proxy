'use client';

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Lock, User, KeyRound, Server, AlertTriangle, ShieldCheck } from 'lucide-react';

const UI_BASE = '/ui';

export default function LoginPage() {
  const router = useRouter();
  const [isSetup, setIsSetup] = useState(false);
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [checkingAuth, setCheckingAuth] = useState(true);

  useEffect(() => {
    async function checkExistingAuth() {
      try {
        const res = await fetch(`${UI_BASE}/api/auth/me`, { cache: 'no-store' });
        const data = await res.json();
        if (data.authenticated) {
          router.push(`${UI_BASE}/dashboard`);
          return;
        }
        if (data.needsSetup) setIsSetup(true);
      } catch {
        // Continue to login so the user can see and retry authentication.
      } finally {
        setCheckingAuth(false);
      }
    }
    void checkExistingAuth();
  }, [router]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (isSetup && password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setLoading(true);
    try {
      const endpoint = isSetup ? `${UI_BASE}/api/auth/setup` : `${UI_BASE}/api/auth/login`;
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });

      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        const body = await res.text();
        throw new Error(`Unexpected response (${res.status}): ${body.slice(0, 160)}`);
      }

      const data = await res.json();
      if (!res.ok || !data.success) {
        setError(data.error || 'Authentication failed. Please check your credentials.');
        return;
      }

      router.push(`${UI_BASE}/dashboard`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network or server error. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  if (checkingAuth) {
    return (
      <div className="min-h-screen bg-black text-neutral-400 font-mono flex items-center justify-center">
        <div className="flex items-center gap-3">
          <div className="w-3 h-3 bg-white animate-ping" />
          <span className="text-xs uppercase tracking-widest">INITIALIZING SECURE SESSION...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-black text-white font-mono flex flex-col items-center justify-center p-4 sm:p-6">
      <div className="w-full max-w-md border border-neutral-800 bg-neutral-950 p-6 sm:p-8">
        <div className="border-b border-neutral-800 pb-6 mb-6">
          <div className="flex items-center gap-3 mb-2">
            <div className="w-7 h-7 bg-white text-black font-black text-xs flex items-center justify-center tracking-tighter">IP</div>
            <div>
              <h1 className="text-sm font-bold tracking-tight text-white uppercase">IPTV PROXY CORE</h1>
              <p className="text-[11px] text-neutral-500 tracking-wide">{isSetup ? 'FIRST-RUN ADMINISTRATOR SETUP' : 'RESTRICTED ADMIN ACCESS'}</p>
            </div>
          </div>
        </div>

        {error && (
          <div id="login-error-banner" className="mb-6 p-3 bg-rose-950/40 border border-rose-800 text-rose-300 text-xs flex items-start gap-2.5">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <div className="flex-1 text-[11px] leading-relaxed break-words">{error}</div>
          </div>
        )}

        {isSetup && (
          <div className="mb-6 p-3 bg-neutral-900 border border-neutral-800 text-neutral-300 text-xs space-y-1">
            <div className="flex items-center gap-1.5 font-bold text-white text-[11px]">
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
              <span>Initial Setup Required</span>
            </div>
            <p className="text-[11px] text-neutral-400">No administrator account was detected in SQLite. Create the master credentials below.</p>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4 text-xs">
          <div>
            <label className="block text-neutral-400 text-[11px] font-semibold mb-1.5 uppercase tracking-wider">Username</label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-neutral-500"><User className="w-3.5 h-3.5" /></div>
              <input id="login-input-username" type="text" value={username} onChange={(e) => setUsername(e.target.value)} required className="w-full pl-9 pr-3 py-2.5 bg-black border border-neutral-800 text-white focus:border-white focus:outline-none placeholder-neutral-600 text-xs font-mono" placeholder="admin" autoComplete="username" />
            </div>
          </div>

          <div>
            <label className="block text-neutral-400 text-[11px] font-semibold mb-1.5 uppercase tracking-wider">Password</label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-neutral-500"><KeyRound className="w-3.5 h-3.5" /></div>
              <input id="login-input-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required className="w-full pl-9 pr-3 py-2.5 bg-black border border-neutral-800 text-white focus:border-white focus:outline-none placeholder-neutral-600 text-xs font-mono" placeholder="••••••••" autoComplete="current-password" />
            </div>
          </div>

          {isSetup && (
            <div>
              <label className="block text-neutral-400 text-[11px] font-semibold mb-1.5 uppercase tracking-wider">Confirm Password</label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-neutral-500"><Lock className="w-3.5 h-3.5" /></div>
                <input id="login-input-confirm-password" type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} required className="w-full pl-9 pr-3 py-2.5 bg-black border border-neutral-800 text-white focus:border-white focus:outline-none placeholder-neutral-600 text-xs font-mono" placeholder="••••••••" />
              </div>
            </div>
          )}

          <div className="pt-2">
            <button id="btn-login-submit" type="submit" disabled={loading} className="w-full py-2.5 px-4 bg-white text-black font-bold uppercase tracking-wider hover:bg-neutral-200 transition-colors border border-white disabled:opacity-50 cursor-pointer flex items-center justify-center gap-2">
              {loading ? <span>AUTHENTICATING...</span> : isSetup ? <span>INITIALIZE MASTER ACCOUNT</span> : <span>SIGN IN TO CONSOLE</span>}
            </button>
          </div>
        </form>

        <div className="mt-8 pt-4 border-t border-neutral-900 text-[10px] text-neutral-600 flex justify-between items-center">
          <span>IPTV PROXY v1.0.0</span><span>SQLITE / DOCKER WAL</span>
        </div>
      </div>
    </div>
  );
}
