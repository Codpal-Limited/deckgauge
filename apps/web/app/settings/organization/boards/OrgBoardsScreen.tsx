'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { AccessEntry, OrgBoardDto } from '@deckgauge/shared';
import {
  renameOrgBoard as defaultRename,
  deleteOrgBoard as defaultDelete,
} from '../../../actions/organization';
import { grantAccess } from '../../../actions/access';
import { ShareDialog } from '../../../components/sharing/ShareDialog';
import { AccessPeopleStack } from '../../../components/sharing/AccessPeopleStack';
import { TableScroller } from '../../../components/TableScroller';

const MESSAGES: Record<string, string> = {
  NETWORK_ERROR: 'Could not reach the server. Check your connection and try again.',
  NOT_FOUND: 'That board no longer exists.',
  ALREADY_HAS_ACCESS: 'You already have access to that board.',
  LAST_OWNER: 'This is the last owner — make someone else an owner first.',
};

function messageFor(code: string): string {
  if (MESSAGES[code]) return MESSAGES[code]!;
  if (code.startsWith('HTTP_')) {
    return 'The server could not complete that request. Try again in a moment.';
  }
  return `Something went wrong (${code}).`;
}

/**
 * Spec §5.4's All-boards table. Every board this organization owns, including
 * boards the admin holds no grant on and therefore cannot see in their sidebar.
 *
 * The writes are the ordinary board routes (plan D-1) and access changes go
 * through the shared `ShareDialog` (D-4) rather than a bespoke owner picker, so
 * the ceiling and last-owner rules are enforced in exactly one implementation.
 */
export function OrgBoardsScreen({
  boards,
  currentUserId,
  onRename = defaultRename,
  onDelete = defaultDelete,
}: {
  boards: OrgBoardDto[];
  currentUserId: string | null;
  onRename?: typeof defaultRename;
  onDelete?: typeof defaultDelete;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const [confirming, setConfirming] = useState<string | null>(null);
  const [sharing, setSharing] = useState<OrgBoardDto | null>(null);

  async function run(action: () => Promise<{ ok: true } | { ok: false; error: string }>) {
    setError(null);
    const result = await action();
    if (result.ok) {
      router.refresh();
      return true;
    }
    setError(messageFor(result.error));
    return false;
  }

  function myGrant(board: OrgBoardDto): AccessEntry | undefined {
    return board.access.find((entry) => entry.userId === currentUserId);
  }

  return (
    <section className="space-y-4">
      <header>
        <h2 className="text-lg font-semibold">Boards</h2>
        <p className="text-sm text-slate-600">
          Every board in this organization. You can rename, delete, and change who has
          access — including boards you are not a member of.
        </p>
      </header>

      {error ? (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      ) : null}

      {/* Five columns, the last holding up to three buttons — far past 390px.
          Wrapped inside the section, so the header and the error alert above
          it and the empty-state note below it do not scroll with it. */}
      <TableScroller>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-slate-500">
              <th className="py-2">Board</th>
              <th className="py-2">Items</th>
              <th className="py-2">People</th>
              <th className="py-2">Created</th>
              <th className="py-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {boards.map((board) => (
              <tr key={board.id} className="border-b border-slate-100">
                <td className="py-2">
                  {editing === board.id ? (
                    <span className="flex items-center gap-2">
                      <input
                        aria-label="Board name"
                        className="rounded border border-slate-300 px-2 py-1"
                        value={draftName}
                        onChange={(e) => setDraftName(e.target.value)}
                      />
                      <button
                        type="button"
                        className="text-sm font-medium text-teal-700"
                        onClick={async () => {
                          const name = draftName.trim();
                          if (!name) return;
                          if (await run(() => onRename(board.id, name))) setEditing(null);
                        }}
                      >
                        Save
                      </button>
                      <button
                        type="button"
                        className="text-sm text-slate-500"
                        onClick={() => setEditing(null)}
                      >
                        Cancel
                      </button>
                    </span>
                  ) : (
                    <span className="font-medium">{board.name}</span>
                  )}
                </td>
                <td className="py-2">{board.projectCount}</td>
                <td className="py-2">
                  <AccessPeopleStack
                    entries={board.access}
                    nounLabel="board"
                    onOpen={() => setSharing(board)}
                  />
                  {board.access.length === 0 ? (
                    <button
                      type="button"
                      className="text-sm text-slate-500 underline"
                      onClick={() => setSharing(board)}
                    >
                      Nobody yet
                    </button>
                  ) : null}
                </td>
                <td className="py-2">{new Date(board.createdAt).toLocaleDateString()}</td>
                <td className="space-x-3 py-2">
                  <button
                    type="button"
                    aria-label={`Rename ${board.name}`}
                    className="text-sm text-slate-700"
                    onClick={() => {
                      setEditing(board.id);
                      setDraftName(board.name);
                    }}
                  >
                    Rename
                  </button>
                  {!myGrant(board) && currentUserId ? (
                    <button
                      type="button"
                      aria-label={`Make me owner of ${board.name}`}
                      className="text-sm text-slate-700"
                      onClick={() =>
                        run(async () => {
                          const result = await grantAccess('board', board.id, currentUserId, 'OWNER');
                          return result.ok ? { ok: true } : { ok: false, error: result.error };
                        })
                      }
                    >
                      Make me owner
                    </button>
                  ) : null}
                  {confirming === board.id ? (
                    <>
                      <button
                        type="button"
                        className="text-sm font-medium text-red-600"
                        onClick={async () => {
                          if (await run(() => onDelete(board.id))) setConfirming(null);
                        }}
                      >
                        Yes, delete
                      </button>
                      <button
                        type="button"
                        className="text-sm text-slate-500"
                        onClick={() => setConfirming(null)}
                      >
                        Keep it
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      aria-label={`Delete ${board.name}`}
                      className="text-sm text-red-600"
                      onClick={() => setConfirming(board.id)}
                    >
                      Delete
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroller>

      {boards.length === 0 ? (
        <p className="text-sm text-slate-600">This organization has no boards yet.</p>
      ) : null}

      {sharing ? (
        <ShareDialog
          kind="board"
          entityId={sharing.id}
          entityName={sharing.name}
          // A hardcoded role here is the pattern the sharing design §1.2 removed
          // from the board page, so it needs its justification stated: there, ANY
          // logged-in visitor got OWNER controls client-side. Here the screen is
          // already gated server-side on the organization ADMIN role, and an org
          // ADMIN *is* an implicit OWNER of every board in their organization
          // (`effectiveBoardRole`) — so this value is the truth the API would
          // return, and the API refuses anything else regardless of what the
          // dialog renders. The alternative is one `my-role` round trip per row.
          myRole="OWNER"
          currentUserId={currentUserId}
          initialEntries={sharing.access}
          onClose={() => {
            setSharing(null);
            router.refresh();
          }}
        />
      ) : null}
    </section>
  );
}
