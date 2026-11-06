import { fetchMyProfile } from '../actions/profile';
import { ProfileView } from './ProfileView';

export const dynamic = 'force-dynamic';

export default async function ProfilePage() {
  const profile = await fetchMyProfile();
  if (!profile) {
    return (
      <div className="p-4 md:mx-auto md:max-w-3xl md:p-6">
        <h1 className="mb-4 text-xl font-semibold">My profile</h1>
        <p className="text-sm text-slate-500">Your profile is unavailable right now. Reload to try again.</p>
      </div>
    );
  }
  return <ProfileView profile={profile} />;
}
