import {
  BookOpen,
  Clock3,
  FolderOpen,
  Globe,
  Monitor,
  Plus,
} from 'lucide-react';
import type { Dot, Memory } from '../shared/types';

/**
 * Shared "+" menu for both the welcome composer and an open conversation.
 * Purely presentational: the caller owns the popover container and closing.
 */
export function ComposerMenu({
  dots,
  activeDotId,
  memories,
  onSource,
  onChooseDot,
  onInsertMemory,
  onSchedule,
  onComputer,
  onCreateDot,
  onAddFiles,
  onAddFolder,
  onClose,
  contextBudget,
  onContextBudget,
}: {
  dots: Dot[];
  activeDotId?: string;
  memories: Memory[];
  onSource: () => void;
  onChooseDot: (dot: Dot) => void;
  onInsertMemory: (text: string) => void;
  onSchedule?: () => void;
  onComputer?: () => void;
  onCreateDot?: () => void;
  onAddFiles?: () => void;
  onAddFolder?: () => void;
  onClose: () => void;
  /** Phase 6 : budget de contexte du Dot actif (null = Max/agentique). */
  contextBudget?: number | null;
  onContextBudget?: (budget: number | null) => void;
}) {
  const run = (action: () => void) => () => {
    onClose();
    action();
  };
  return (
    <div className="composer-menu" role="menu">
      <button type="button" onClick={run(onSource)}>
        <Globe size={15} /> Ajouter une page web
      </button>
      {onAddFiles && (
        <button type="button" onClick={run(onAddFiles)}>
          <FolderOpen size={15} /> Ajouter des fichiers
        </button>
      )}
      {onAddFolder && (
        <button type="button" onClick={run(onAddFolder)}>
          <FolderOpen size={15} /> Ajouter un dossier
        </button>
      )}
      {onSchedule && (
        <button type="button" onClick={run(onSchedule)}>
          <Clock3 size={15} /> Planifier une tâche
        </button>
      )}
      {onComputer && (
        <button type="button" onClick={run(onComputer)}>
          <Monitor size={15} /> Ouvrir le Computer
        </button>
      )}
      {onCreateDot && (
        <button type="button" onClick={run(onCreateDot)}>
          <Plus size={15} /> Créer un Dot
        </button>
      )}
      {dots.length > 1 && (
        <div className="composer-menu-group">
          <span className="composer-menu-label">Changer de Dot</span>
          {dots.map((item) => (
            <button
              key={item.id}
              type="button"
              className={item.id === activeDotId ? 'active' : undefined}
              onClick={run(() => onChooseDot(item))}
            >
              {item.name}
            </button>
          ))}
        </div>
      )}
      {onContextBudget && (
        <div className="composer-menu-group">
          <span className="composer-menu-label">Contexte</span>
          {(
            [
              { label: '8K', value: 8192 },
              { label: '16K', value: 16384 },
              { label: '32K', value: 32768 },
              { label: 'Max (agentique)', value: null },
            ] as const
          ).map((option) => (
            <button
              key={option.label}
              type="button"
              className={
                (contextBudget ?? null) === option.value ? 'active' : undefined
              }
              onClick={run(() => onContextBudget(option.value))}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
      <div className="composer-menu-group">
        <span className="composer-menu-label">
          <BookOpen size={12} /> Insérer une mémoire
        </span>
        {memories.length ? (
          memories.slice(0, 6).map((item) => (
            <button
              key={item.id}
              type="button"
              title={item.text}
              onClick={run(() => onInsertMemory(item.text))}
            >
              {item.text.length > 46 ? `${item.text.slice(0, 46)}…` : item.text}
            </button>
          ))
        ) : (
          <span className="composer-menu-empty">Aucune mémoire</span>
        )}
      </div>
    </div>
  );
}
