import { readManagementMapConfig } from '@cirne/config/server';
import { WeeklyRouteProposalDashboard } from './weekly-route-proposal-dashboard';

export function WeeklyRouteProposalPage() {
  return <WeeklyRouteProposalDashboard mapConfig={readManagementMapConfig(process.env)} />;
}
