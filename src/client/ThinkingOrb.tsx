import { ThinkingOrb as BaseOrb, type OrbSize } from 'thinking-orbs';

/** Niveaux de pensée NevaDots mappés sur les états thinking-orbs. */
export type ThinkingKind =
  | 'thinking'
  | 'analyzing'
  | 'writing'
  | 'searching'
  | 'listening'
  | 'working'
  | 'connecting'
  | 'loading';

const KIND_TO_STATE = {
  thinking: 'working',
  analyzing: 'solving',
  writing: 'composing',
  searching: 'searching',
  listening: 'listening',
  working: 'working',
  connecting: 'connecting',
  loading: 'breathing',
} as const;

const KIND_TO_LABEL_FR: Record<ThinkingKind, string> = {
  thinking: 'Réflexion en cours',
  analyzing: 'Analyse en cours',
  writing: 'Rédaction en cours',
  searching: 'Recherche en cours',
  listening: 'Écoute en cours',
  working: 'Travail en cours',
  connecting: 'Connexion en cours',
  loading: 'Chargement en cours',
};

/** Orb de pensée thinking-orbs (canvas 2D, thème auto via `data-theme`,
 * image figée si `prefers-reduced-motion`). Ne remplace jamais les mascottes
 * (art de Kouassi) : indicateur inline des chargements et du travail agent. */
export function ThinkingOrb({
  kind = 'working',
  size = 20,
  label,
}: {
  kind?: ThinkingKind;
  size?: OrbSize;
  /** Libellé FR du `aria-label` (défaut selon le kind). */
  label?: string;
}) {
  return (
    <BaseOrb
      state={KIND_TO_STATE[kind]}
      size={size}
      theme="auto"
      aria-label={label ?? KIND_TO_LABEL_FR[kind]}
    />
  );
}

/** Orb adapté au libellé FR d'une étape agent (`specs/agent-steps.md`). */
export function orbKindForStepLabel(label: string): ThinkingKind {
  if (/mémoire/i.test(label)) return 'analyzing';
  if (/recherche|appel|connexion|service/i.test(label)) return 'searching';
  if (/création|modification|écriture|ordinateur/i.test(label))
    return 'writing';
  if (/lect|relecture/i.test(label)) return 'working';
  return 'thinking';
}
