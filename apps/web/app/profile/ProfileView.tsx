import Link from 'next/link';
import type { MyProfile, MyOrgChartEntry } from '@deckgauge/shared';
import { ProfilePhotoEditor } from './ProfilePhotoEditor';

const ROLE_LABEL: Record<string, string> = { ADMIN: 'Admin', MEMBER: 'Member', VIEWER: 'Viewer' };

function Field({ label, value }: { label: string; value: string | number | null | undefined }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-0.5 text-sm text-slate-900">{value === null || value === undefined || value === '' ? '—' : value}</dd>
    </div>
  );
}

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

function OrgChartCard({ entry }: { entry: MyOrgChartEntry }) {
  return (
    <article aria-label={`Org chart: ${entry.orgTreeName}`} className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="font-medium text-slate-900">{entry.orgTreeName}</h3>
        <Link href={`/org/${entry.orgTreeId}`} className="text-sm font-medium text-teal-700 hover:underline">
          Open org chart
        </Link>
      </div>
      {entry.isDeparted && <p className="mb-3 text-sm text-amber-700">Marked as departed on this chart.</p>}
      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Job title" value={entry.businessTitle} />
        <Field label="Role" value={entry.role} />
        <Field label="Manager" value={entry.manager?.name} />
        <Field label="Direct reports" value={entry.directReports} />
        <Field label="Employee ID" value={entry.employeeDisplayId} />
        <Field label="Location" value={entry.location} />
        <Field label="Phone" value={entry.phone} />
        <Field label="Hire date" value={formatDate(entry.hireDate)} />
      </dl>
    </article>
  );
}

export function ProfileView({ profile }: { profile: MyProfile }) {
  return (
    <div className="p-4 md:mx-auto md:max-w-3xl md:p-6">
      <h1 className="mb-6 text-xl font-semibold">My profile</h1>

      <section aria-labelledby="photo-heading" className="mb-8">
        <h2 id="photo-heading" className="sr-only">
          Photo
        </h2>
        <ProfilePhotoEditor name={profile.name} email={profile.email} avatarUrl={profile.avatarUrl} />
      </section>

      <section aria-labelledby="account-heading" className="mb-8">
        <h2 id="account-heading" className="mb-3 text-base font-semibold">
          Account
        </h2>
        <dl className="grid grid-cols-1 gap-3 rounded-lg border border-slate-200 bg-white p-4 sm:grid-cols-2">
          <Field label="Name" value={profile.name} />
          <Field label="Email" value={profile.email} />
          <Field label="Organization" value={profile.organization?.name} />
          <Field label="Organization role" value={profile.organization ? ROLE_LABEL[profile.organization.role] : null} />
        </dl>
        <p className="mt-2 text-xs text-slate-500">
          Your name and email come from your sign-in account and update the next time you sign in.
        </p>
      </section>

      <section aria-labelledby="orgchart-heading">
        <h2 id="orgchart-heading" className="mb-3 text-base font-semibold">
          In the org chart
        </h2>
        {profile.orgChart.length === 0 ? (
          <p className="text-sm text-slate-500">
            You don’t appear on any org chart you can view. An org chart lists you when one of its people has your
            email address.
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            {profile.orgChart.map((e) => (
              <OrgChartCard key={e.employeeId} entry={e} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
