import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as sessionModel from '../src/client/session-model';
import * as runStatusModel from '../src/client/run-status-model';

const CLIENT_DIR = join(__dirname, '..', 'src', 'client');

function clientFiles(): Array<{ name: string; content: string }> {
  return readdirSync(CLIENT_DIR)
    .filter((name) => /\.(ts|tsx)$/.test(name))
    .map((name) => ({
      name,
      content: readFileSync(join(CLIENT_DIR, name), 'utf8'),
    }));
}

describe('garde-fous MVC-Statut (specs/client-models.md)', () => {
  it("'/auth/me' et '/auth/logout' ne sont appelés que par le transport (api.ts)", () => {
    const offenders = clientFiles()
      .filter(({ name }) => name !== 'api.ts')
      .filter(
        ({ content }) =>
          content.includes('/auth/me') || content.includes('/auth/logout'),
      )
      .map(({ name }) => name);
    expect(offenders).toEqual([]);
  });

  it("useHeldMascotState n'est consommé que par run-status-model.ts", () => {
    const offenders = clientFiles()
      .filter(
        ({ name }) =>
          name !== 'run-status-model.ts' && name !== 'useHeldMascotState.ts',
      )
      .filter(({ content }) => content.includes('useHeldMascotState'))
      .map(({ name }) => name);
    expect(offenders).toEqual([]);
  });

  it('SessionModel expose le contrat get/subscribe/use/refresh/logout/reset', () => {
    for (const key of [
      'getSessionStatus',
      'subscribeSessionStatus',
      'useSessionStatus',
      'refreshSessionStatus',
      'logoutSession',
      'resetSessionModelForTests',
    ] as const)
      expect(typeof sessionModel[key], key).toBe('function');
  });

  it('RunStatusModel expose le contrat derive/push/use/reset', () => {
    for (const key of [
      'deriveRawRunStatus',
      'pushRunFrame',
      'getRunMascotState',
      'subscribeRunStatus',
      'useRunMascotState',
      'getRunActivity',
      'useRunActivity',
      'resetRunStatusModelForTests',
    ] as const)
      expect(typeof runStatusModel[key], key).toBe('function');
  });
});
