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
