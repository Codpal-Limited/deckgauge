import { IntelligenceConsole } from './IntelligenceConsole';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ boardId: string }>;
  searchParams: Promise<{
    widget?: string;
    config?: string;
    filter?: string;
    period?: string;
    from?: string;
    to?: string;
  }>;
}

export default async function BoardIntelligencePage(props: PageProps) {
  const searchParams = await props.searchParams;
  const params = await props.params;
  return (
    <IntelligenceConsole
      boardId={params.boardId}
      initialWidget={searchParams.widget}
      initialConfig={searchParams.config}
      initialFilter={searchParams.filter}
    />
  );
}
