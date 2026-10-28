import { VisitDetailPage } from '@/features/management/visit-detail-page';

export default async function Page({ params }: { params: Promise<{ visitId: string }> }) {
  const { visitId } = await params;
  return <VisitDetailPage visitId={visitId} />;
}
