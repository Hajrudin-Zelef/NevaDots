/** Catalogue d'un skill local (bibliothèque du host). */
export interface SkillSummary {
  /** Identifiant stable `repo/name` (désambiguïse les doublons de nom). */
  id: string;
  /** Nom affiché (frontmatter `name`). */
  name: string;
  /** Dépôt d'origine (premier segment de la bibliothèque). */
  repo: string;
  /** Description courte (bornée), extraite du frontmatter. */
  description: string;
}
