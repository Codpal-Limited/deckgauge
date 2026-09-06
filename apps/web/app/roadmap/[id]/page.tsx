import { notFound } from 'next/navigation';
import { fetchRoadmap } from '../../actions/roadmap';
import RoadmapPageContent from '../../components/roadmap-entity/RoadmapPageContent';

interface RoadmapPageProps {
  params: Promise<{ id: string }>;
}

export default async function RoadmapPage(props: RoadmapPageProps) {
  const params = await props.params;
  // A missing roadmap (e.g. just deleted, or no access) must render the 404 page,
  // not throw — a raw throw here surfaces as a Server Components render error.
  const roadmap = await fetchRoadmap(params.id).catch(() => null);
  if (!roadmap) notFound();
  return <RoadmapPageContent roadmap={roadmap} />;
}
