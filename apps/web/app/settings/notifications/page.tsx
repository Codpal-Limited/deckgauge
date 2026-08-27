import { fetchNotificationPreferences } from '../../actions/notification-preferences';
import { NotificationPreferencesForm } from './NotificationPreferencesForm';

export const dynamic = 'force-dynamic';

/**
 * The eleven per-kind controls live here; the per-BOARD level deliberately does
 * not. "This board is too noisy" is a decision made while looking at the board,
 * and burying it in a global list means nobody finds it — so it sits in the
 * board's own menu instead.
 */
export default async function NotificationSettingsPage() {
  const preferences = await fetchNotificationPreferences();

  if (preferences.length === 0) {
    return (
      <p className="text-sm text-slate-500">
        Notification preferences are unavailable right now. Reload to try again.
      </p>
    );
  }

  return <NotificationPreferencesForm initial={preferences} />;
}
