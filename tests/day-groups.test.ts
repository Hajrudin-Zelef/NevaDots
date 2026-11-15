import { describe, expect, it } from 'vitest';
import { dayLabel, groupByDay, timeOfDay } from '../src/client/day-groups';
import {
  groupSessions,
  sessionGroupLabel,
  sortSessions,
} from '../src/client/session-groups';
import type { Conversation } from '../src/shared/types';

const NOW = new Date(2026, 9, 12, 15, 0, 0).getTime();

describe('dayLabel', () => {
  it('labels today and yesterday', () => {
    expect(dayLabel(new Date(2026, 9, 12, 9, 0).getTime(), NOW)).toBe(
      "Aujourd'hui",
    );
    expect(dayLabel(new Date(2026, 9, 11, 9, 0).getTime(), NOW)).toBe('Hier');
  });
  it('labels older days by weekday then by date', () => {
    expect(dayLabel(new Date(2026, 9, 9, 9, 0).getTime(), NOW)).toBe(
      'Vendredi',
    );
    expect(dayLabel(new Date(2026, 8, 3, 9, 0).getTime(), NOW)).toContain(
      'septembre',
    );
  });
});

describe('groupByDay', () => {
  it('groups consecutive items sharing a day', () => {
    const items = [
      { t: new Date(2026, 9, 12, 10, 0).getTime() },
      { t: new Date(2026, 9, 12, 8, 0).getTime() },
      { t: new Date(2026, 9, 11, 20, 0).getTime() },
    ];
    const groups = groupByDay(items, (item) => item.t, NOW);
    expect(groups.map((group) => group.label)).toEqual(["Aujourd'hui", 'Hier']);
    expect(groups[0].items).toHaveLength(2);
    expect(groups[1].items).toHaveLength(1);
  });
});

describe('timeOfDay', () => {
  it('renders HH:MM', () => {
    expect(timeOfDay(new Date(2026, 9, 12, 9, 5).getTime())).toBe('09:05');
  });
});

// --- Lot 2 : tri / groupes des sessions (session-groups.ts) ---

function conversation(
  id: string,
  createdAt: number,
  updatedAt?: number | null,
): Conversation {
  return {
    id,
    dotId: 'dot-1',
    ownerId: 'owner',
    title: id,
    createdAt,
    isMaster: false,
    updatedAt,
  };
}

const NOW2 = new Date(2026, 9, 12, 15, 0, 0).getTime();
const HOUR = 3_600_000;

describe('sessionGroupLabel', () => {
  it('labels today, yesterday, and older', () => {
    expect(sessionGroupLabel(NOW2 - HOUR, NOW2)).toBe("Aujourd'hui");
    expect(sessionGroupLabel(NOW2 - 24 * HOUR, NOW2)).toBe('Hier');
    expect(sessionGroupLabel(NOW2 - 2 * 24 * HOUR, NOW2)).toBe(
      'Plus anciennes',
    );
    expect(sessionGroupLabel(NOW2 - 400 * 24 * HOUR, NOW2)).toBe(
      'Plus anciennes',
    );
  });
});

describe('sortSessions', () => {
  it('sorts by updatedAt ?? createdAt, descending', () => {
    const old = conversation('old', NOW2 - 30 * 24 * HOUR);
    const mid = conversation('mid', NOW2 - 2 * 24 * HOUR);
    const fresh = conversation('fresh', NOW2 - HOUR);
    expect(sortSessions([old, fresh, mid]).map((item) => item.id)).toEqual([
      'fresh',
      'mid',
      'old',
    ]);
  });
  it('resuming an old conversation brings it back on top', () => {
    // Vieille conversation (créée il y a 30 jours) reprise à l'instant :
    // son updatedAt récent la fait remonter dans « Aujourd'hui ».
    const resumed = conversation('resumed', NOW2 - 30 * 24 * HOUR, NOW2 - HOUR);
    const recent = conversation('recent', NOW2 - 2 * HOUR);
    const sorted = sortSessions([recent, resumed]);
    expect(sorted[0].id).toBe('resumed');
    expect(groupSessions(sorted, NOW2)[0].label).toBe("Aujourd'hui");
  });
});

describe('groupSessions', () => {
  it('groups a sorted list into Today / Yesterday / Older, in order', () => {
    const items = sortSessions([
      conversation('older', NOW2 - 5 * 24 * HOUR),
      conversation('yesterday', NOW2 - 26 * HOUR),
      conversation('today-2', NOW2 - 3 * HOUR),
      conversation('today-1', NOW2 - HOUR),
    ]);
    const groups = groupSessions(items, NOW2);
    expect(groups.map((group) => group.label)).toEqual([
      "Aujourd'hui",
      'Hier',
      'Plus anciennes',
    ]);
    expect(groups[0].items.map((item) => item.id)).toEqual([
      'today-1',
      'today-2',
    ]);
    expect(groups[1].items.map((item) => item.id)).toEqual(['yesterday']);
    expect(groups[2].items.map((item) => item.id)).toEqual(['older']);
  });
  it('omits empty groups', () => {
    const groups = groupSessions([conversation('today', NOW2 - HOUR)], NOW2);
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe("Aujourd'hui");
  });
});
