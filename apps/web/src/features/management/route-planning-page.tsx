import { managementServiceDateSchema } from '@cirne/contracts';
import { RoutePlanningDashboard } from './route-planning-dashboard';

export async function RoutePlanningPage({
  searchParams,
}: {
  searchParams: Promise<{ serviceDate?: string | string[] }>;
}) {
  const parameters = await searchParams;
  const supplied = Array.isArray(parameters.serviceDate) ? undefined : parameters.serviceDate;
  const parsed = managementServiceDateSchema.safeParse(supplied);
  return <RoutePlanningDashboard initialServiceDate={parsed.success ? parsed.data : undefined} />;
}
