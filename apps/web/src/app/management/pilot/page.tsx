import { PilotMetricsPage } from '@/features/management/pilot-metrics-page';

export const dynamic = 'force-dynamic';

export default function Page({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return <PilotMetricsPage searchParams={searchParams} />;
}
