import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'IPTV Proxy',
    template: '%s · IPTV Proxy',
  },
  description: 'Administration console for IPTV providers, cache, VPN routing, and runtime monitoring.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
