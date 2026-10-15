/**
 * Screenshots computer en attente d'injection (phase 5a).
 * Le tool `computer_screenshot` stocke le base64 ici au lieu de le dumper
 * en texte dans le résultat d'outil ; le middleware `beforeModel` les
 * consomme et les injecte comme parties image multimodales.
 */
const pending = new Map<string, string[]>();

export function pushPendingScreenshot(dotId: string, base64: string): void {
  const list = pending.get(dotId) ?? [];
  list.push(base64);
  pending.set(dotId, list);
}

/** Récupère et vide les screenshots en attente pour ce Dot. */
export function takePendingScreenshots(dotId: string): string[] {
  const list = pending.get(dotId) ?? [];
  pending.delete(dotId);
  return list;
}
