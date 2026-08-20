/**
 * A minimal EnterpriseModule fixture for the open-core seam tests.
 *
 * Loaded by `loadEnterprise` through DECKGAUGE_ENTERPRISE_MODULE, which resolves
 * by explicit path — so this file stands in for the private package without the
 * core depending on it.
 */
import type { EnterpriseModule, LicenseStatus, RouteHost } from '../enterprise-contract.js';

const STATUS: LicenseStatus = {
  state: 'valid',
  edition: 'enterprise',
  features: [],
  token: null,
  message: 'stub',
};

export function createEnterprise(): EnterpriseModule {
  return {
    async verifyLicense() {
      return STATUS;
    },
    async registerRoutes() {},
    async registerProtectedRoutes(host: RouteHost) {
      // Exactly how the real module registers /billing/state: a bare
      // `host.get(path, handler)`, with no way to declare a policy.
      host.get('/stub-edition/protected', async (_request, reply) =>
        reply.code(200).send({ ok: true }),
      );
    },
    enabledFeatures() {
      return [];
    },
  };
}
