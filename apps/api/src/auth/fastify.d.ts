import type { User } from '@deckgauge/db';

declare module 'fastify' {
  interface FastifyRequest {
    user: User;
    isAdmin: boolean;
    canViewAnalytics: boolean;
  }
}
