import { describe, expect, it } from 'vitest';
import {
  FOLLOW_END_EPSILON_PX,
  FOLLOW_ZOOM_SLACK_PX,
  HOLD_DETACH_MS,
  HOLD_MOVE_TOLERANCE_PX,
  distanceToEnd,
  hasOverflow,
  isAtEnd,
  isWithinZoomSlack,
  nextFollowState,
  type FollowState,
} from '../src/client/auto-scroll';

describe('constantes de suivi', () => {
  it('reprend les tolérances OpenCode : 0,5 px à la fin, 4 px de zoom', () => {
    expect(FOLLOW_END_EPSILON_PX).toBe(0.5);
    expect(FOLLOW_ZOOM_SLACK_PX).toBe(4);
  });

  it('mesure la distance jusqu’en bas et le débordement', () => {
    expect(
      distanceToEnd({ scrollHeight: 1000, scrollTop: 800, clientHeight: 200 }),
    ).toBe(0);
    expect(
      distanceToEnd({ scrollHeight: 1000, scrollTop: 100, clientHeight: 200 }),
    ).toBe(700);
    expect(
      isAtEnd({ scrollHeight: 1000, scrollTop: 799.6, clientHeight: 200 }),
    ).toBe(true);
    expect(
      isAtEnd({ scrollHeight: 1000, scrollTop: 799, clientHeight: 200 }),
    ).toBe(false);
    expect(
      isWithinZoomSlack({
        scrollHeight: 1000,
        scrollTop: 796.5,
        clientHeight: 200,
      }),
    ).toBe(true);
    expect(
      isWithinZoomSlack({
        scrollHeight: 1000,
        scrollTop: 795,
        clientHeight: 200,
      }),
    ).toBe(false);
    expect(
      hasOverflow({ scrollHeight: 200, scrollTop: 0, clientHeight: 200 }),
    ).toBe(false);
    expect(
      hasOverflow({ scrollHeight: 201, scrollTop: 0, clientHeight: 200 }),
    ).toBe(true);
  });
});

describe('machine à 4 états', () => {
  const scrolled = (
    state: FollowState,
    direction: 'up' | 'down',
    distance: number,
    overflow = true,
  ) =>
    nextFollowState(state, { type: 'scroll', direction, distance, overflow });

  it('seul un scroll vers le haut, au-delà de la tolérance zoom, détache', () => {
    expect(scrolled('following', 'up', 120)).toBe('detached');
    expect(scrolled('returning', 'up', 120)).toBe('detached');
    expect(scrolled('anchored', 'up', 120)).toBe('detached');
    // 1 à 4 px d’écart : un arrondi de zoom, pas une lecture remontée.
    expect(scrolled('following', 'up', 3)).toBe('anchored');
    expect(scrolled('following', 'up', 0.5)).toBe('anchored');
  });

  it('sans débordement, remonter est impossible : on reste en bas', () => {
    expect(scrolled('detached', 'up', 0, false)).toBe('following');
  });

  it('descendre jusqu’à la fin ré-attache, s’en approcher épingle', () => {
    expect(scrolled('detached', 'down', 0)).toBe('following');
    expect(scrolled('detached', 'down', 0.4)).toBe('following');
    expect(scrolled('detached', 'down', 3)).toBe('anchored');
    // Descendre sans arriver : ni détachement, ni suivi forcé.
    expect(scrolled('detached', 'down', 120)).toBe('detached');
    expect(scrolled('following', 'down', 120)).toBe('following');
  });

  it('la reprise explicite passe par `returning`, puis `following`', () => {
    expect(nextFollowState('detached', { type: 'resume' })).toBe('returning');
    expect(nextFollowState('anchored', { type: 'resume' })).toBe('returning');
    expect(nextFollowState('following', { type: 'resume' })).toBe('following');
    expect(nextFollowState('returning', { type: 'returned' })).toBe(
      'following',
    );
    // Une tentative périmée (plus en `returning`) n’aboutit pas.
    expect(nextFollowState('detached', { type: 'returned' })).toBe('detached');
  });

  it('le contenu qui grandit suit, rattache l’épinglé, ne touche pas le détaché', () => {
    const grew = (state: FollowState, distance: number) =>
      nextFollowState(state, { type: 'content-grew', distance });
    expect(grew('following', 400)).toBe('following');
    expect(grew('anchored', 400)).toBe('following');
    expect(grew('detached', 400)).toBe('detached');
    expect(grew('returning', 400)).toBe('returning');
  });
});

describe('appui maintenu (lecture pendant le streaming)', () => {
  const held = (state: FollowState, overflow: boolean) =>
    nextFollowState(state, { type: 'hold', overflow });

  it('détache la vue suivie : le relâchement ne ramène pas en bas', () => {
    expect(held('following', true)).toBe('detached');
    // Une reprise en cours est annulée : l’utilisateur a repris la main.
    expect(held('returning', true)).toBe('detached');
    expect(held('anchored', true)).toBe('detached');
    expect(held('detached', true)).toBe('detached');
  });

  it('ne change rien quand il n’y a rien à lire (pas de débordement)', () => {
    expect(held('following', false)).toBe('following');
    expect(held('anchored', false)).toBe('anchored');
    expect(held('detached', false)).toBe('detached');
  });

  it('un appui court ne détache pas : seuil de 250 ms, 8 px de glissement', () => {
    expect(HOLD_DETACH_MS).toBe(250);
    expect(HOLD_MOVE_TOLERANCE_PX).toBe(8);
  });
});

describe('démarrage de tour', () => {
  const started = (state: FollowState, keepDetached?: boolean) =>
    nextFollowState(state, { type: 'turn-started', keepDetached });

  it('repart collé au point de génération à chaque tour', () => {
    expect(started('detached')).toBe('following');
    expect(started('anchored')).toBe('following');
    expect(started('returning')).toBe('following');
    expect(started('following')).toBe('following');
  });

  it('respecte un lecteur détaché pendant le tour précédent', () => {
    expect(started('detached', true)).toBe('detached');
    // Un état non détaché n’a rien à préserver.
    expect(started('following', true)).toBe('following');
    expect(started('anchored', true)).toBe('following');
  });
});
