import type { NextConfig } from 'next';

const uiUrl = process.env.UI_URL || 'http://localhost:3000/ui';
const uiBasePath = new URL(uiUrl).pathname;

const nextConfig: NextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  poweredByHeader: false,
  basePath: uiBasePath,
  env: {
    NEXT_PUBLIC_UI_BASE_PATH: uiBasePath,
  },
};

export default nextConfig;
