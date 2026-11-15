import type { ReasoningRunStats } from '../server/reasoning.js';

/**
 * Pied de réponse : agent · modèle · durée · tok/s (portage visuel
 * OpenCode, lot 3). Les métriques viennent de `/reasoning-stats` APRÈS
 * le tour — jamais de l'estimation live (`content.length / 4`, qui vit
 * dans la barre de tokens de session, pas par réponse).
 *
 * Règles :
 * - sans stats pour ce message, pas de pied du tout (on n'invente rien :
 *   ni le modèle de la sélection courante — qui a pu changer depuis — ni
 *   une durée ou un tok/s estimés) ;
 * - une métrique absente dans les stats est simplement omise (durée ou
 *   tok/s manquant → les autres s'affichent) ;
 * - durées au format OpenCode, en français : `12 s`, `1 min 5 s`.
 */

/** `12 s` / `1 min 5 s` / `1 h 2 min` (jamais `12.4 s`). */
export function formatResponseDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return '';
  if (durationMs < 1000) return `${Math.round(durationMs)} ms`;
  const totalSeconds = Math.round(durationMs / 1000);
  if (totalSeconds < 60) return `${totalSeconds} s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalSeconds < 3600)
    return seconds ? `${minutes} min ${seconds} s` : `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes ? `${hours} h ${restMinutes} min` : `${hours} h`;
}

/** `12,5 tok/s` (une décimale, virgule française) ou `null` si inconnu. */
export function formatTokensPerSecond(
  tokensPerSecond: number | null | undefined,
): string | null {
  if (tokensPerSecond == null || !Number.isFinite(tokensPerSecond)) return null;
  return `${tokensPerSecond.toFixed(1).replace('.', ',')} tok/s`;
}

/**
 * Ligne de méta complète, parties jointes par ` · ` — ou `''` quand il
 * n'y a pas de stats pour ce message (le pied n'est alors pas rendu).
 * `interrupted` est posé par le client quand le tour a été arrêté via
 * « Arrêter la réponse » (session courante uniquement).
 */
export function formatResponseMeta({
  agentName,
  stats,
  interrupted,
}: {
  agentName?: string;
  stats: ReasoningRunStats | null | undefined;
  interrupted?: boolean;
}): string {
  if (!stats?.model) return '';
  const parts: string[] = [];
  if (agentName) parts.push(agentName);
  // Modèle réellement servi s'il diffère de l'alias demandé (routeurs).
  parts.push(stats.resolvedModel || stats.model);
  const duration = formatResponseDuration(stats.durationMs);
  if (duration) parts.push(duration);
  const rate = formatTokensPerSecond(stats.tokensPerSecond);
  if (rate) parts.push(rate);
  if (interrupted) parts.push('Interrompu');
  return parts.join(' · ');
}
