import type {Metadata} from 'next';
import './globals.css';
import { UiRouteBridge } from '@/components/ui-route-bridge';

export const metadata: Metadata = {
  title: 'IPTV Proxy - Management & Orchestration',
  description: 'Production-ready self-hosted IPTV Proxy management application with SQLite, multi-provider Xtream routing, and WireGuard/OpenVPN/VPNGate/WARP VPN orchestration.',
  openGraph: {
    title: 'IPTV Proxy - Management & Orchestration',
    description: 'Production-ready self-hosted IPTV Proxy management application with SQLite, multi-provider Xtream routing, and WireGuard/OpenVPN/VPNGate/WARP VPN orchestration.',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'IPTV Proxy - Management & Orchestration',
    description: 'Production-ready self-hosted IPTV Proxy management application with SQLite, multi-provider Xtream routing, and WireGuard/OpenVPN/VPNGate/WARP VPN orchestration.',
  },
};

export default function RootLayout({children}: {children: React.ReactNode}) {
  return (
    <html lang="en">
      <body suppressHydrationWarning>
        <UiRouteBridge />
        {children}
      </body>
    </html>
  );
}
