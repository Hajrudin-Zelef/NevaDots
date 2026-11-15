import { useEffect, useState } from 'react';
import { AlertTriangle, Check, ChevronDown, OctagonX } from 'lucide-react';
import type { AgentStep } from './useAgentSteps';
import { ThinkingOrb, orbKindForStepLabel } from './ThinkingOrb';
import { firstSentence } from '../shared/activity';
import { CopyButton } from './CopyButton';

/** Une ligne affichée : un regroupement, ou une étape seule. */
export interface StepGroup {
  key: string;
  steps: AgentStep[];
  /** Libellé de la ligne (verbe ou nom d'outil). */
  label: string;
  /** Détail typé (« 3 fichiers », « +12 −3 », commande tronquée…). */
  subtitle?: string;
  status: AgentStep['status'];
}

function isReadLike(step: AgentStep): boolean {
  return step.verb === 'Exploré' && step.kind !== 'command';
}

/**
 * Regroupements (lot 4, étape 3) : lectures consécutives → une ligne
 * (« Exploré · 3 fichiers ») ; edits consécutifs → une ligne PAR fichier
 * (avec +N −N) ; le reste (commandes, autres outils) → une ligne par
 * appel. Une erreur ou une interruption ne se regroupe jamais : elle
 * sort du groupe (étape 5).
 */
export function groupSteps(steps: AgentStep[]): StepGroup[] {
  const groups: StepGroup[] = [];
  for (const step of steps) {
    const last = groups[groups.length - 1];
    if (
      step.status !== 'error' &&
      step.status !== 'stopped' &&
      last &&
      last.status !== 'error' &&
      last.status !== 'stopped' &&
      isReadLike(step) &&
      last.steps.every(isReadLike)
    ) {
      last.steps.push(step);
      continue;
    }
    groups.push({
      key: step.id,
      steps: [step],
      label: step.label,
      subtitle: step.subtitle,
      status: step.status,
    });
  }
  for (const group of groups) {
    if (group.steps.length > 1) {
      const files = group.steps.length;
      group.label = 'Exploré';
      group.subtitle = `${files} fichier${files > 1 ? 's' : ''}`;
      group.key = `read-${group.steps.map((s) => s.id).join('-')}`;
    } else {
      const step = group.steps[0];
      if (step.verb === 'Modifié') {
        const diff =
          step.addedLines !== undefined
            ? `+${step.addedLines}${step.removedLines !== undefined ? ` −${step.removedLines}` : ''}`
            : '';
        group.subtitle = [step.subtitle, diff]
          .filter(Boolean)
          .join(' · ');
      }
    }
  }
  return groups;
}

/**
 * Titre de la carte : verbes dédupliqués + détail
 * (« Exploré 3 fichiers · Exécuté 2 commandes »). Repli « N outils »
 * quand les étapes n'ont pas de verbe (historique pré-lot 4).
 */
export function stepCardTitle(steps: AgentStep[]): string {
  const counts = new Map<string, { files: number; commands: number }>();
  const order: string[] = [];
  for (const step of steps) {
    const verb = step.verb ?? 'Utilisé';
    if (!counts.has(verb)) {
      counts.set(verb, { files: 0, commands: 0 });
      order.push(verb);
    }
    const entry = counts.get(verb);
    if (!entry) continue;
    if (step.kind === 'command') entry.commands += 1;
    else if (step.kind === 'file' || step.kind === 'search' || step.kind === 'web')
      entry.files += 1;
  }
  const hasVerb = steps.some((s) => s.verb !== undefined);
  if (!hasVerb) {
    return `${steps.length} outil${steps.length > 1 ? 's' : ''}`;
  }
  return order
    .map((verb) => {
      const { files, commands } = counts.get(verb) ?? {
        files: 0,
        commands: 0,
      };
      const total = steps.filter((s) => (s.verb ?? 'Utilisé') === verb).length;
      if (commands > 0 && files === 0)
        return `${verb} ${commands} commande${commands > 1 ? 's' : ''}`;
      if (files > 0 && commands === 0)
        return `${verb} ${files} fichier${files > 1 ? 's' : ''}`;
      if (files > 0 && commands > 0)
        return `${verb} ${files} fichier${files > 1 ? 's' : ''} · ${commands} commande${commands > 1 ? 's' : ''}`;
      return `${verb} ${total} outil${total > 1 ? 's' : ''}`;
    })
    .join(' · ');
}

/**
 * Carte de progression des étapes de l'agent (phase 3, généralisée lot 4).
 * Dépliée pendant l'exécution, repliée une fois terminée — c'est le seul
 * signal live, on ne la replie jamais pendant le run.
 */
export function StepCard({
  steps,
  live,
}: {
  steps: AgentStep[];
  live: boolean;
}) {
  const [open, setOpen] = useState(live);
  useEffect(() => {
    setOpen(live);
  }, [live]);

  const done = steps.filter((s) => s.status === 'done').length;
  const current = steps.find((s) => s.status === 'running');
  const groups = groupSteps(steps);

  return (
    <div
      className={`step-card${live ? ' live' : ''}`}
      aria-label={live ? 'Étapes en cours' : 'Étapes terminées'}
    >
      <button
        type="button"
        className="step-card-header"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <span className="step-card-icon">
          {live ? (
            <ThinkingOrb
              kind={current ? orbKindForStepLabel(current.label) : 'thinking'}
            />
          ) : (
            <Check size={14} aria-hidden="true" />
          )}
        </span>
        <span className="step-card-title">
          {live && current
            ? `${current.label}…`
            : stepCardTitle(steps)}
        </span>
        <span
          className="step-card-count"
          aria-label={`${done} sur ${steps.length} terminées`}
        >
          {done}/{steps.length}
        </span>
        <ChevronDown
          size={14}
          className={`step-card-chevron${open ? ' open' : ''}`}
          aria-hidden="true"
        />
      </button>
      {open && (
        <ul className="step-card-list">
          {groups.map((group) => {
            const first = group.steps[0];
            if (group.status === 'error') {
              // Étape 5 : l'erreur sort du groupe — carte rouge, titre =
              // nom de l'outil, résumé = 1re phrase de l'erreur.
              const summary = firstSentence(first.error ?? '');
              return (
                <li
                  key={group.key}
                  className="step-card-step error"
                  role="alert"
                >
                  <span className="step-card-step-icon" aria-hidden="true">
                    <OctagonX size={13} />
                  </span>
                  <span className="step-card-step-text">
                    <span className="step-card-step-label">
                      {first.label}
                    </span>
                    <span className="step-card-step-subtitle">{summary}</span>
                  </span>
                  {first.error && <CopyButton text={first.error} />}
                </li>
              );
            }
            if (group.status === 'stopped') {
              // Un appel interrompu n'est pas une erreur : état distinct.
              return (
                <li key={group.key} className="step-card-step stopped">
                  <span className="step-card-step-icon" aria-hidden="true">
                    <AlertTriangle size={13} />
                  </span>
                  <span className="step-card-step-text">
                    <span className="step-card-step-label">
                      {first.label}
                    </span>
                    <span className="step-card-step-subtitle">
                      Interrompu
                      {first.subtitle ? ` · ${first.subtitle}` : ''}
                    </span>
                  </span>
                </li>
              );
            }
            return (
              <li
                key={group.key}
                className={`step-card-step ${group.status}`}
              >
                <span className="step-card-step-icon" aria-hidden="true">
                  {group.status === 'done' ? (
                    <Check size={13} />
                  ) : (
                    <ThinkingOrb kind={orbKindForStepLabel(group.label)} />
                  )}
                </span>
                <span className="step-card-step-text">
                  <span className="step-card-step-label">{group.label}</span>
                  {group.subtitle && (
                    <span className="step-card-step-subtitle">
                      {group.subtitle}
                    </span>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
