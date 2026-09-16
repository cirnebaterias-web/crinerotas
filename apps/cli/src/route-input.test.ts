import { expect, it } from 'vitest';
import { selectRouteTokens } from './route-input';

it('accepts exactly one protected origin for both route tokens', () => {
  expect(selectRouteTokens(' manager ', ' seller ', '')).toEqual({
    managerAccessToken: 'manager',
    sellerAccessToken: 'seller',
  });
  expect(selectRouteTokens(undefined, undefined, JSON.stringify({
    managerAccessToken: 'manager',
    sellerAccessToken: 'seller',
  }))).toEqual({ managerAccessToken: 'manager', sellerAccessToken: 'seller' });
  expect(() => selectRouteTokens('manager', 'seller', JSON.stringify({
    managerAccessToken: 'manager', sellerAccessToken: 'seller',
  }))).toThrow('apenas uma origem');
  expect(() => selectRouteTokens('manager', undefined, '')).toThrow('CIRNE_MANAGER_ACCESS_TOKEN');
});
