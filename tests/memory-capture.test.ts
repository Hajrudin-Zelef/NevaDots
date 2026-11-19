import { describe, expect, it } from 'vitest';
import {
  captureExplicitMemory,
  normalizeMemoryText,
} from '../src/server/memory-capture.js';

describe('memory-capture (déclencheurs)', () => {
  it.each([
    ['Retiens que je m’appelle Sam.', 'je m’appelle Sam.'],
    ["Retiens que j'habite à Paris", "j'habite à Paris"],
    [
      'Souviens-toi que mon anniversaire est le 3 mai',
      'mon anniversaire est le 3 mai',
    ],
    ['Souviens toi que je préfère le thé', 'je préfère le thé'],
    ['Mémorise que mon client s’appelle ACME', 'mon client s’appelle ACME'],
    ['Memorise que je travaille le samedi', 'je travaille le samedi'],
    ['Rappelle-toi que je déteste les tableaux', 'je déteste les tableaux'],
    ['Note bien que le budget est de 500 €', 'le budget est de 500 €'],
    ['Garde en mémoire que je suis végétarien', 'je suis végétarien'],
    ['Remember that I speak French', 'I speak French'],
    ['Remember: my timezone is Europe/Paris', 'my timezone is Europe/Paris'],
    ['Sam, retiens que je suis à Lyon', 'je suis à Lyon'],
    ['Ok, retiens ça : j’aime le café', 'j’aime le café'],
  ])('%s', (input, expected) => {
    expect(captureExplicitMemory(input)).toBe(expected);
  });

  it('ignore les questions et les messages sans déclencheur', () => {
    expect(captureExplicitMemory('Tu te souviens de mon prénom ?')).toBeNull();
    expect(
      captureExplicitMemory('Qu’est-ce que tu retiens de moi ?'),
    ).toBeNull();
    expect(captureExplicitMemory('Retiens que je m’appelle Sam ?')).toBeNull();
    expect(captureExplicitMemory('Bonjour, comment vas-tu ?')).toBeNull();
    expect(captureExplicitMemory('')).toBeNull();
  });

  it('ignore les textes trop courts ou trop longs', () => {
    expect(captureExplicitMemory('Retiens que ok')).toBeNull();
    expect(captureExplicitMemory(`Retiens que ${'a'.repeat(501)}`)).toBeNull();
    expect(captureExplicitMemory(`Retiens que ${'a'.repeat(400)}`)).toContain(
      'aaaa',
    );
  });

  it('refuse les secrets', () => {
    expect(
      captureExplicitMemory('Retiens que ma clé est sk-abcdef123456'),
    ).toBeNull();
    expect(
      captureExplicitMemory('Retiens que mon mot de passe est hunter2'),
    ).toBeNull();
    expect(
      captureExplicitMemory('Retiens que mon token est Bearer abc.def.ghi'),
    ).toBeNull();
    expect(
      captureExplicitMemory('Retiens que ma carte est 4242424242424242'),
    ).toBeNull();
  });
});

describe('memory-capture (normalisation)', () => {
  it('neutralise casse, accents, ponctuation et espaces', () => {
    expect(normalizeMemoryText('  Je m’appelle   Sam ! ')).toBe(
      'je m appelle sam',
    );
    expect(normalizeMemoryText('J’habite à PARIS.')).toBe('j habite a paris');
    expect(normalizeMemoryText('')).toBe('');
  });
});
