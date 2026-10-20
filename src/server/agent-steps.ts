/**
 * Libellés français des étapes de l'agent (phase 3 : carte de progression).
 * Chaque appel d'outil devient une étape visible dans le transcript.
 */
const STEP_LABELS: Record<string, string> = {
  search_web: 'Recherche web',
  read_public_page: "Lecture d'une page web",
  read_page_slice: "Lecture d'un extrait de page",
  grep_page: 'Recherche dans une page',
  list_authorized_spaces: 'Liste des espaces autorisés',
  list_space_pages: "Liste des pages de l'espace",
  read_space_page: "Lecture d'une page",
  create_space_page: "Création d'une page",
  edit_space_page: "Modification d'une page",
  review_space_page: 'Relecture de page',
  recall: 'Recherche dans la mémoire',
  recall_search: 'Recherche dans la mémoire',
  external_service_call: 'Appel à un service externe',
  request_connection_action: 'Action de connexion',
  computer_preview_file: 'Ordinateur : aperçu fichier',
  computer_files_send: 'Ordinateur : envoi de fichier',
};

/**
 * Libellé d'étape pour un nom d'outil.
 * Les outils `computer_*` affichent leur action ; repli : nom humanisé.
 */
export function stepLabelForTool(toolName: string): string {
  const direct = STEP_LABELS[toolName];
  if (direct) return direct;
  if (toolName.startsWith('computer_')) {
    const action = toolName.slice('computer_'.length).replace(/_/g, ' ').trim();
    return action ? `Ordinateur : ${action}` : 'Ordinateur';
  }
  const humanized = toolName.replace(/_/g, ' ').trim();
  return humanized
    ? humanized.charAt(0).toUpperCase() + humanized.slice(1)
    : 'Étape';
}

export interface StepProtocolEvent {
  type: 'started' | 'finished';
  stepName: string;
}

/**
 * Suivi des étapes dérivées des appels d'outils (phase 3). Le protocole
 * AG-UI refuse deux `STEP_STARTED` du même nom sans `STEP_FINISHED`
 * (appels parallèles du même outil, ou fin manquée après erreur) — sinon
 * le run entier échoue avec `AGUIError`. Le compteur n'émet qu'une fois
 * par libellé actif : `started` à 0→1, `finished` à 1→0.
 */
export class StepTracker {
  private counts = new Map<string, number>();
  private byCall = new Map<string, string>();

  start(toolCallId: string, label: string): StepProtocolEvent[] {
    this.byCall.set(toolCallId, label);
    const active = (this.counts.get(label) ?? 0) + 1;
    this.counts.set(label, active);
    return active === 1 ? [{ type: 'started', stepName: label }] : [];
  }

  end(toolCallId: string): StepProtocolEvent[] {
    const label = this.byCall.get(toolCallId);
    if (!label) return [];
    this.byCall.delete(toolCallId);
    const remaining = (this.counts.get(label) ?? 1) - 1;
    if (remaining <= 0) {
      this.counts.delete(label);
      return [{ type: 'finished', stepName: label }];
    }
    this.counts.set(label, remaining);
    return [];
  }

  /** Solde les étapes restées actives (run en erreur sans fins d'outils). */
  drain(): StepProtocolEvent[] {
    const done = [...this.counts.keys()].map((stepName) => ({
      type: 'finished' as const,
      stepName,
    }));
    this.counts.clear();
    this.byCall.clear();
    return done;
  }
}
