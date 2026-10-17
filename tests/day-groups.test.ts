import { describe, expect, it } from 'vitest';
import { dayLabel, groupByDay, timeOfDay } from '../src/client/day-groups';

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
