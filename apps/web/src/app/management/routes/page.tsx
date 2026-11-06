import { RoutePlanningPage } from '@/features/management/route-planning-page';

export const dynamic = 'force-dynamic';

export default function Page({ searchParams }: PageProps<'/management/routes'>) {
  return <RoutePlanningPage searchParams={searchParams} />;
}
