/**
 * A minimal WorkerEditionModule fixture for the open-core seam tests.
 *
 * Loaded by `loadEdition` through DECKGAUGE_ENTERPRISE_MODULE, which resolves by
 * explicit path — so this file stands in for the private package without the worker
 * depending on it. Mirrors apps/api/src/__fixtures__/stub-enterprise-module.ts.
 */
import type { WorkerEditionModule } from '../edition-loader.js';

/** Records what the loaded module was asked, so a test can assert it was reached. */
export const calls: { allowIngest: string[]; periodicWork: number } = {
  allowIngest: [],
  periodicWork: 0,
};

export function createEnterprise(): WorkerEditionModule {
  return {
    async allowIngest(organizationId: string) {
      calls.allowIngest.push(organizationId);
      // Refuses one specific organization so a caller cannot pass by defaulting
      // to true — the Community behaviour is "always allowed", and a stub that
      // also always allowed would be indistinguishable from no module at all.
      return organizationId !== 'org-blocked';
    },
    async runPeriodicWork() {
      calls.periodicWork += 1;
    },
  };
}
