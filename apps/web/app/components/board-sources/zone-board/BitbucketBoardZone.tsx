'use client';

/**
 * What a Bitbucket repository pulls into engineering intelligence.
 *
 * Bitbucket never writes board rows (tasks come from Jira), so unlike the other
 * zones this one has no target group or status mapping — only the three ingest
 * switches, which live on the SHARED repo sync: every board attached to the same
 * repository sees the same data.
 */
export interface BitbucketZoneValue {
  syncPrs: boolean;
  syncCommits: boolean;
  syncDeployments: boolean;
}

interface Props {
  value: BitbucketZoneValue;
  onChange: (next: BitbucketZoneValue) => void;
  projectKey: string | null;
  lastSyncedAt: string | null;
  lastDeploymentSyncAt: string | null;
}

const SWITCHES: Array<{ key: keyof BitbucketZoneValue; label: string; hint: string }> = [
  {
    key: 'syncPrs',
    label: 'Pull requests',
    hint: 'PR throughput, cycle time, reviews, Jira ticket links',
  },
  { key: 'syncCommits', label: 'Commits', hint: 'Commits per developer, heatmap' },
  {
    key: 'syncDeployments',
    label: 'Deployments',
    hint: 'DORA deploy frequency, change failure rate, lead time',
  },
];

function when(at: string | null): string {
  return at ? new Date(at).toLocaleString() : 'not yet';
}

export function BitbucketBoardZone({
  value,
  onChange,
  projectKey,
  lastSyncedAt,
  lastDeploymentSyncAt,
}: Props) {
  return (
    <div className="rounded-lg border border-slate-200 p-3">
      <div className="text-[10px] uppercase tracking-wider font-bold text-cyan-700 mb-2">
        → INTELLIGENCE FEED
      </div>
      <p className="mb-2 text-xs text-slate-500">
        Code activity for dashboards and DORA. Tasks stay in Jira — Bitbucket adds no rows to this
        board.
        {projectKey ? ` Bitbucket project: ${projectKey}.` : ''}
      </p>
      <div className="space-y-2">
        {SWITCHES.map((s) => (
          <label
            key={s.key}
            className="flex items-center gap-3 px-3 py-2 rounded-md border border-slate-200 bg-white"
          >
            <input
              role="switch"
              type="checkbox"
              aria-label={s.label}
              checked={value[s.key]}
              onChange={(e) => onChange({ ...value, [s.key]: e.target.checked })}
            />
            <span className="font-semibold text-sm text-slate-900">{s.label}</span>
            <span className="text-[11px] text-slate-500">{s.hint}</span>
            <span className="ml-auto text-xs text-slate-500">{value[s.key] ? 'ON' : 'OFF'}</span>
          </label>
        ))}
      </div>
      <p className="mt-2 text-[11px] text-slate-500">
        Last synced {when(lastSyncedAt)} · deployments {when(lastDeploymentSyncAt)}. These switches
        are shared by every board using this repository.
      </p>
    </div>
  );
}
