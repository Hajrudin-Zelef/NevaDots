import { describe, expect, it } from 'vitest';
import { pickAutoReasoningEffort } from '../src/server/reasoning-effort';

describe('pickAutoReasoningEffort', () => {
  it('vide ou trivial → none', () => {
    expect(pickAutoReasoningEffort('')).toBe('none');
    expect(pickAutoReasoningEffort('Bonjour !')).toBe('none');
    expect(pickAutoReasoningEffort('merci')).toBe('none');
  });

  it('code ou mot-clé complexe → high', () => {
    expect(
      pickAutoReasoningEffort(
        '```js\nconsole.log(1)\n```\nÇa plante, pourquoi ?',
      ),
    ).toBe('high');
    expect(
      pickAutoReasoningEffort(
        'Refactorise ce module en architecture hexagonale',
      ),
    ).toBe('high');
    expect(pickAutoReasoningEffort('x'.repeat(1600))).toBe('high');
  });

  it('très long + code + architecture → max', () => {
    expect(
      pickAutoReasoningEffort(
        'Audit architecture : ```py\ncode\n```\n' + 'détail '.repeat(800),
      ),
    ).toBe('max');
  });

  it('question courte → low', () => {
    expect(pickAutoReasoningEffort('Quelle heure est-il ?')).toBe('low');
    expect(pickAutoReasoningEffort('Résume ce paragraphe en une phrase.')).toBe(
      'low',
    );
  });

  it('sinon → medium', () => {
    expect(
      pickAutoReasoningEffort(
        'Explique-moi en détail le fonctionnement des index en base de données, leurs compromis en écriture, et quand préférer un index composite.',
      ),
    ).toBe('medium');
  });
});
