import { expect, it } from 'vitest';
import { requireOwnerToken } from '../src/server/require-owner-token';

it('requireOwnerToken est vrai par défaut (défaut on, Lot 5.1)', () => {
  expect(requireOwnerToken({})).toBe(true);
  expect(requireOwnerToken({ REQUIRE_OWNER_TOKEN: 'true' })).toBe(true);
  // Toute valeur autre que 'false' exact = exigé (pas de fail-open par
  // valeur inattendue).
  expect(requireOwnerToken({ REQUIRE_OWNER_TOKEN: 'yes' })).toBe(true);
  expect(requireOwnerToken({ REQUIRE_OWNER_TOKEN: '1' })).toBe(true);
  expect(requireOwnerToken({ REQUIRE_OWNER_TOKEN: '' })).toBe(true);
});

it("seul 'false' explicite désactive l'exigence (opt-out dev local)", () => {
  expect(requireOwnerToken({ REQUIRE_OWNER_TOKEN: 'false' })).toBe(false);
  expect(requireOwnerToken({ REQUIRE_OWNER_TOKEN: 'False' })).toBe(true);
  expect(requireOwnerToken({ REQUIRE_OWNER_TOKEN: 'FALSE' })).toBe(true);
});
