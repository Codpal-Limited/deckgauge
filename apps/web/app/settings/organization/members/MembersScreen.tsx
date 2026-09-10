'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ORG_ROLES, type OrgMemberDto, type OrgRoleValue } from '@deckgauge/shared';
import {
  inviteMember,
  updateMemberRole,
  updateMemberStatus,
  removeMember,
} from '../../../actions/organization';
import { TableScroller } from '../../../components/TableScroller';

const MESSAGES: Record<string, string> = {
  MEMBER_ALREADY_INVITED: 'That email has already been invited.',
  LAST_ADMIN: 'An organization must keep at least one active administrator.',
  PENDING_MEMBER: 'This invite has not been accepted yet, so its status cannot be changed.',
  CONCURRENT_UPDATE: 'Someone else changed this member at the same time. Try again.',
  NOT_FOUND: 'That member no longer exists.',
  NETWORK_ERROR: 'Could not reach the server. Check your connection and try again.',
  CLIPBOARD_ERROR:
    'Could not copy the link automatically. Select it and copy it manually instead.',
};

function messageFor(code: string): string {
  if (MESSAGES[code]) return MESSAGES[code];
  // `HTTP_<status>` is what the action layer produces when the API answers with
  // no JSON error body — an outage or a proxy error page, not a domain refusal.
  if (code.startsWith('HTTP_')) {
    return 'The server could not complete that request. Try again in a moment.';
  }
  return `Something went wrong (${code}).`;
}

export function MembersScreen({
  members,
  inviteBaseUrl,
  orgSlug,
}: {
  members: OrgMemberDto[];
  inviteBaseUrl: string;
  orgSlug: string;
}) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<OrgRoleValue>('MEMBER');
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const router = useRouter();

  async function run(action: () => Promise<{ ok: true } | { ok: false; error: string }>) {
    setError(null);
    setCopied(null);
    const result = await action();
    if (result.ok) {
      router.refresh();
      return;
    }
    setError(messageFor(result.error));
  }

  const inviteLink = `${inviteBaseUrl}/invite?org=${encodeURIComponent(orgSlug)}`;

  return (
    <section className="space-y-6">
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={async (e) => {
          e.preventDefault();
          const address = email.trim();
          if (!address) return;
          const result = await inviteMember(address, role);
          if (result.ok) {
            setError(null);
            setCopied(null);
            setEmail('');
            router.refresh();
            return;
          }
          // Keep what the admin typed: clearing on failure means retyping the
          // address to correct a typo, or after a duplicate-invite refusal.
          setError(messageFor(result.error));
        }}
      >
        <div>
          <label htmlFor="invite-email" className="block text-sm font-medium">Email</label>
          <input
            id="invite-email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="person@company.com"
            className="rounded border border-slate-300 px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label htmlFor="invite-role" className="block text-sm font-medium">Role</label>
          <select
            id="invite-role"
            value={role}
            onChange={(e) => setRole(e.target.value as OrgRoleValue)}
            className="rounded border border-slate-300 px-3 py-2 text-sm"
          >
            {ORG_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
        <button type="submit" className="rounded bg-teal-600 px-4 py-2 text-sm text-white">
          Send invite
        </button>
      </form>

      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}

      {/* The four columns carry an email, a role `select`, a status and up to
          three action buttons, which do not fit 390px. The scroller sits
          inside the section so the invite form and the error alert above it
          stay put. */}
      <TableScroller>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-slate-500">
              <th className="py-2">Member</th><th>Role</th><th>Status</th><th />
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.id} className="border-b border-slate-100">
                <td className="py-2">
                  <div>{m.email}</div>
                  {m.name && <div className="text-xs text-slate-500">{m.name}</div>}
                </td>
                <td>
                  <select
                    id={`role-${m.id}`}
                    aria-label={`Role for ${m.email}`}
                    value={m.role}
                    onChange={(e) => run(() => updateMemberRole(m.id, e.target.value as OrgRoleValue))}
                    className="rounded border border-slate-300 px-2 py-1"
                  >
                    {ORG_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>
                </td>
                <td>{m.status}</td>
                <td className="space-x-2 text-right">
                  {m.status === 'PENDING' && (
                    <>
                      <button
                        type="button"
                        onClick={async () => {
                          setError(null);
                          // Not guaranteed to exist: the Clipboard API is absent on
                          // insecure origins and rejects when the document lacks
                          // focus or permission. A silent failure here would have
                          // the admin paste nothing at all.
                          try {
                            await navigator.clipboard.writeText(inviteLink);
                            setCopied(m.id);
                          } catch {
                            setCopied(null);
                            setError(messageFor('CLIPBOARD_ERROR'));
                          }
                        }}
                        className="text-teal-700 underline"
                      >
                        Copy invite link
                      </button>
                      {copied === m.id && <span className="text-teal-700">Copied</span>}
                    </>
                  )}
                  {/* No suspend/reactivate for PENDING: activation is first-login
                      binding's job, and updateStatus refuses it. */}
                  {m.status === 'ACTIVE' && (
                    <button
                      type="button"
                      onClick={() => run(() => updateMemberStatus(m.id, 'SUSPENDED'))}
                      className="text-slate-600 underline"
                    >
                      Suspend
                    </button>
                  )}
                  {m.status === 'SUSPENDED' && (
                    <button
                      type="button"
                      onClick={() => run(() => updateMemberStatus(m.id, 'ACTIVE'))}
                      className="text-slate-600 underline"
                    >
                      Reactivate
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => run(() => removeMember(m.id))}
                    className="text-red-600 underline"
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroller>
    </section>
  );
}
