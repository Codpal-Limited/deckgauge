import { getAdvisorConfig } from '../../actions/advisor';
import { AdvisorSettingsClient } from './AdvisorSettingsClient';

export const dynamic = 'force-dynamic';

export default async function AdvisorSettingsPage() {
  const result = await getAdvisorConfig();

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-slate-500">
        Connect a model so the Advisor can answer questions grounded in this board&apos;s
        metrics. Pick a provider below, then test the connection before saving.
      </p>

      {result.ok ? (
        <AdvisorSettingsClient initialConfig={result.config} />
      ) : (
        <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
          Couldn&apos;t load the current Advisor configuration: {result.error}
        </div>
      )}
    </div>
  );
}
