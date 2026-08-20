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

/**
 * What an edition route handler sees of the request.
 *
 * Deliberately a narrow structural view rather than Fastify's own types: this file
 * ships open-source and describes only the shape the seam guarantees, so neither
 * side gains a Fastify dependency it did not have.
 */
export interface EditionRequest {
  /**
   * The unparsed body, when the route's scope registered a parser that keeps it.
   * Needed by anything that must verify a signature over the exact bytes received.
   */
  rawBody?: string;
  body?: unknown;
  headers: Record<string, string | string[] | undefined>;
  /** Set by the auth plugin on protected scopes. Absent on public ones. */
  membership?: { organizationId: string; role: string } | null;
}

export interface EditionReply {
  code(status: number): EditionReply;
  send(payload: unknown): unknown;
}

export type EditionHandler = (
  request: EditionRequest,
  reply: EditionReply,
) => unknown | Promise<unknown>;

/**
 * Minimal structural view of the Fastify instance the module registers routes on.
 *
 * `post` and `addContentTypeParser` are optional so a host that offers only `get`
 * still satisfies this type — the module must feature-detect rather than assume.
 */
export interface RouteHost {
  get(path: string, handler: EditionHandler): unknown;
  post?(path: string, handler: EditionHandler): unknown;
  /**
   * Overrides body parsing for this scope. An edition that needs the raw bytes
   * registers one; the override is scoped to the host it is called on, so core
   * routes elsewhere are unaffected.
   */
  addContentTypeParser?(
    contentType: string,
    options: { parseAs: 'string' },
    parser: (request: unknown, body: string, done: (err: Error | null, result?: unknown) => void) => void,
  ): unknown;
}

/**
 * A restriction the edition module may place on a resolved membership.
 *
 * Deliberately generic: the core knows only that an edition can *reduce* an
 * effective role and attach an opaque reason code, never why. That keeps the
 * edition's own policy — whatever it is — entirely inside the private module,
 * while the seam itself stays free-product code.
 */
export interface MembershipRestriction {
  /** The effective role to use instead of the resolved one. */
  role: 'ADMIN' | 'MEMBER' | 'VIEWER';
  /**
   * Opaque reason code. The core stores it, passes it back to `restrictDenial`,
   * and never interprets it.
   */
  reason: string;
}

/** A denial the edition module may re-express with a different status and body. */
export interface DenialOverride {
  status: number;
  body: Record<string, unknown>;
}

export interface EnterpriseModule {
  verifyLicense(): Promise<LicenseStatus>;
  registerRoutes(host: RouteHost, status: LicenseStatus): Promise<void>;
  /**
   * Optional. Registers routes on an AUTHENTICATED scope, where the auth plugin has
   * already resolved `request.membership`.
   *
   * Separate from `registerRoutes` because that host is deliberately public (it
   * serves the unauthenticated edition/status endpoint), and a route that reads a
   * membership cannot live there. Absent in Community.
   */
  registerProtectedRoutes?(host: RouteHost, status: LicenseStatus): Promise<void>;

  /**
   * Optional. Messages to show this caller in the app chrome, with optional
   * actions — see EditionNotice in @deckgauge/shared.
   *
   * Returns `unknown` on purpose: the core validates and sanitises whatever comes
   * back rather than trusting the module's shape, because an unchecked `href` from
   * here would be stored XSS on every page. Absent in Community.
   */
  notices?(
    organizationId: string,
    role: 'ADMIN' | 'MEMBER' | 'VIEWER',
  ): Promise<unknown>;
  enabledFeatures(status: LicenseStatus): FeatureFlag[];
  /**
   * Optional edition hook invoked best-effort after a user authenticates and
   * their local record is upserted. Generic extension point (e.g. audit,
   * last-login, notifications). Absent in Community.
   */
  onUserAuthenticated?(userId: string): Promise<void>;

  /**
   * Optional. May reduce a resolved membership's effective role — for example to
   * make an organization read-only. Returning null leaves the membership as
   * resolved.
   *
   * The core applies the returned role and remembers `reason` for
   * `restrictDenial`. It never inspects the reason, so the rule behind the
   * restriction stays private to the module. Absent in Community, which is why
   * the free product has no such behaviour at all.
   */
  restrictMembership?(
    organizationId: string,
    role: 'ADMIN' | 'MEMBER' | 'VIEWER',
  ): Promise<MembershipRestriction | null>;

  /**
   * Optional. Given an authorization denial and the reason recorded by
   * `restrictMembership`, may re-express it — e.g. so a caller learns *why* the
   * action is unavailable rather than only that it is. Returning null keeps the
   * core's own status and body.
   */
  restrictDenial?(
    denial: { status: number; error: string },
    reason: string,
  ): DenialOverride | null;

  /**
   * Optional. Whether an organization may ingest new data. Returning false makes
   * the worker skip writes for that organization; absent means always allowed,
   * which is the Community behaviour.
   */
  allowIngest?(organizationId: string): Promise<boolean>;
}
