import { expect, it } from 'vitest';
import { sameJson } from '../src/client/stable-json';

it('reconnaît un état équivalent (objet reconstruit)', () => {
  const a = { dots: [{ id: 'd', name: 'Leo' }], conversations: [] };
  const b = JSON.parse(JSON.stringify(a)) as unknown;
  expect(sameJson(a, b)).toBe(true);
});

it('détecte un vrai changement', () => {
  expect(sameJson({ a: 1 }, { a: 2 })).toBe(false);
  expect(sameJson({ a: 1 }, { a: 1, b: 2 })).toBe(false);
});

it('gère null et les types primitifs', () => {
  expect(sameJson(null, null)).toBe(true);
  expect(sameJson(undefined, null)).toBe(false);
  expect(sameJson('x', 'x')).toBe(true);
  expect(sameJson(1, '1')).toBe(false);
});
