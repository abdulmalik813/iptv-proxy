'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, Play, RefreshCw, Save, Search, Shield, Square } from 'lucide-react';
import { Sidebar } from '@/components/layout/sidebar';
import { TopBar } from '@/components/layout/top-bar';

type VpnTab = 'overview' | 'wireguard' | 'openvpn' | 'vpngate' | 'warp';
type VpnSummary = { status:'off'|'connecting'|'connected'|'error'; type:'off'|'wireguard'|'openvpn'|'warp'; profileId:string|null; profileName:string|null; connectedSince:string|null; publicIp:string|null; country:string|null; lastError:string|null; isBusy:boolean };
type WireguardProfile = { id:string; name:string; address:string|null; endpoint:string|null; enabled:number };
type OpenvpnProfile = { id:string; name:string; remotes:string[]; proto:string|null; source:'uploaded'|'vpngate'; enabled:number };
type VpnGateServer = { id:string; ip:string; hostname:string; countryLong:string; countryShort:string; ping:number; speed:number; score:number; sessions:number; uptime:number };
type WarpStatus = { installed:boolean; daemonRunning:boolean; registered:boolean; connected:boolean; mode?:string; accountType?:string; deviceId?:string; details:string };

const UI_BASE = process.env.NEXT_PUBLIC_UI_BASE_PATH || '/ui';
const apiPath = (path: string) => `${UI_BASE}${path}`;

async function json(res: Response) { try { return await res.json(); } catch { return { success:false, error:`HTTP ${res.status}` }; } }

export default function VpnPage() {
  const router = useRouter();
  const [mobileOpen,setMobileOpen]=useState(false);
  const [user,setUser]=useState<{username:string}|null>(null);
  const [tab,setTab]=useState<VpnTab>('overview');
  const [summary,setSummary]=useState<VpnSummary|null>(null);
  const [wg,setWg]=useState<WireguardProfile[]>([]);
  const [ovpn,setOvpn]=useState<OpenvpnProfile[]>([]);
  const [gate,setGate]=useState<VpnGateServer[]>([]);
  const [gateRefreshing,setGateRefreshing]=useState(false);
  const [warp,setWarp]=useState<WarpStatus|null>(null);
  const [busy,setBusy]=useState<string|null>(null);
  const [error,setError]=useState<string|null>(null);
  const [search,setSearch]=useState('');

  const loadStatus=useCallback(async()=>{ const r=await fetch(apiPath('/api/vpn/status'),{cache:'no-store'}); if(r.status===401){router.replace('/login');return;} const b=await json(r); if(r.ok&&b.success)setSummary(b.data); },[router]);
  const loadWg=useCallback(async()=>{const r=await fetch(apiPath('/api/vpn/wireguard'),{cache:'no-store'});const b=await json(r);if(r.ok&&b.success)setWg(b.data);},[]);
  const loadOvpn=useCallback(async()=>{const r=await fetch(apiPath('/api/vpn/openvpn'),{cache:'no-store'});const b=await json(r);if(r.ok&&b.success)setOvpn(b.data);},[]);
  const loadWarp=useCallback(async()=>{const r=await fetch(apiPath('/api/vpn/warp'),{cache:'no-store'});const b=await json(r);if(r.ok&&b.success)setWarp(b.data);},[]);
  const loadGate=useCallback(async(refresh=false)=>{
    if(refresh)setGateRefreshing(true);
    try {
      const r=await fetch(apiPath(`/api/vpn/vpngate?refresh=${refresh}`),{cache:'no-store'});
      const b=await json(r);
      if(r.ok&&b.success)setGate(b.data);else setError(b.error||'Failed to load VPNGate');
    } finally {
      if(refresh)setGateRefreshing(false);
    }
  },[]);

  useEffect(()=>{void (async()=>{const a=await fetch(apiPath('/api/auth/me'),{cache:'no-store'});const b=await json(a);if(a.status===401){router.replace('/login');return;}if(b.user)setUser(b.user);await loadStatus();})();const t=setInterval(()=>void loadStatus(),4000);return()=>clearInterval(t);},[loadStatus,router]);
  useEffect(()=>{if(tab==='wireguard')void loadWg();if(tab==='openvpn')void loadOvpn();if(tab==='vpngate')void loadGate(false);if(tab==='warp')void loadWarp();},[tab,loadWg,loadOvpn,loadGate,loadWarp]);

  const action=useCallback(async(label:string,fn:()=>Promise<Response>,after?:()=>Promise<void>)=>{setBusy(label);setError(null);try{const r=await fn();const b=await json(r);if(!r.ok||!b.success)throw new Error(b.error||`${label} failed`);if(after)await after();}catch(e){setError(e instanceof Error?e.message:String(e));}finally{await loadStatus().catch(()=>undefined);setBusy(null);}},[loadStatus]);

  const operationBusy=Boolean(busy)||Boolean(summary?.isBusy)||summary?.status==='connecting';
  const active=summary?.status==='connected';
  const canConnect=!operationBusy&&!active&&(summary?.status==='off'||summary?.status==='error'||!summary);
  const canDisconnect=!operationBusy&&Boolean(active);
  const currentLabel=summary?.profileName||summary?.type||'None';

  const connect=(type:'wireguard'|'openvpn',profileId:string)=>action(`Connecting ${type}`,()=>fetch(apiPath('/api/vpn/connect'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type,profileId})}));
  const disconnect=()=>action('Disconnecting VPN',()=>fetch(apiPath('/api/vpn/disconnect'),{method:'POST'}));
  const gateConnect=(s:VpnGateServer)=>action(`Connecting VPNGate ${s.countryShort}`,()=>fetch(apiPath('/api/vpn/vpngate'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'connect',serverId:s.id})}));
  const gateSave=(s:VpnGateServer)=>action('Saving VPNGate profile',()=>fetch(apiPath('/api/vpn/vpngate'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'save',serverId:s.id})}),loadOvpn);
  const warpAction=(a:'register'|'connect'|'disconnect'|'reset')=>action(`WARP ${a}`,()=>fetch(apiPath('/api/vpn/warp'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:a})}),loadWarp);

  const visibleGate=useMemo(()=>gate.filter(s=>!search||`${s.countryLong} ${s.countryShort} ${s.ip} ${s.hostname}`.toLowerCase().includes(search.toLowerCase())).slice(0,250),[gate,search]);
  const tabs:VpnTab[]=['overview','wireguard','openvpn','vpngate','warp'];

  return <div className="flex h-screen overflow-hidden bg-black font-mono text-neutral-200">
    <Sidebar user={user} onLogout={()=>router.push('/login')} mobileOpen={mobileOpen} setMobileOpen={setMobileOpen}/>
    <div className="flex min-w-0 flex-1 flex-col overflow-y-auto"><TopBar onToggleMobile={()=>setMobileOpen(true)}/><main className="max-w-7xl space-y-5 p-4 sm:p-6 lg:p-8">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-neutral-800 pb-4"><div><h1 className="flex items-center gap-2 text-base font-bold uppercase text-white"><Shield className="h-5 w-5"/>VPN Management</h1><p className="mt-1 text-xs text-neutral-500">Strict single-tunnel policy. Disconnect before switching VPNs.</p></div><div className="flex gap-2"><button onClick={()=>void loadStatus()} className="border border-neutral-700 px-3 py-2 text-xs uppercase">Refresh</button>{active&&<button disabled={!canDisconnect} onClick={()=>void disconnect()} className="flex items-center gap-1 border border-white bg-white px-3 py-2 text-xs font-bold uppercase text-black disabled:opacity-40"><Square className="h-3 w-3"/>Disconnect</button>}</div></div>
      {error&&<div className="flex gap-2 border border-neutral-700 p-3 text-xs text-white"><AlertTriangle className="h-4 w-4 shrink-0"/>{error}</div>}
      {busy&&<div className="flex items-center gap-2 border border-neutral-800 p-3 text-xs"><RefreshCw className="h-4 w-4 animate-spin"/>{busy}…</div>}
      {active&&<div className="border border-neutral-700 bg-neutral-950 p-3 text-xs"><strong className="text-white">LOCKED TO CURRENT VPN:</strong> <span className="text-neutral-300">{currentLabel}. Disconnect it before any other Connect/Register/Reset action.</span></div>}
      <div className="flex overflow-x-auto border-b border-neutral-800">{tabs.map(t=><button key={t} onClick={()=>setTab(t)} className={`px-4 py-2 text-xs font-bold uppercase ${tab===t?'border-b-2 border-white text-white':'text-neutral-500'}`}>{t==='vpngate'?'VPNGate':t==='warp'?'Cloudflare WARP':t}</button>)}</div>

      {tab==='overview'&&<div className="grid gap-4 lg:grid-cols-2"><section className="border border-neutral-800 bg-neutral-950 p-5 text-xs"><h2 className="mb-3 font-bold uppercase text-white">Current State</h2>{[['Status',summary?.status||'off'],['Type',summary?.type||'off'],['Profile / Server',currentLabel],['Public IP',summary?.publicIp||'Unknown'],['Country',summary?.country||'Unknown'],['Connected Since',summary?.connectedSince?new Date(summary.connectedSince).toLocaleString():'N/A']].map(([k,v])=><div key={k} className="flex justify-between border-b border-neutral-900 py-2"><span className="text-neutral-500">{k}</span><span className="text-white">{v}</span></div>)}{summary?.lastError&&<div className="mt-3 border border-neutral-700 p-3 text-neutral-300">{summary.lastError}</div>}</section><section className="border border-neutral-800 bg-neutral-950 p-5 text-xs text-neutral-400"><h2 className="mb-3 font-bold uppercase text-white">Rules</h2><div className="space-y-2"><p>1. Only one real tunnel may exist at a time.</p><p>2. Connect is allowed only when state is OFF or recoverable ERROR and no runtime tunnel exists.</p><p>3. A failed attempt ends in ERROR; it never remains CONNECTED.</p><p>4. WARP register/reset is blocked while any VPN is active.</p><p>5. Runtime process/interface state is authoritative and reconciles stale database state.</p></div></section></div>}

      {tab==='wireguard'&&<section className="border border-neutral-800 bg-neutral-950"><div className="border-b border-neutral-800 p-4 text-xs font-bold uppercase text-white">WireGuard Profiles</div>{wg.map(p=>{const isActive=active&&summary?.type==='wireguard'&&summary.profileId===p.id;return <div key={p.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-neutral-900 p-4 text-xs"><div><div className="font-bold text-white">{p.name}</div><div className="text-neutral-500">{p.endpoint||'Configured'}</div></div><button disabled={!canConnect||isActive||!p.enabled} onClick={()=>void connect('wireguard',p.id)} className="border border-white bg-white px-3 py-1.5 font-bold uppercase text-black disabled:cursor-not-allowed disabled:opacity-30">{isActive?'Connected':'Connect'}</button></div>})}{!wg.length&&<div className="p-6 text-xs text-neutral-500">No WireGuard profiles.</div>}</section>}

      {tab==='openvpn'&&<section className="border border-neutral-800 bg-neutral-950"><div className="border-b border-neutral-800 p-4 text-xs font-bold uppercase text-white">OpenVPN Profiles</div>{ovpn.map(p=>{const isActive=active&&summary?.type==='openvpn'&&summary.profileId===p.id;return <div key={p.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-neutral-900 p-4 text-xs"><div><div className="font-bold text-white">{p.name}</div><div className="text-neutral-500">{p.remotes?.[0]||'Configured'} · {p.source}</div></div><button disabled={!canConnect||isActive||!p.enabled} onClick={()=>void connect('openvpn',p.id)} className="border border-white bg-white px-3 py-1.5 font-bold uppercase text-black disabled:cursor-not-allowed disabled:opacity-30">{isActive?'Connected':'Connect'}</button></div>})}{!ovpn.length&&<div className="p-6 text-xs text-neutral-500">No OpenVPN profiles.</div>}</section>}

      {tab==='vpngate'&&<section className="space-y-3"><div className="flex gap-2"><div className="relative flex-1"><Search className="absolute left-3 top-2.5 h-4 w-4 text-neutral-500"/><input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search country, IP, host" className="w-full border border-neutral-800 bg-black py-2 pl-9 pr-3 text-xs text-white"/></div><button disabled={gateRefreshing} onClick={()=>void loadGate(true)} className="flex min-w-28 items-center justify-center gap-2 border border-neutral-700 px-3 text-xs uppercase disabled:cursor-wait disabled:opacity-60">{gateRefreshing?<><RefreshCw className="h-3.5 w-3.5 animate-spin"/>Refreshing…</>:<><RefreshCw className="h-3.5 w-3.5"/>Refresh</>}</button></div><div className="border border-neutral-800 bg-neutral-950">{visibleGate.map(s=>{const isActive=active&&summary?.profileId===`vpngate:${s.id}`;return <div key={s.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-neutral-900 p-3 text-xs"><div><strong className="text-white">{s.countryShort}</strong> <span className="text-neutral-400">{s.ip}</span><div className="text-[10px] text-neutral-500">{s.ping||'N/A'} ms · {(s.speed/1_000_000).toFixed(1)} Mbps</div></div><div className="flex gap-2"><button disabled={!canConnect||isActive} onClick={()=>void gateConnect(s)} className="flex items-center gap-1 border border-white bg-white px-2 py-1 font-bold uppercase text-black disabled:opacity-30"><Play className="h-3 w-3"/>{isActive?'Connected':'Connect'}</button><button disabled={operationBusy} onClick={()=>void gateSave(s)} className="flex items-center gap-1 border border-neutral-700 px-2 py-1 uppercase"><Save className="h-3 w-3"/>Save</button></div></div>})}</div></section>}

      {tab==='warp'&&<section className="grid gap-4 lg:grid-cols-2"><div className="border border-neutral-800 bg-neutral-950 p-5 text-xs">{[['Installed',warp?.installed?'YES':'NO'],['Service',warp?.daemonRunning?'RUNNING':'STOPPED'],['Registered',warp?.registered?'YES':'NO'],['Connected',warp?.connected?'YES':'NO'],['Mode',warp?.mode||'Unknown'],['Account',warp?.accountType||'Unknown']].map(([k,v])=><div key={k} className="flex justify-between border-b border-neutral-900 py-2"><span className="text-neutral-500">{k}</span><span className="text-white">{v}</span></div>)}</div><div className="border border-neutral-800 bg-neutral-950 p-5"><h2 className="mb-3 text-xs font-bold uppercase text-white">WARP Actions</h2><div className="grid grid-cols-2 gap-2 text-xs"><button disabled={operationBusy||active||!warp?.installed||Boolean(warp?.registered)} onClick={()=>void warpAction('register')} className="border border-neutral-700 p-2 uppercase disabled:cursor-not-allowed disabled:opacity-30">Register</button><button disabled={!canConnect||!warp?.installed||!warp?.registered||Boolean(warp?.connected)} onClick={()=>void warpAction('connect')} className="border border-white bg-white p-2 font-bold uppercase text-black disabled:cursor-not-allowed disabled:opacity-30">Connect</button><button disabled={operationBusy||!active||summary?.type!=='warp'} onClick={()=>void warpAction('disconnect')} className="border border-neutral-700 p-2 uppercase disabled:cursor-not-allowed disabled:opacity-30">Disconnect</button><button disabled={operationBusy||active||!warp?.installed||!warp?.registered} onClick={()=>void warpAction('reset')} className="border border-neutral-700 p-2 uppercase disabled:cursor-not-allowed disabled:opacity-30">Reset</button></div><div className="mt-3 whitespace-pre-wrap break-words border border-neutral-900 bg-black p-3 text-[10px] text-neutral-500">{warp?.details||'No WARP status loaded.'}</div></div></section>}
    </main></div>
  </div>;
}
