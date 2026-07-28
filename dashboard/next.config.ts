import type { NextConfig } from 'next';

import { IMAGE_HOSTS } from './src/lib/image';

const nextConfig: NextConfig = {
  // Marketplace CDNs. next/image proxies and re-encodes these, which is what
  // turns a 467KB JPEG into a served WebP — on top of the _tn suffix the image
  // helper already applies.
  images: {
    remotePatterns: IMAGE_HOSTS.map((hostname) => ({
      protocol: 'https' as const,
      hostname,
    })),
    // Product thumbnails are small and numerous; these are the widths the grid
    // and table actually request, so no oversized variants get generated.
    imageSizes: [48, 64, 96, 128, 256],
    deviceSizes: [640, 828, 1080, 1200],
    minimumCacheTTL: 60 * 60 * 24 * 7,
  },
  experimental: {
    // postgres.js is a server-only dependency with no browser build; keeping it
    // external stops the bundler from trying to trace it into the client graph.
    serverActions: { bodySizeLimit: '2mb' },
  },
  serverExternalPackages: ['postgres'],
};

export default nextConfig;
