import { useEffect, useMemo, useState } from 'react';
import {
  Brain,
  CalendarClock,
  Check,
  ChevronRight,
  Clock,
  FileText,
  Fingerprint,
  Globe,
  Keyboard,
  ListChecks,
  Loader2,
  Monitor,
  Search,
  ShieldCheck,
  Terminal,
  Wrench,
  X,
  type LucideIcon,
} from 'lucide-react';
import { Mascot, AVATARS } from './Mascot';
import { api } from './api';
import { activityVerb, type ActivityEvent, type ActivityKind } from '../shared/activity';
import { groupByDay, timeOfDay } from './day-groups';
import type { ComputerStatus } from '../shared/computer-types';
import type { Conversation, Dot, Settings, Task } from '../shared/types';

type Tab = 'activity' | 'security' | 'tasks' | 'profile';

const kindIcons: Record<ActivityKind, LucideIcon> = {
  command: Terminal,
  typing: Keyboard,
  web: Globe,
  file: FileText,
  search: Search,
  tool: Wrench,
  reasoning: Brain,
  task: CalendarClock,
};

const TABS: { id: Tab; label: string; icon: LucideIcon }[] = [
  { id: 'activity', label: 'Activité', icon: ListChecks },
  { id: 'security', label: 'Sécurité', icon: ShieldCheck },
  { id: 'tasks', label: 'Tâches', icon: Clock },
  { id: 'profile', label: 'Profil', icon: Fingerprint },
];

function statusText(running: boolean, paused: boolean): string {
  if (paused) return 'En pause';
  if (running) return 'Travaille…';
  return 'Connecté';
}

export function ActivityPanel({
  open,
  onClose,
  dot,
  dots,
  conversations,
  currentThreadId,
  liveEvents,
  running,
  paused,
  tasks,
  settings,
  onOpenConversation,
  onOpenReasoning,
  onOpenComputer,
  onOpenSettings,
  onOpenTasks,
}: {
  open: boolean;
  onClose: () => void;
  dot: Dot;
  dots: Dot[];
  conversations: Conversation[];
  currentThreadId: string;
  liveEvents: ActivityEvent[];
  running: boolean;
  paused: boolean;
  tasks: Task[];
  settings: Settings;
  onOpenConversation: (id: string) => void;
  onOpenReasoning: (id: string) => void;
  onOpenComputer?: () => void;
  onOpenSettings: () => void;
  onOpenTasks: () => void;
}) {
  const [tab, setTab] = useState<Tab>('activity');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [fetched, setFetched] = useState<Record<string, ActivityEvent[]>>({});
  const [computer, setComputer] = useState<ComputerStatus>();
  const [computerError, setComputerError] = useState('');
  const [busy, setBusy] = useState(false);

  // Load the computer status when the Sécurité or Profil tab is shown.
  useEffect(() => {
    if (!open || (tab !== 'security' && tab !== 'profile')) return;
    let active = true;
    setComputerError('');
    void api<ComputerStatus>(`/dots/${encodeURIComponent(dot.id)}/computer`)
      .then((value) => {
        if (active) setComputer(value);
      })
      .catch((cause) => {
        if (active)
          setComputerError(
            cause instanceof Error ? cause.message : 'Indisponible.',
          );
      });
    return () => {
      active = false;
    };
  }, [open, tab, dot.id]);

  const groups = useMemo(
    () =>
      groupByDay(
        conversations,
        (conversation) => conversation.updatedAt ?? conversation.createdAt,
      ),
    [conversations],
  );

  const eventsFor = (id: string): ActivityEvent[] =>
    id === currentThreadId ? liveEvents : (fetched[id] ?? []);

  const toggle = (conversation: Conversation) => {
    const id = conversation.id;
    if (id === currentThreadId) {
      setExpanded((current) => {
        const next = new Set(current);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      return;
    }
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    if (!fetched[id]) {
      void api<{ events: ActivityEvent[] }>(
        `/conversations/${encodeURIComponent(id)}/activity`,
      )
        .then((value) => setFetched((current) => ({ ...current, [id]: value.events })))
        .catch(() => setFetched((current) => ({ ...current, [id]: [] })));
    }
  };

  const patchComputer = async (patch: Record<string, boolean>) => {
    if (busy) return;
    setBusy(true);
    try {
      const value = await api<ComputerStatus>(
        `/dots/${encodeURIComponent(dot.id)}/computer/permissions`,
        'PATCH',
        patch,
      );
      setComputer(value);
    } catch (cause) {
      setComputerError(cause instanceof Error ? cause.message : 'Échec.');
    } finally {
      setBusy(false);
    }
  };
  const patchSettings = async (patch: Partial<Settings>) => {
    if (busy) return;
    setBusy(true);
    try {
      await api('/settings', 'PATCH', patch);
    } catch {
      // surfaced by the next /state poll
    } finally {
      setBusy(false);
    }
  };
  const setAvatar = async (avatar: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await api(`/dots/${encodeURIComponent(dot.id)}/avatar`, 'PUT', { avatar });
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;
  return (
    <aside className="muse-overlay" aria-label={`Assistant ${dot.name}`}>
      <div className="muse-panel">
        <button
          type="button"
          className="muse-close"
          aria-label="Fermer"
          onClick={onClose}
        >
          <X size={16} />
        </button>
        <header className="muse-head">
          <Mascot
            identity={dot.id}
            name={dot.name}
            avatar={dot.avatar}
            state={running ? 'working' : paused ? 'paused' : 'idle'}
          />
          <h2 className="muse-name">{dot.name}</h2>
          <span className={`muse-status ${running ? 'busy' : ''}`}>
            <span className="muse-status-dot" />
            {statusText(running, paused)}
          </span>
        </header>
        <nav className="muse-tabs" role="tablist">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              aria-label={label}
              className={tab === id ? 'active' : ''}
              onClick={() => setTab(id)}
            >
              <Icon size={16} />
            </button>
          ))}
        </nav>

        <div className="muse-body">
          {tab === 'activity' && (
            <>
              {!conversations.length && (
                <p className="muse-empty">
                  Les conversations de {dot.name} apparaîtront ici, groupées par
                  jour.
                </p>
              )}
              {groups.map((group) => (
                <section className="muse-day" key={group.label}>
                  <h3 className="muse-day-title">{group.label}</h3>
                  {group.items.map((conversation) => {
                    const event = eventsFor(conversation.id);
                    const isOpen = expanded.has(conversation.id);
                    const doing = conversation.id === currentThreadId && running;
                    const owner = dots.find((item) => item.id === conversation.dotId);
                    return (
                      <article
                        className={`muse-card ${isOpen ? 'expanded' : ''}`}
                        key={conversation.id}
                      >
                        <button
                          type="button"
                          className="muse-card-head"
                          onClick={() => onOpenConversation(conversation.id)}
                          title={conversation.title}
                        >
                          <span className="muse-card-icon">
                            <Mascot
                              identity={conversation.dotId}
                              name={owner?.name}
                              avatar={owner?.avatar}
                              small
                              decorative
                            />
                          </span>
                          <span className="muse-card-text">
                            <span className="muse-card-title">
                              {conversation.title}
                            </span>
                            <span className="muse-card-sub">
                              {doing
                                ? 'en cours…'
                                : conversation.summary || 'Conversation'}
                            </span>
                          </span>
                          <span className="muse-card-time">
                            {timeOfDay(
                              conversation.updatedAt ?? conversation.createdAt,
                            )}
                          </span>
                          <span className={`muse-card-badge ${doing ? 'busy' : ''}`}>
                            {doing ? (
                              <Loader2 size={13} className="spin" />
                            ) : (
                              <Check size={13} />
                            )}
                          </span>
                        </button>
                        <button
                          type="button"
                          className="muse-card-toggle"
                          aria-label="Voir les actions"
                          aria-expanded={isOpen}
                          onClick={() => toggle(conversation)}
                        >
                          <ChevronRight
                            size={14}
                            className={isOpen ? 'open' : ''}
                          />
                        </button>
                        {isOpen && (
                          <div className="muse-card-tools">
                            {event.length ? (
                              event.map((item) => {
                                const Icon = kindIcons[item.kind];
                                return (
                                  <button
                                    type="button"
                                    className={`muse-tool ${item.status}`}
                                    key={item.id}
                                    onClick={() =>
                                      item.kind === 'reasoning' &&
                                      onOpenReasoning(item.id)
                                    }
                                    title={item.detail}
                                  >
                                    <Icon size={13} />
                                    <span className="muse-tool-text">
                                      {item.kind === 'reasoning'
                                        ? item.label
                                        : activityVerb(item)}
                                    </span>
                                    <span className={`muse-tool-state ${item.status}`}>
                                      {item.status === 'running'
                                        ? 'en cours'
                                        : item.status === 'error'
                                          ? 'erreur'
                                          : item.status === 'stopped'
                                            ? 'arrêté'
                                            : 'fait'}
                                    </span>
                                  </button>
                                );
                              })
                            ) : (
                              <p className="muse-empty">Aucune action enregistrée.</p>
                            )}
                          </div>
                        )}
                      </article>
                    );
                  })}
                </section>
              ))}
            </>
          )}

          {tab === 'security' && (
            <section className="muse-section">
              <h3>Ordinateur de {dot.name}</h3>
              {computerError && (
                <p className="muse-error" role="alert">
                  {computerError}
                </p>
              )}
              {computer ? (
                <>
                  <p className="muse-note">
                    État : {computer.state.replaceAll('_', ' ')}
                    {computer.control?.holder === 'human'
                      ? ' · vous avez le contrôle'
                      : ''}
                  </p>
                  {(
                    [
                      ['enabled', 'Activer cet ordinateur'],
                      ['browser', 'Navigateur'],
                      ['files', 'Fichiers'],
                      ['shell', 'Terminal'],
                    ] as const
                  ).map(([key, label]) => (
                    <label className="muse-check" key={key}>
                      <input
                        type="checkbox"
                        checked={computer.permissions[key]}
                        disabled={busy}
                        onChange={(event) =>
                          void patchComputer({ [key]: event.target.checked })
                        }
                      />
                      {label}
                    </label>
                  ))}
                  {onOpenComputer && (
                    <button
                      type="button"
                      className="muse-link"
                      onClick={onOpenComputer}
                    >
                      <Monitor size={14} /> Ouvrir l’ordinateur
                    </button>
                  )}
                </>
              ) : (
                !computerError && <p className="muse-note">Chargement…</p>
              )}
              <h3>Général</h3>
              <label className="muse-check">
                <input
                  type="checkbox"
                  checked={settings.researchAllowed}
                  disabled={busy}
                  onChange={(event) =>
                    void patchSettings({ researchAllowed: event.target.checked })
                  }
                />
                Recherche sur pages publiques
              </label>
              <label className="muse-check">
                <input
                  type="checkbox"
                  checked={settings.memoryAllowed}
                  disabled={busy}
                  onChange={(event) =>
                    void patchSettings({ memoryAllowed: event.target.checked })
                  }
                />
                Utiliser les mémoires
              </label>
            </section>
          )}

          {tab === 'tasks' && (
            <section className="muse-section">
              <h3>Tâches planifiées</h3>
              {tasks.length ? (
                <ul className="muse-task-list">
                  {tasks.map((task) => (
                    <li key={task.id}>
                      <span className={`muse-task-state ${task.status}`}>
                        {task.status}
                      </span>
                      <span className="muse-task-text">{task.prompt}</span>
                      <span className="muse-task-time">
                        {task.nextRunAt
                          ? timeOfDay(task.nextRunAt)
                          : task.intervalSeconds
                            ? 'répétée'
                            : 'une fois'}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muse-note">Aucune tâche planifiée.</p>
              )}
              <button type="button" className="muse-link" onClick={onOpenTasks}>
                <Clock size={14} /> Gérer les tâches
              </button>
            </section>
          )}

          {tab === 'profile' && (
            <section className="muse-section">
              <h3>Apparence</h3>
              <div className="avatar-swatches">
                {AVATARS.map((avatar) => (
                  <button
                    type="button"
                    key={avatar}
                    className={`avatar-swatch ${
                      (dot.avatar ?? 'blue') === avatar ? 'active' : ''
                    }`}
                    aria-label={`Avatar ${avatar}`}
                    disabled={busy}
                    onClick={() => void setAvatar(avatar)}
                  >
                    <img
                      src={`/dots/${avatar}.png`}
                      alt=""
                      width={34}
                      height={34}
                    />
                  </button>
                ))}
              </div>
              <h3>Modèle</h3>
              <p className="muse-note">{dot.model ?? 'Défaut du serveur'}</p>
              <p className="muse-note">
                Réflexion :{' '}
                {dot.reasoningEffort && dot.reasoningEffort !== 'none'
                  ? dot.reasoningEffort
                  : 'désactivée'}
              </p>
              <button
                type="button"
                className="muse-link"
                onClick={onOpenSettings}
              >
                <Fingerprint size={14} /> Ouvrir les paramètres
              </button>
            </section>
          )}
        </div>
      </div>
    </aside>
  );
}
