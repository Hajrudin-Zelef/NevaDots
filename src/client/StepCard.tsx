import { useEffect, useId, useState } from 'react';
import {
  AlertTriangle,
  ChevronRight,
  FileText,
  FolderOpen,
  Globe,
  Image as ImageIcon,
  Keyboard,
  OctagonX,
  Pencil,
  Search,
  SquareTerminal,
  Wrench,
} from 'lucide-react';
import type { AgentStep } from './useAgentSteps';
import {
  diffForStep,
  iconKindForStep,
  labelForStep,
  previewForStep,
  runningPillLabel,
  usedToolsLabel,
  type ToolIconKind,
} from './tool-display';
import { ThinkingOrb, orbKindForStepLabel } from './ThinkingOrb';
import { firstSentence } from '../shared/activity';
import { CopyButton } from './CopyButton';

/** Icône par famille d'affichage (une seule table, pas de switch). */
const ICONS: Record<ToolIconKind, typeof Pencil> = {
  edit: Pencil,
  shell: SquareTerminal,
  read: FileText,
  list: FolderOpen,
  search: Search,
  web: Globe,
  pdf: FileText,
  image: ImageIcon,
  type: Keyboard,
  file: FileText,
  other: Wrench,
};

/**
 * Appels d'outils d'un tour (rendu façon OpenCode).
 *
 * En-tête : « N outils utilisés » + chevron, sans cadre ni fond, toute la
 * ligne cliquable. Déplié pendant l'exécution, replié à la fin — un clic
 * rouvre. Déplié : une ligne par appel (icône + nom d'outil + aperçu
 * d'argument sur une ligne), et, tant que des appels tournent, une
 * pastille collante en bas (« 1 Shell »).
 *
 * Avant : carte bordée, en-tête agrégé par verbe (« Exploré 3 fichiers ·
 * Exécuté 2 commandes ») et lectures fusionnées — le détail par appel
 * était perdu.
 */
export function StepCard({
  steps,
  live,
}: {
  steps: AgentStep[];
  live: boolean;
}) {
  const [open, setOpen] = useState(live);
  const listId = useId();
  useEffect(() => {
    setOpen(live);
  }, [live]);

  const pill = runningPillLabel(steps);
  const running = steps.find((step) => step.status === 'running');

  return (
    <div className={`tool-run${live ? ' live' : ''}`}>
      <button
        type="button"
        className="tool-run-header"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={listId}
        title={open ? 'Replier les appels' : 'Déplier les appels'}
      >
        <span className="tool-run-title">{usedToolsLabel(steps.length)}</span>
        <ChevronRight
          size={14}
          className={`tool-run-chevron${open ? ' open' : ''}`}
          aria-hidden="true"
        />
      </button>
      {open && (
        <ul className="tool-run-list" id={listId}>
          {steps.map((step) => (
            <ToolRunRow key={step.id} step={step} />
          ))}
          {pill && (
            <li className="tool-run-pill" aria-live="polite">
              <ThinkingOrb
                kind={running ? orbKindForStepLabel(running.label) : 'working'}
                size={20}
              />
              <span>{pill}</span>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

function ToolRunRow({ step }: { step: AgentStep }) {
  const kind = iconKindForStep(step);
  const Icon = ICONS[kind];
  const label = labelForStep(step);
  const preview = previewForStep(step);

  if (step.status === 'error') {
    const summary = firstSentence(step.error ?? '');
    return (
      <li className="tool-run-row error" role="alert">
        <span className="tool-run-icon" aria-hidden="true">
          <OctagonX size={17} />
        </span>
        <span className="tool-run-name">{label}</span>
        <span className="tool-run-preview">{summary || preview}</span>
        {step.error && <CopyButton text={step.error} />}
      </li>
    );
  }

  if (step.status === 'stopped') {
    return (
      <li className="tool-run-row stopped">
        <span className="tool-run-icon" aria-hidden="true">
          <AlertTriangle size={17} />
        </span>
        <span className="tool-run-name">{label}</span>
        <span className="tool-run-preview">
          Interrompu{preview ? ` · ${preview}` : ''}
        </span>
      </li>
    );
  }

  const diff = diffForStep(step);
  return (
    <li className={`tool-run-row ${step.status}`}>
      <span className="tool-run-icon" aria-hidden="true">
        <Icon size={18} />
      </span>
      <span className="tool-run-name">{label}</span>
      {preview && <span className="tool-run-preview">{preview}</span>}
      {diff && <span className="tool-run-diff">{diff}</span>}
    </li>
  );
}
