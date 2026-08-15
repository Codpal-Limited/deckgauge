/**
 * PUBLIC contract for the open-core seam. This file ships open-source on purpose:
 * it describes the interface between the free platform and the (private)
 * @deckgauge/enterprise module — NOT the paid code itself.
 *
 * The enterprise module implements `EnterpriseModule`; the API loads it at
 * runtime via enterprise-loader.ts. See planning/OPEN-CORE-ARCHITECTURE.md.
 */

export type FeatureFlag = 'sso' | 'rbac_advanced' | 'works_council' | 'retention' | 'audit';

export type LicenseState = 'valid' | 'grace' | 'expired' | 'invalid' | 'absent';

export interface LicenseStatus {
  state: LicenseState;
  edition: 'community' | 'enterprise';
  features: FeatureFlag[];
  token: {
    customer: string;
    tier: string;
    issuedAt: string;
    expiresAt: string;
  } | null;
  message: string;
}

/** Minimal structural view of the Fastify instance the module registers routes on. */
export interface RouteHost {
  get(path: string, handler: () => unknown): unknown;
}

export interface EnterpriseModule {
  verifyLicense(): Promise<LicenseStatus>;
  registerRoutes(host: RouteHost, status: LicenseStatus): Promise<void>;
  enabledFeatures(status: LicenseStatus): FeatureFlag[];
  /**
   * Optional edition hook invoked best-effort after a user authenticates and
   * their local record is upserted. Generic extension point (e.g. audit,
   * last-login, notifications). Absent in Community.
   */
  onUserAuthenticated?(userId: string): Promise<void>;
}
