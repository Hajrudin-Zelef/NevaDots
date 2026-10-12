/** Day labels + grouping for the Muse-style activity timeline. */

export function dayLabel(ts: number, now = Date.now()): string {
  const day = new Date(ts);
  day.setHours(0, 0, 0, 0);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((today.getTime() - day.getTime()) / 86_400_000);
  if (diff <= 0) return "Aujourd'hui";
  if (diff === 1) return 'Hier';
  if (diff < 7) {
    const weekday = day.toLocaleDateString('fr-FR', { weekday: 'long' });
    return weekday.charAt(0).toUpperCase() + weekday.slice(1);
  }
  return day.toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'long',
    ...(day.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }),
  });
}

/** Groups items into consecutive day buckets, preserving the incoming order. */
export function groupByDay<T>(
  items: T[],
  time: (item: T) => number,
  now = Date.now(),
): { label: string; items: T[] }[] {
  const groups: { label: string; items: T[] }[] = [];
  for (const item of items) {
    const label = dayLabel(time(item), now);
    const last = groups.at(-1);
    if (last && last.label === label) last.items.push(item);
    else groups.push({ label, items: [item] });
  }
  return groups;
}

export function timeOfDay(ts: number): string {
  return new Date(ts).toLocaleTimeString('fr-FR', {
    hour: '2-digit',
    minute: '2-digit',
  });
}
