'use client';

import { useState, useTransition } from 'react';
import { useAuthFetch } from '../hooks/useAuthFetch';
import {
  grantOrgTreeAccess,
  revokeOrgTreeAccess,
  updateOrgTreeAccessRole,
  type GrantOrgTreeAccessResult,
  type OrgTreeAccessRole,
  type RevokeOrgTreeAccessResult,
  type UpdateOrgTreeAccessResult,
} from '../actions/org-trees';

interface OrgTreeAccessMember {
  user: { id: string; name: string; email: string };
  role: OrgTreeAccessRole;
}

interface UserResult {
  id: string;
  name: string;
  email: string;
}

interface ShareOrgTreeModalProps {
  orgTreeId: string;
  members: OrgTreeAccessMember[];
  onGrant?: (
    orgTreeId: string,
    userId: string,
    role: OrgTreeAccessRole,
  ) => Promise<GrantOrgTreeAccessResult>;
  onRoleChange?: (
    orgTreeId: string,
    userId: string,
    role: OrgTreeAccessRole,
  ) => Promise<UpdateOrgTreeAccessResult>;
  onRevoke?: (orgTreeId: string, userId: string) => Promise<RevokeOrgTreeAccessResult>;
  onClose: () => void;
}

export function ShareOrgTreeModal({
  orgTreeId,
  members: initialMembers,
  onGrant = grantOrgTreeAccess,
  onRoleChange = updateOrgTreeAccessRole,
  onRevoke = revokeOrgTreeAccess,
  onClose,
}: ShareOrgTreeModalProps) {
  const authFetch = useAuthFetch();
  const [members, setMembers] = useState<OrgTreeAccessMember[]>(initialMembers);
  const [search, setSearch] = useState('');
  const [searchResults, setSearchResults] = useState<UserResult[]>([]);
  const [selectedUser, setSelectedUser] = useState<UserResult | null>(null);
  const [newRole, setNewRole] = useState<OrgTreeAccessRole>('VIEWER');
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const handleSearch = async (q: string) => {
    setSearch(q);
    if (q.trim().length < 1) {
      setSearchResults([]);
      return;
    }
    const res = await authFetch(`/users/search?q=${encodeURIComponent(q)}`);
    if (res.ok) setSearchResults(await res.json());
  };

  const handleAdd = () => {
    if (!selectedUser) return;
    setError(null);
    startTransition(async () => {
      const result = await onGrant(orgTreeId, selectedUser.id, newRole);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setMembers((prev) => [
        ...prev.filter((m) => m.user.id !== selectedUser.id),
        { user: selectedUser, role: result.data.role },
      ]);
      setSelectedUser(null);
      setSearch('');
      setSearchResults([]);
    });
  };

  const handleRoleChange = (userId: string, role: OrgTreeAccessRole) => {
    setError(null);
    startTransition(async () => {
      const result = await onRoleChange(orgTreeId, userId, role);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setMembers((prev) => prev.map((m) => (m.user.id === userId ? { ...m, role } : m)));
    });
  };

  const handleRevoke = (userId: string) => {
    setError(null);
    startTransition(async () => {
      const result = await onRevoke(orgTreeId, userId);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setMembers((prev) => prev.filter((m) => m.user.id !== userId));
    });
  };

  return (
    <div
      className="fixed inset-0 bg-black/40 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl shadow-xl p-6 w-full max-w-md"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-lg font-semibold">Share org tree</h2>
          <button
            aria-label="Close"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 text-xl"
          >
            ✕
          </button>
        </div>

        <div className="flex gap-2 mb-4">
          <div className="relative flex-1">
            <input
              type="text"
              placeholder="Search users..."
              value={search}
              onChange={(e) => handleSearch(e.target.value)}
              className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            {searchResults.length > 0 && (
              <ul className="absolute left-0 right-0 top-full mt-1 bg-white border rounded-lg shadow z-10 max-h-40 overflow-y-auto">
                {searchResults.map((u) => (
                  <li
                    key={u.id}
                    className="px-3 py-2 text-sm hover:bg-gray-50 cursor-pointer"
                    onClick={() => {
                      setSelectedUser(u);
                      setSearch(u.name);
                      setSearchResults([]);
                    }}
                  >
                    {u.name} <span className="text-gray-400 text-xs">{u.email}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <select
            aria-label="Role for new member"
            value={newRole}
            onChange={(e) => setNewRole(e.target.value as OrgTreeAccessRole)}
            className="border rounded-lg px-2 py-2 text-sm"
          >
            <option value="VIEWER">Viewer</option>
            <option value="EDITOR">Editor</option>
            <option value="OWNER">Owner</option>
          </select>
          <button
            onClick={handleAdd}
            disabled={!selectedUser}
            className="px-3 py-2 bg-blue-600 text-white rounded-lg text-sm disabled:opacity-50"
          >
            Add
          </button>
        </div>

        {error && <p className="text-red-500 text-sm mb-3">{error}</p>}

        <ul className="space-y-2">
          {members.map((member) => (
            <li key={member.user.id} className="flex items-center justify-between text-sm">
              <div>
                <span className="font-medium">{member.user.name}</span>
                <span className="text-gray-400 text-xs ml-2">{member.user.email}</span>
              </div>
              <div className="flex items-center gap-2">
                <select
                  aria-label={`Role for ${member.user.name}`}
                  value={member.role}
                  onChange={(e) =>
                    handleRoleChange(member.user.id, e.target.value as OrgTreeAccessRole)
                  }
                  className="border rounded-lg px-2 py-1 text-xs uppercase"
                >
                  <option value="VIEWER">VIEWER</option>
                  <option value="EDITOR">EDITOR</option>
                  <option value="OWNER">OWNER</option>
                </select>
                <button
                  onClick={() => handleRevoke(member.user.id)}
                  className="text-gray-300 hover:text-red-400 text-xs"
                  aria-label={`Remove ${member.user.name}`}
                >
                  ✕
                </button>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
