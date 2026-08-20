/**
 * The signal Phase C traded away, restored.
 *
 * Connection management moved from the row's creator (`created_by_id`) to any
 * organization ADMIN. That was the right call — the old gate was a second
 * authorization axis that could disagree with the caller's standing in the tenant
 * — but it means an in-organization host repoint is now something any admin can
 * do, and nothing recorded that they had.
 *
 * A repoint is not an ordinary edit. The instance's stored credential is sent to
 * whatever host is named, so changing the host is the shape a credential
 * exfiltration takes: point the connection at a host you control, let the next
 * sync authenticate against it. The cross-TENANT version of this is closed (every
 * update resolves the row through the caller's organization); this is the
 * in-tenant one, which is legitimate often enough that it cannot be denied.
 *
 * Deliberately a log line and not a table. There is no AuditLog model in this
 * schema, and `audit` is an unimplemented enterprise feature flag — a durable,
 * queryable trail is its own slice, with a migration and a retention story. A
 * structured warn line puts the actor, the instance and both hosts somewhere
 * greppable in the API log today, which is what the Phase C note asked for.
 */

/**
 * The one method needed, structurally typed — same approach as `BoardAccessLog`,
 * so a caller can hand over `req.log` and a test can hand over `{ warn: vi.fn() }`
 * without either importing Fastify.
 */
export interface ConnectionAuditLog {
  warn: (obj: unknown, msg?: string) => void;
}

export type ConnectionProvider = 'jira' | 'github' | 'azure-devops' | 'gitlab';

export interface HostRepointEvent {
  provider: ConnectionProvider;
  instanceId: string;
  organizationId: string;
  /** Absent when the request carried no user — recorded as null, not dropped. */
  actingUserId?: string;
  /** The stored host before the update. */
  from: string | null;
  /**
   * The submitted host. `undefined` means the update does not touch the host at
   * all — a rename or a token rotation — which is why this is not `string`: those
   * must not read as repoints, or every edit trips the signal and it gets ignored.
   */
  to?: string | null;
}

/**
 * Record that an instance's host changed. No-op when it did not.
 *
 * Takes hosts and ids only. Nothing in this signature can carry a credential,
 * which is the point of it being a helper rather than four inline `log.warn`
 * calls next to four `update` calls that DO hold the token.
 */
export function logHostRepoint(log: ConnectionAuditLog | undefined, event: HostRepointEvent): void {
  if (!log) return;
  if (event.to === undefined) return;
  if (event.to === event.from) return;

  log.warn(
    {
      event: 'connection.host_repointed',
      provider: event.provider,
      instanceId: event.instanceId,
      organizationId: event.organizationId,
      actingUserId: event.actingUserId ?? null,
      fromHost: event.from,
      toHost: event.to,
    },
    `${event.provider} connection "${event.instanceId}" was repointed to a different host`,
  );
}
