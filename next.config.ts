import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Mark Node.js-only packages as external so they are never bundled into
  // the browser or Edge Runtime. BullMQ and ioredis use net/tls which are
  // unavailable in those environments.
  serverExternalPackages: ['bullmq', 'ioredis', '@prisma/client', 'prisma'],

  // Experimental: enable React Server Components streaming
  experimental: {
    // Required for server actions if added in Phase 2
    serverActions: {
      bodySizeLimit: '2mb',
    },
  },
};

export default nextConfig;
