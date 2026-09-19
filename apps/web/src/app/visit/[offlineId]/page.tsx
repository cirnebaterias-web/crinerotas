import { VisitStartScreen } from '@/features/visits/visit-start-screen';

export default async function VisitPage({
  params,
}: {
  params: Promise<{ offlineId: string }>;
}) {
  const { offlineId } = await params;
  return <VisitStartScreen offlineId={offlineId} />;
}
