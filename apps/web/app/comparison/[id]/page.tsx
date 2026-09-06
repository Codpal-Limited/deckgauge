import { notFound } from 'next/navigation';
import { auth } from '@/auth';
import { fetchComparison } from '../../actions/comparison';
import ComparisonPageContent from '../../components/comparison/ComparisonPageContent';

interface ComparisonPageProps {
  params: Promise<{ id: string }>;
}

export default async function ComparisonPage(props: ComparisonPageProps) {
  const params = await props.params;
  // A missing comparison (deleted, or not owned by this user) must render the
  // 404 page, not throw — a raw throw here surfaces as a Server Components
  // render error instead. Ownership is enforced API-side, so anything the user
  // can load, they can edit.
  const comparison = await fetchComparison(params.id).catch(() => null);
  if (!comparison) notFound();
  const session = await auth();
  return <ComparisonPageContent comparison={comparison} canEdit={Boolean(session)} />;
}
