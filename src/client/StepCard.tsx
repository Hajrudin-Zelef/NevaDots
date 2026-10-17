import { useEffect, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import type { AgentStep } from './useAgentSteps';
import { ThinkingOrb, orbKindForStepLabel } from './ThinkingOrb';

/**
 * Carte de progression des étapes de l'agent (phase 3).
 * Dépliée pendant l'exécution, repliée une fois terminée.
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
            : `${steps.length} étape${steps.length > 1 ? 's' : ''}`}
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
          {steps.map((step) => (
            <li key={step.id} className={`step-card-step ${step.status}`}>
              <span className="step-card-step-icon" aria-hidden="true">
                {step.status === 'done' ? (
                  <Check size={13} />
                ) : (
                  <ThinkingOrb kind={orbKindForStepLabel(step.label)} />
                )}
              </span>
              <span className="step-card-step-label">{step.label}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
