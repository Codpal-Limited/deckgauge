import { WelcomeForm } from './WelcomeForm';

/** Reachable only in NEEDS_BOOTSTRAP; OrgGate redirects a member away. */
export default function WelcomePage() {
  return <WelcomeForm />;
}
