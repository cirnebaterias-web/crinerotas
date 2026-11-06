import { describe, expect, it } from 'vitest';
import { visibleManagementNavigationItems } from './management-navigation-items';

describe('management navigation hierarchy', () => {
  it('places commercial actions in the management navigation for an authorized manager', () => {
    const visible = visibleManagementNavigationItems({ capabilities: [
      'route.plan_scoped', 'scrap.read_operations', 'scrap.manage_points',
    ] });
    expect(visible).toContainEqual({
      href: '/management/commercial-actions',
      label: 'Ações comerciais',
      capability: 'route.plan_scoped',
    });
  });

  it('does not couple commercial actions to scrap access', () => {
    const visible = visibleManagementNavigationItems({ capabilities: ['scrap.read_operations'] });
    expect(visible.map((item) => item.href)).not.toContain('/management/commercial-actions');
  });

  it('exposes the official scrap balance as its own management destination', () => {
    const visible = visibleManagementNavigationItems({ capabilities: ['scrap_ledger.sync'] });
    expect(visible).toContainEqual({
      href: '/management/scrap/ledger',
      label: 'Saldo de sucata',
      capability: 'scrap_ledger.sync',
    });
  });
});
