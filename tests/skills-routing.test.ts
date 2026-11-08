import { describe, expect, it } from 'vitest';
import {
  MAX_SUGGESTIONS,
  WORKFLOW_SKILL_IDS,
  isTrivialRequest,
  normalizeForRouting,
  suggestSkills,
} from '../src/server/skills-routing.js';

describe('détecteur trivial (jamais de skill sur les banalités)', () => {
  it.each([
    'Bonjour',
    'Salut !',
    'merci beaucoup',
    'ok',
    'Oui',
    'Ça va ?',
    'Au revoir',
    'Top !',
    '',
    '   ',
  ])('trivial : %s', (text) => {
    expect(isTrivialRequest(text)).toBe(true);
    expect(suggestSkills(text)).toEqual([]);
  });

  it.each([
    'Corrige le bug de connexion qui plante au démarrage',
    'Écris les tests pour le module de facturation',
    'Réfléchis à l’architecture du cache avant de coder',
    'Implémente la spec de la page réglages',
    'Fige la spec du workflow voix',
  ])('fond : %s', (text) => {
    expect(isTrivialRequest(text)).toBe(false);
    expect(suggestSkills(text).length).toBeGreaterThan(0);
  });
});

describe('suggestSkills (les 5 maillons, FR+EN, sans accents)', () => {
  it('mappe chaque maillon (accents et casse ignorés)', () => {
    expect(
      suggestSkills('Mon serveur PLANTE au démarrage, diagnostique stp').map(
        (s) => s.id,
      ),
    ).toContain('mattpocock-skills/diagnosing-bugs');
    expect(
      suggestSkills('write tests first, red green refactor').map((s) => s.id),
    ).toContain('mattpocock-skills/tdd');
    expect(
      suggestSkills('Implémente la spec, crée la fonction demandée').map(
        (s) => s.id,
      ),
    ).toContain('mattpocock-skills/implement');
    expect(
      suggestSkills('Fige la spec du module avant de coder').map((s) => s.id),
    ).toContain('mattpocock-skills/to-spec');
    expect(
      suggestSkills('Réfléchis à cette ARCHITECTURE avec moi').map((s) => s.id),
    ).toContain('mattpocock-skills/grill-with-docs');
  });

  it('borne à MAX_SUGGESTIONS dans l’ordre de la chaîne', () => {
    const ids = suggestSkills(
      'Réfléchis au plan, fige la spec, implémente, teste et débogue tout',
    ).map((s) => s.id);
    expect(ids.length).toBeLessThanOrEqual(MAX_SUGGESTIONS);
    expect(ids).toEqual([...WORKFLOW_SKILL_IDS].slice(0, ids.length));
  });

  it('un jeu est un travail de fond : implement + tdd (pas jeudi)', () => {
    const ids = suggestSkills('Tu peux me faire un petit jeu de dames ?').map(
      (s) => s.id,
    );
    expect(ids).toContain('mattpocock-skills/implement');
    expect(ids).toContain('mattpocock-skills/tdd');
    expect(
      suggestSkills('On se voit jeudi pour en discuter').map((s) => s.id),
    ).not.toContain('mattpocock-skills/implement');
  });

  it('ne suggère que les 5 maillons (jamais d’id inventé)', () => {
    const ids = suggestSkills('debug ce test qui échoue puis refactor le code');
    for (const id of ids.map((s) => s.id))
      expect([...WORKFLOW_SKILL_IDS]).toContain(id);
  });

  it('normalizeForRouting retire accents et casse', () => {
    expect(normalizeForRouting('  RéFLÉCHIS   stp ')).toBe('reflechis stp');
  });
});
