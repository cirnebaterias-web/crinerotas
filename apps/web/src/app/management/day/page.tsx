import { ManagementDayPage } from '@/features/management/management-day-page';

export const dynamic = 'force-dynamic';

export default function Page({ searchParams }: PageProps<'/management/day'>) {
  return <ManagementDayPage searchParams={searchParams} />;
}
