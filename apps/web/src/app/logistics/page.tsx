import { LogisticsPickupDashboard } from '@/features/logistics/logistics-pickup-dashboard';
import { ScrapShell } from '@/features/scrap/scrap-ui';

export default function Page() {
  return <ScrapShell><LogisticsPickupDashboard mode="operator" /></ScrapShell>;
}
