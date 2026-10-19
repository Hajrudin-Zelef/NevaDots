import { describe, expect, it } from 'vitest';
import {
  avatarRefererAllowed,
  resolveAppOrigins,
} from '../src/server/app-origin.js';

/**
 * Micro-fix avatars : le Referer est comparé aux origines configurées
 * (APP_ORIGIN), pas à l'URL locale du serveur — sinon, derrière le proxy,
 * tout navigateur envoyait Referer: https://nevadots.neva-ci.pro/... et
 * prenait 403 (l'URL locale est http://127.0.0.1:4310).
 */
describe('avatarRefererAllowed', () => {
  const configured = ['https://nevadots.neva-ci.pro', 'http://127.0.0.1:4310'];
  const requestOrigin = 'http://127.0.0.1:4310';

  it('accepte le Referer de l’origine publique configurée (cas proxy)', () => {
    expect(
      avatarRefererAllowed(
        'https://nevadots.neva-ci.pro/dots/sam.png',
        configured,
        requestOrigin,
      ),
    ).toBe(true);
  });
  it('accepte le Referer de l’origine de la requête (accès direct local)', () => {
    expect(
      avatarRefererAllowed(
        'http://127.0.0.1:4310/dots/sam.png',
        configured,
        requestOrigin,
      ),
    ).toBe(true);
  });
  it('refuse un Referer étranger (hotlink)', () => {
    expect(
      avatarRefererAllowed(
        'https://evil.example/dots/sam.png',
        configured,
        requestOrigin,
      ),
    ).toBe(false);
  });
  it('refuse un Referer mal formé', () => {
    expect(avatarRefererAllowed(':::', configured, requestOrigin)).toBe(false);
  });
  it('sans origine configurée, seul le Referer local passe (ancien comportement)', () => {
    expect(
      avatarRefererAllowed(
        'http://127.0.0.1:4310/dots/sam.png',
        [],
        requestOrigin,
      ),
    ).toBe(true);
    expect(
      avatarRefererAllowed(
        'https://nevadots.neva-ci.pro/dots/sam.png',
        [],
        requestOrigin,
      ),
    ).toBe(false);
  });
  it('resolveAppOrigins : APP_ORIGIN prod inchangé', () => {
    expect(
      resolveAppOrigins(
        'https://nevadots.neva-ci.pro,http://127.0.0.1:4310,http://localhost:4310',
        'production',
      ),
    ).toEqual([
      'https://nevadots.neva-ci.pro',
      'http://127.0.0.1:4310',
      'http://localhost:4310',
    ]);
  });
});
