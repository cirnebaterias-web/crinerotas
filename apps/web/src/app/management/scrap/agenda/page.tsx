import { ScrapAgendaPage } from '@/features/management/scrap-agenda-page';

export const dynamic = 'force-dynamic';

export default function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return <ScrapAgendaPage searchParams={searchParams} />;
}
