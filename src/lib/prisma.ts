import { PrismaClient } from '@prisma/client';

// ─────────────────────────────────────────────────────────────────────────────
// Prisma Client Singleton
//
// In Next.js development, hot-module replacement (HMR) would otherwise create
// a new PrismaClient instance on every file reload, exhausting the connection
// pool. The global singleton pattern prevents that.
// ─────────────────────────────────────────────────────────────────────────────

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    log:
      process.env.NODE_ENV === 'development'
        ? ['query', 'warn', 'error']
        : ['warn', 'error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

