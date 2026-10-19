import { useEffect, useRef, useState } from 'react';
import {
  Activity,
  Bot,
  Cpu,
  Info,
  KeyRound,
  Languages,
  Palette,
  Plug,
  SlidersHorizontal,
  CircleUserRound,
  Users,
  X,
} from 'lucide-react';
import type {
  Dot,
  Memory,
  ReplyLanguage,
  ReplyStyle,
  Space,
  State,
  UsageReport,
  UsageSummary,
  WorkspaceState,
} from '../shared/types';
import type { ModelsResponse } from '../shared/models';
import { api } from './api';
import { AVATARS } from './Mascot';
import { avatarPoster, isProtectedAvatar } from '../shared/avatars';
import { ConnectionsSection } from './ConnectionsSection';
import { ExternalAccountsSection } from './ExternalAccountsSection';
import { ApiProvidersPanel } from './ApiProvidersPanel';
import { AccountsPanel } from './AccountsPanel';
import { ModelSelectorPanel } from './ModelSelectorPanel';

import { DeepThinkPanel } from './DeepThinkPanel';
import { AvatarPanel } from './AvatarPanel';
import {
  PALETTES,
  palettePreference,
  setPalettePreference,
  setThemePreference,
  themePreference,
  type ThemePreference,
} from './theme';
import {
  motionPreference,
  setMotionPreference,
  type MotionPreference,
} from './motion-pref';
export type Dialog =
  | { type: 'space'; space?: Space }
  | { type: 'dot'; dot?: Dot; spaceId: string }
  | { type: 'settings' }
  | { type: 'memory'; memory?: Memory }
  | { type: 'schedule'; threadId: string };

interface SystemMetrics {
  cpu: number | null;
  mem: number | null;
  disk: number | null;
  uptime: number;
  model: string | null;
}

type SettingsTab =
  | 'appearance'
  | 'avatar'
  | 'api'
  | 'models'
  | 'deepthink'
  | 'preferences'
  | 'dots'
  | 'connections'
  | 'health'
  | 'about'
  | 'accounts';

/** Compact token count for the usage card (1.2k, 3.4M). */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** Taux de hit du cache provider, en suffixe FR ; vide si aucun hit. */
function cacheLabel(s: UsageSummary): string {
  if (!s.promptTokens || !s.cachedTokens) return '';
  return ` · ${Math.round((s.cachedTokens / s.promptTokens) * 100)} % en cache`;
}

export function WorkspaceDialog({
  dialog,
  state,
  workspace,
  onClose,
  onOpenDialog,
  mutate,
}: {
  dialog: Dialog;
  state: State;
  workspace: WorkspaceState;
  onClose: () => void;
  onOpenDialog: (dialog: Dialog) => void;
  mutate: (path: string, method: string, body?: unknown) => Promise<boolean>;
}) {
  const [name, setName] = useState(
    dialog.type === 'dot'
      ? (dialog.dot?.name ?? '')
      : dialog.type === 'space'
        ? (dialog.space?.name ?? '')
        : '',
  );
  const [text, setText] = useState(
    dialog.type === 'dot'
      ? (dialog.dot?.instructions ?? '')
      : dialog.type === 'memory'
        ? (dialog.memory?.text ?? '')
        : dialog.type === 'space'
          ? (dialog.space?.description ?? '')
          : '',
  );
  const [research, setResearch] = useState(
    dialog.type === 'dot'
      ? (dialog.dot?.researchAllowed ?? true)
      : state.settings.researchAllowed,
  );
  const [memory, setMemory] = useState(
    dialog.type === 'dot'
      ? (dialog.dot?.memoryAllowed ?? true)
      : state.settings.memoryAllowed,
  );
  const [replyStyle, setReplyStyle] = useState<ReplyStyle>(
    state.settings.replyStyle ?? 'standard',
  );
  const [replyLanguage, setReplyLanguage] = useState<ReplyLanguage>(
    state.settings.replyLanguage ?? 'fr',
  );
  const [usage, setUsage] = useState<UsageReport | null>(null);
  const [forgetArmed, setForgetArmed] = useState(false);
  const [spaceIds, setSpaceIds] = useState(
    dialog.type === 'dot' ? (dialog.dot?.spaceIds ?? [dialog.spaceId]) : [],
  );
  const [defaultSpace, setDefaultSpace] = useState(
    dialog.type === 'dot' ? (dialog.dot?.spaceId ?? dialog.spaceId) : '',
  );
  const [interval, setInterval] = useState('86400');
  const [scheduleMode, setScheduleMode] = useState<'repeat' | 'once'>('repeat');
  const [runAtLocal, setRunAtLocal] = useState('');
  const [learningContainer, setLearningContainer] = useState(
    dialog.type === 'dot' ? (dialog.dot?.learningContainerId ?? '') : '',
  );
  const [skillDelivery, setSkillDelivery] = useState(
    dialog.type === 'dot' ? (dialog.dot?.skillDeliveryEnabled ?? false) : false,
  );
  const [avatar, setAvatar] = useState<string | null>(
    dialog.type === 'dot' ? (dialog.dot?.avatar ?? null) : null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [dotTab, setDotTab] = useState<'general' | 'access' | 'automation'>(
    'general',
  );
  const [theme, setTheme] = useState(themePreference);
  const [palette, setPalette] = useState(palettePreference);
  const [motion, setMotion] = useState(motionPreference);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('appearance');
  const [models, setModels] = useState<ModelsResponse>({
    default: null,
    providers: [],
  });
  /** Phase E : rôle du compte connecté (onglet Comptes = Admin seulement). */
  const [myRole, setMyRole] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<SystemMetrics | null>(null);
  const [connectionDot, setConnectionDot] = useState(
    workspace.dots[0]?.id ?? '',
  );
  useEffect(() => {
    if (dialog.type !== 'settings') return;
    let active = true;
    void api<ModelsResponse>('/models')
      .then((value) => {
        if (active) setModels(value);
      })
      .catch(() => {});
    void api<SystemMetrics>('/metrics')
      .then((value) => {
        if (active) setMetrics(value);
      })
      .catch(() => {});
    void api<UsageReport>('/usage')
      .then((value) => {
        if (active) setUsage(value);
      })
      .catch(() => {});
    // Phase E : le rôle (Admin = onglet Comptes visible).
    void api<{ username: string; role: string }>('/auth/me')
      .then((value) => {
        if (active) setMyRole(value.role);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [dialog.type]);
  const container = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    container.current
      ?.querySelector<HTMLElement>('input,textarea,select')
      ?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'Tab') {
        const items = [
          ...(container.current?.querySelectorAll<HTMLElement>(
            'button:not([disabled]),input,textarea,select,a[href]',
          ) ?? []),
        ];
        if (event.shiftKey && document.activeElement === items[0]) {
          event.preventDefault();
          items.at(-1)?.focus();
        } else if (!event.shiftKey && document.activeElement === items.at(-1)) {
          event.preventDefault();
          items[0]?.focus();
        }
      }
    };
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('keydown', key);
      previous?.focus();
    };
  }, []);
  const title =
    dialog.type === 'space'
      ? dialog.space
        ? 'Modifier cet espace.'
        : 'A space for something.'
      : dialog.type === 'dot'
        ? dialog.dot
          ? 'Make this Dot yours.'
          : 'Meet your next specialist.'
        : dialog.type === 'settings'
          ? 'Paramètres'
          : dialog.type === 'memory'
            ? 'Something to remember.'
            : 'Let your Dot keep time.';
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section
        className={`modal ${dialog.type === 'settings' ? 'settings-modal' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        ref={container}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          className="modal-close icon-button"
          aria-label="Close dialog"
          onClick={onClose}
        >
          <X size={18} />
        </button>
        {dialog.type !== 'settings' && (
          <span className="eyebrow">NEVADOTS</span>
        )}
        {dialog.type !== 'settings' && <h2 id="dialog-title">{title}</h2>}
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError('');
            let path = '',
              method = 'POST',
              body: unknown;
            if (dialog.type === 'space') {
              path = dialog.space ? `/spaces/${dialog.space.id}` : '/spaces';
              method = dialog.space ? 'PUT' : 'POST';
              body = { name, description: text };
            }
            if (dialog.type === 'dot') {
              path = dialog.dot ? `/dots/${dialog.dot.id}` : '/dots';
              method = dialog.dot ? 'PUT' : 'POST';
              body = {
                spaceId: defaultSpace,
                spaceIds,
                name,
                instructions: text,
                researchAllowed: research,
                memoryAllowed: memory,
                learningContainerId: learningContainer.trim() || null,
                skillDeliveryEnabled: skillDelivery,
                avatar,
              };
            }
            if (dialog.type === 'settings') {
              if (settingsTab !== 'preferences') {
                onClose();
                setBusy(false);
                return;
              }
              path = '/settings';
              method = 'PATCH';
              body = {
                researchAllowed: research,
                memoryAllowed: memory,
                replyStyle,
                replyLanguage,
              };
            }
            if (dialog.type === 'memory') {
              path = dialog.memory
                ? `/memories/${dialog.memory.id}`
                : '/memories';
              method = dialog.memory ? 'PUT' : 'POST';
              body = { text };
            }
            if (dialog.type === 'schedule') {
              path = '/tasks';
              body =
                scheduleMode === 'once'
                  ? {
                      prompt: text,
                      threadId: dialog.threadId,
                      runAt: runAtLocal
                        ? new Date(runAtLocal).getTime()
                        : Date.now(),
                    }
                  : {
                      prompt: text,
                      threadId: dialog.threadId,
                      intervalSeconds: Number(interval),
                    };
            }
            if (await mutate(path, method, body)) onClose();
            else
              setError('Could not save. Review the workspace error and retry.');
            setBusy(false);
          }}
        >
          {(dialog.type === 'space' || dialog.type === 'dot') && (
            <>
              <label className="field-label" htmlFor="entity-name">
                Name
              </label>
              <input
                id="entity-name"
                value={name}
                maxLength={40}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </>
          )}
          {dialog.type !== 'settings' && (
            <>
              <label className="field-label" htmlFor="entity-text">
                {dialog.type === 'dot'
                  ? 'Role instructions'
                  : dialog.type === 'space'
                    ? 'What belongs here?'
                    : dialog.type === 'memory'
                      ? 'Preference or context'
                      : 'Task to revisit'}
              </label>
              <textarea
                id="entity-text"
                rows={4}
                maxLength={dialog.type === 'schedule' ? 4000 : 2000}
                required={dialog.type !== 'space'}
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={
                  dialog.type === 'dot'
                    ? 'You are a thoughtful research partner. Compare evidence and be clear about uncertainty.'
                    : ''
                }
              />
            </>
          )}
          {dialog.type === 'dot' && (
            <div className="dot-tabs" role="tablist" aria-label="Dot settings">
              {(
                [
                  ['general', 'Général'],
                  ['access', 'Accès & mémoire'],
                  ['automation', 'Automatisation'],
                ] as const
              ).map(([id, label]) => (
                <button
                  type="button"
                  key={id}
                  role="tab"
                  aria-selected={dotTab === id}
                  className={`dot-tab-button ${dotTab === id ? 'active' : ''}`}
                  onClick={() => setDotTab(id)}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          {dialog.type === 'dot' && dotTab === 'general' && (
            <fieldset className="avatar-picker">
              <legend>Avatar</legend>
              <div className="avatar-swatches">
                {AVATARS.map((id) => {
                  const protect = isProtectedAvatar(id);
                  return (
                    <button
                      type="button"
                      key={id}
                      className={`avatar-swatch ${avatar === id ? 'active' : ''} ${protect ? 'protected-avatar' : ''}`}
                      aria-label={id}
                      title={id}
                      onClick={() => setAvatar(avatar === id ? null : id)}
                      onContextMenu={
                        protect ? (event) => event.preventDefault() : undefined
                      }
                    >
                      <img
                        src={avatarPoster(id) ?? undefined}
                        alt=""
                        width={44}
                        height={44}
                        draggable={protect ? false : undefined}
                      />
                    </button>
                  );
                })}
              </div>
              <p className="muted">
                Cliquez pour choisir, re-cliquez pour revenir au défaut.
              </p>
            </fieldset>
          )}
          {dialog.type === 'dot' && dotTab === 'access' && (
            <fieldset className="space-access-fields">
              <legend>Space access</legend>
              <p className="muted">
                Choose where this Dot can read and edit pages.
              </p>
              {workspace.spaces.map((space) => (
                <label className="permission-row" key={space.id}>
                  <input
                    type="checkbox"
                    checked={spaceIds.includes(space.id)}
                    onChange={(event) => {
                      const next = event.target.checked
                        ? [...spaceIds, space.id]
                        : spaceIds.filter((id) => id !== space.id);
                      setSpaceIds(next);
                      if (!next.includes(defaultSpace))
                        setDefaultSpace(next[0] ?? '');
                    }}
                  />
                  <span>{space.name}</span>
                </label>
              ))}
              <label className="field-label" htmlFor="default-space">
                Default destination for saved pages
              </label>
              <select
                id="default-space"
                value={defaultSpace}
                required
                onChange={(event) => setDefaultSpace(event.target.value)}
              >
                <option value="" disabled>
                  Choose a Space
                </option>
                {workspace.spaces
                  .filter((space) => spaceIds.includes(space.id))
                  .map((space) => (
                    <option key={space.id} value={space.id}>
                      {space.name}
                    </option>
                  ))}
              </select>
            </fieldset>
          )}
          {dialog.type === 'dot' && dotTab === 'access' && (
            <>
              <label className="permission-row">
                <input
                  type="checkbox"
                  checked={research}
                  onChange={(e) => setResearch(e.target.checked)}
                />
                <span>
                  <strong>Public-page research</strong>
                  <small>
                    Allow the server-side read-only browser tool. Global
                    settings always take precedence.
                  </small>
                </span>
              </label>
              <label className="permission-row">
                <input
                  type="checkbox"
                  checked={memory}
                  onChange={(e) => setMemory(e.target.checked)}
                />
                <span>
                  <strong>Use saved memories</strong>
                  <small>
                    Include your preferences in new turns. Changing permission
                    stops active work.
                  </small>
                </span>
              </label>
            </>
          )}
          {dialog.type === 'dot' && dotTab === 'automation' && (
            <fieldset className="space-access-fields">
              <legend>Automatic Learning</legend>
              <label className="field-label" htmlFor="learning-container">
                Learning container ID
              </label>
              <input
                id="learning-container"
                value={learningContainer}
                maxLength={64}
                pattern="[a-z0-9]+(-[a-z0-9]+)*"
                placeholder="research-workflow"
                aria-describedby="learning-help"
                onChange={(event) => {
                  setLearningContainer(event.target.value);
                  if (!event.target.value.trim()) setSkillDelivery(false);
                }}
              />
              <p className="muted" id="learning-help">
                Create this container in your Intelligence project first. New
                conversations will contribute evidence to it. Leave blank to
                keep new conversations out of Learning. Existing conversations
                retain their original assignment.
              </p>
              <label className="permission-row">
                <input
                  type="checkbox"
                  checked={skillDelivery}
                  disabled={!learningContainer.trim()}
                  onChange={(event) => setSkillDelivery(event.target.checked)}
                />
                <span>
                  <strong>Use published skills</strong>
                  <small>
                    Load reviewed skills from each conversation’s assigned
                    container. Enable delivery in Intelligence too. Turning this
                    off stops skill loading; it does not stop evidence
                    collection.
                  </small>
                </span>
              </label>
              <a
                href="https://docs.copilotkit.ai/learning"
                target="_blank"
                rel="noreferrer"
              >
                Set up Learning and review skills ↗
              </a>
            </fieldset>
          )}
          {dialog.type === 'dot' && dotTab === 'automation' && dialog.dot && (
            <ConnectionsSection dotId={dialog.dot.id} />
          )}
          {dialog.type === 'schedule' && (
            <>
              <label className="field-label" htmlFor="schedule-mode">
                Quand exécuter
              </label>
              <select
                id="schedule-mode"
                value={scheduleMode}
                onChange={(e) =>
                  setScheduleMode(e.target.value as 'repeat' | 'once')
                }
              >
                <option value="repeat">Répéter</option>
                <option value="once">
                  Une seule fois, à une heure précise
                </option>
              </select>
              {scheduleMode === 'once' ? (
                <>
                  <label className="field-label" htmlFor="schedule-runat">
                    Date et heure (heure locale)
                  </label>
                  <input
                    id="schedule-runat"
                    type="datetime-local"
                    value={runAtLocal}
                    onChange={(e) => setRunAtLocal(e.target.value)}
                  />
                </>
              ) : (
                <>
                  <label className="field-label" htmlFor="schedule-interval">
                    Répéter après chaque exécution réussie
                  </label>
                  <select
                    id="schedule-interval"
                    value={interval}
                    onChange={(e) => setInterval(e.target.value)}
                  >
                    <option value="60">Chaque minute (test)</option>
                    <option value="3600">Chaque heure</option>
                    <option value="86400">Chaque jour</option>
                    <option value="604800">Chaque semaine</option>
                  </select>
                </>
              )}
              <p className="muted">
                S'exécute sur le serveur dans cette conversation, même onglet
                fermé. Un échec attend une relance manuelle.
              </p>
            </>
          )}
          {dialog.type === 'settings' && (
            <div className="settings-layout">
              <nav
                className="settings-nav"
                role="tablist"
                aria-orientation="vertical"
                aria-label="Modules des paramètres"
              >
                <h2 id="dialog-title" className="settings-title">
                  {title}
                </h2>
                {(
                  [
                    ['appearance', 'Apparence', Palette],
                    ['avatar', 'Avatar', CircleUserRound],
                    ['api', 'API et Modèles', KeyRound],
                    ['models', 'Sélecteur de modèles', Cpu],

                    ['deepthink', 'DeepThink', Languages],
                    ['preferences', 'Réglages', SlidersHorizontal],
                    ['dots', 'Dots & Espaces', Bot],
                    ['connections', 'Connexions', Plug],
                    ['health', 'Santé', Activity],
                    ['about', 'À propos', Info],
                    // Phase E : onglet Comptes = Admin seulement.
                    ['accounts', 'Comptes', Users],
                  ] as const
                )
                  .filter(([id]) => id !== 'accounts' || myRole === 'admin')
                  .map(([id, label, Icon]) => (
                    <button
                      key={id}
                      type="button"
                      role="tab"
                      className={`settings-nav-item ${settingsTab === id ? 'active' : ''}`}
                      aria-selected={settingsTab === id}
                      onClick={() => setSettingsTab(id)}
                    >
                      <Icon size={16} aria-hidden="true" />
                      <span>{label}</span>
                    </button>
                  ))}
              </nav>
              <div className="settings-body">
                {dialog.type === 'settings' && settingsTab === 'appearance' && (
                  <fieldset className="appearance-fields">
                    <legend>Apparence</legend>
                    <div className="segmented" role="radiogroup">
                      {(
                        [
                          'system',
                          'light',
                          'dark',
                          'hard_dark',
                        ] as ThemePreference[]
                      ).map((option) => (
                        <label key={option}>
                          <input
                            type="radio"
                            name="theme"
                            value={option}
                            checked={theme === option}
                            onChange={() => {
                              setTheme(option);
                              setThemePreference(option);
                            }}
                          />
                          <span>
                            {option
                              .split('_')
                              .map(
                                (part) => part[0].toUpperCase() + part.slice(1),
                              )
                              .join(' ')}
                          </span>
                        </label>
                      ))}
                    </div>
                    <p className="muted">
                      Mémorisé dans ce navigateur · Système suit l’appareil.
                    </p>
                    <div
                      className="segmented"
                      role="radiogroup"
                      aria-label="Effets d'animation"
                    >
                      {(
                        [
                          ['full', 'Complets'],
                          ['reduced', 'Réduits'],
                          ['off', 'Désactivés'],
                        ] as [MotionPreference, string][]
                      ).map(([option, label]) => (
                        <label key={option}>
                          <input
                            type="radio"
                            name="motion"
                            value={option}
                            checked={motion === option}
                            onChange={() => {
                              setMotion(option);
                              setMotionPreference(option);
                            }}
                          />
                          <span>{label}</span>
                        </label>
                      ))}
                    </div>
                    <p className="muted">
                      Animations de l’interface · Mémorisé dans ce navigateur.
                    </p>
                    <div
                      className="palette-swatches"
                      role="radiogroup"
                      aria-label="Couleur d’accent"
                    >
                      {PALETTES.map((item) => (
                        <button
                          key={item.id}
                          type="button"
                          className={`palette-swatch ${palette === item.id ? 'active' : ''}`}
                          style={{ background: item.color }}
                          title={item.label}
                          aria-label={item.label}
                          aria-pressed={palette === item.id}
                          onClick={() => {
                            setPalette(item.id);
                            setPalettePreference(item.id);
                          }}
                        />
                      ))}
                    </div>
                    <p className="muted">Couleur d’accent.</p>
                  </fieldset>
                )}
                {dialog.type === 'settings' && settingsTab === 'avatar' && (
                  <AvatarPanel />
                )}
                {dialog.type === 'settings' && settingsTab === 'api' && (
                  <ApiProvidersPanel />
                )}
                {dialog.type === 'settings' && settingsTab === 'models' && (
                  <ModelSelectorPanel />
                )}
                {dialog.type === 'settings' && settingsTab === 'deepthink' && (
                  <DeepThinkPanel />
                )}{' '}
                {dialog.type === 'settings' &&
                  settingsTab === 'preferences' && (
                    <div className="prefs">
                      <section className="prefs-summary" aria-label="Résumé">
                        <div className="prefs-kpi">
                          <span className="prefs-kpi-val">
                            {workspace.dots.length}
                          </span>
                          <span className="prefs-kpi-label">Dot(s)</span>
                        </div>
                        <div className="prefs-kpi">
                          <span
                            className="prefs-kpi-val"
                            title={models.default?.model ?? ''}
                          >
                            {models.default?.model ??
                              metrics?.model ??
                              'non configuré'}
                          </span>
                          <span className="prefs-kpi-label">
                            Modèle par défaut
                          </span>
                        </div>
                        <div className="prefs-kpi">
                          <span className="prefs-kpi-val">
                            {usage ? `$${usage.today.costUsd.toFixed(3)}` : '—'}
                          </span>
                          <span className="prefs-kpi-label">
                            Coût aujourd’hui
                          </span>
                        </div>
                      </section>

                      <h3 className="prefs-section">Préférences de travail</h3>
                      <p className="muted prefs-lead">
                        Capacités communes à tous vos Dots.
                      </p>

                      <label className="permission-row">
                        <input
                          type="checkbox"
                          checked={research}
                          onChange={(e) => setResearch(e.target.checked)}
                        />
                        <span>
                          <strong>Recherche sur pages publiques</strong>
                          <small>
                            Autorise le navigateur serveur en lecture seule. Les
                            réglages globaux restent prioritaires.
                          </small>
                        </span>
                      </label>
                      <label className="permission-row">
                        <input
                          type="checkbox"
                          checked={memory}
                          onChange={(e) => setMemory(e.target.checked)}
                        />
                        <span>
                          <strong>Utiliser les mémoires</strong>
                          <small>
                            Inclut vos préférences dans les nouveaux tours.
                            Changer ce réglage arrête le travail en cours.
                          </small>
                        </span>
                      </label>

                      <div className="memory-actions">
                        <span className="muted">
                          {state.memories.length} mémoire
                          {state.memories.length > 1 ? 's' : ''} enregistrée
                          {state.memories.length > 1 ? 's' : ''}
                        </span>
                        <button
                          type="button"
                          className={`text-button${forgetArmed ? ' danger' : ''}`}
                          disabled={!state.memories.length || busy}
                          onClick={async () => {
                            if (!forgetArmed) {
                              setForgetArmed(true);
                              return;
                            }
                            setBusy(true);
                            setError('');
                            try {
                              await api('/memories', 'DELETE');
                              setForgetArmed(false);
                            } catch {
                              setError('Suppression impossible.');
                            } finally {
                              setBusy(false);
                            }
                          }}
                        >
                          {forgetArmed ? 'Confirmer ?' : 'Tout oublier'}
                        </button>
                      </div>

                      <div className="prefs-field">
                        <span className="prefs-field-label">
                          Style de réponse
                        </span>
                        <div
                          className="segmented"
                          role="radiogroup"
                          aria-label="Style de réponse"
                        >
                          {(
                            [
                              ['concise', 'Concis'],
                              ['standard', 'Standard'],
                              ['detailed', 'Détaillé'],
                            ] as [ReplyStyle, string][]
                          ).map(([option, label]) => (
                            <label key={option}>
                              <input
                                type="radio"
                                name="reply-style"
                                value={option}
                                checked={replyStyle === option}
                                onChange={() => setReplyStyle(option)}
                              />
                              <span>{label}</span>
                            </label>
                          ))}
                        </div>
                      </div>

                      <div className="prefs-field">
                        <span className="prefs-field-label">
                          Langue de réponse
                        </span>
                        <div
                          className="segmented"
                          role="radiogroup"
                          aria-label="Langue de réponse"
                        >
                          {(
                            [
                              ['fr', 'Français'],
                              ['auto', 'Suivre l’utilisateur'],
                            ] as [ReplyLanguage, string][]
                          ).map(([option, label]) => (
                            <label key={option}>
                              <input
                                type="radio"
                                name="reply-language"
                                value={option}
                                checked={replyLanguage === option}
                                onChange={() => setReplyLanguage(option)}
                              />
                              <span>{label}</span>
                            </label>
                          ))}
                        </div>
                      </div>

                      <h3 className="prefs-section">
                        Configuration des modèles
                      </h3>
                      <p className="muted prefs-lead">
                        Fournisseurs, consommation et modèle de chaque Dot.
                      </p>

                      <div className="provider-chips">
                        {models.providers.length > 0 ? (
                          models.providers.map((provider) => (
                            <button
                              type="button"
                              key={provider.id}
                              className="provider-chip"
                              title={provider.models.join(', ')}
                              onClick={() => setSettingsTab('api')}
                            >
                              <span
                                className={`chip-dot ${provider.configured ? 'ok' : 'off'}`}
                                aria-hidden="true"
                              />
                              <strong>{provider.label}</strong>
                              <small>
                                {provider.configured
                                  ? 'clé configurée'
                                  : 'clé absente'}
                              </small>
                            </button>
                          ))
                        ) : (
                          <p className="muted">Aucun fournisseur détecté.</p>
                        )}
                      </div>

                      <div className="usage-card">
                        <div className="usage-row">
                          <span>Aujourd’hui</span>
                          <strong>
                            {usage ? `$${usage.today.costUsd.toFixed(3)}` : '—'}
                          </strong>
                          <span>
                            {usage
                              ? `${fmtTokens(usage.today.promptTokens + usage.today.completionTokens)} jetons · ${usage.today.runs} appel(s)${cacheLabel(usage.today)}`
                              : ''}
                          </span>
                        </div>
                        <div className="usage-row">
                          <span>7 derniers jours</span>
                          <strong>
                            {usage ? `$${usage.week.costUsd.toFixed(3)}` : '—'}
                          </strong>
                          <span>
                            {usage
                              ? `${fmtTokens(usage.week.promptTokens + usage.week.completionTokens)} jetons · ${usage.week.runs} appel(s)${cacheLabel(usage.week)}`
                              : ''}
                          </span>
                        </div>
                      </div>

                      {workspace.dots.length > 0 && (
                        <ul className="dot-model-list">
                          {workspace.dots.map((item) => (
                            <li className="dot-model-row" key={item.id}>
                              <span className="dot-model-name">
                                {item.name}
                              </span>
                              <span className="dot-model-meta">
                                <code>
                                  {item.model ??
                                    models.default?.model ??
                                    'défaut'}
                                </code>
                                <span>
                                  {item.contextBudget
                                    ? `${item.contextBudget / 1024}K`
                                    : 'Max'}
                                </span>
                                <span>
                                  {item.compactionStrategy === 'magic-compact'
                                    ? 'Magic Compact'
                                    : 'Natif'}
                                </span>
                              </span>
                              <button
                                type="button"
                                className="text-button"
                                onClick={() =>
                                  onOpenDialog({
                                    type: 'dot',
                                    dot: item,
                                    spaceId: item.spaceId,
                                  })
                                }
                              >
                                Régler
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                {dialog.type === 'settings' && settingsTab === 'dots' && (
                  <div className="settings-list ws-workspace">
                    <div className="settings-list-head">
                      <strong>Dots</strong>
                      <button
                        type="button"
                        className="text-button"
                        onClick={() =>
                          onOpenDialog({
                            type: 'dot',
                            spaceId: workspace.spaces[0]?.id ?? '',
                          })
                        }
                      >
                        Nouveau
                      </button>
                    </div>
                    {workspace.dots.map((item) => {
                      const conversations = workspace.conversations.filter(
                        (conversation) => conversation.dotId === item.id,
                      ).length;
                      const spend = usage?.byDot.find(
                        (entry) => entry.dotId === item.id,
                      );
                      return (
                        <div className="ws-dot" key={item.id}>
                          <img
                            className="ws-avatar"
                            src={avatarPoster(item.avatar) ?? undefined}
                            alt=""
                            width={40}
                            height={40}
                          />
                          <div className="ws-main">
                            <span className="ws-name">{item.name}</span>
                            <span className="ws-meta">
                              <code>{item.model ?? 'modèle par défaut'}</code>
                              <span>
                                {item.contextBudget
                                  ? `${item.contextBudget / 1024}K`
                                  : 'Contexte Max'}
                              </span>
                              <span>
                                {item.compactionStrategy === 'magic-compact'
                                  ? 'Magic Compact'
                                  : 'Compaction native'}
                              </span>
                              <span>
                                {conversations} conversation
                                {conversations > 1 ? 's' : ''}
                              </span>
                              {spend && spend.runs > 0 && (
                                <span title="Coût estimé sur 7 jours">
                                  ${spend.costUsd.toFixed(3)} / 7 j
                                  {spend.cachedTokens > 0 && (
                                    <em className="muted">
                                      {' '}
                                      ·{' '}
                                      {Math.round(
                                        (spend.cachedTokens /
                                          Math.max(spend.promptTokens, 1)) *
                                          100,
                                      )}
                                      % cache
                                    </em>
                                  )}
                                </span>
                              )}
                            </span>
                            <span className="ws-badges">
                              <span
                                className={`ws-badge ${item.researchAllowed ? 'on' : 'off'}`}
                              >
                                Recherche
                              </span>
                              <span
                                className={`ws-badge ${item.memoryAllowed ? 'on' : 'off'}`}
                              >
                                Mémoires
                              </span>
                            </span>
                          </div>
                          <div className="ws-actions">
                            <button
                              type="button"
                              className="text-button"
                              onClick={() =>
                                onOpenDialog({
                                  type: 'dot',
                                  dot: item,
                                  spaceId: item.spaceId,
                                })
                              }
                            >
                              Modifier
                            </button>
                            <button
                              type="button"
                              className="text-button"
                              disabled={busy}
                              onClick={async () => {
                                setBusy(true);
                                setError('');
                                try {
                                  await api(
                                    `/dots/${encodeURIComponent(item.id)}/duplicate`,
                                    'POST',
                                  );
                                } catch {
                                  setError('Duplication impossible.');
                                } finally {
                                  setBusy(false);
                                }
                              }}
                            >
                              Dupliquer
                            </button>
                          </div>
                        </div>
                      );
                    })}
                    <div className="settings-list-head">
                      <strong>Espaces</strong>
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => onOpenDialog({ type: 'space' })}
                      >
                        Nouveau
                      </button>
                    </div>
                    {workspace.spaces.map((item) => {
                      const dots = workspace.dots.filter((dot) =>
                        dot.spaceIds?.includes(item.id),
                      ).length;
                      const pages = item.pageCount ?? 0;
                      return (
                        <div className="ws-space" key={item.id}>
                          <div className="ws-main">
                            <span className="ws-name">{item.name}</span>
                            <span className="ws-meta">
                              <span>
                                {pages} page{pages > 1 ? 's' : ''}
                              </span>
                              <span>
                                {dots} Dot{dots > 1 ? 's' : ''}
                              </span>
                              {item.description && (
                                <span className="ws-desc">
                                  {item.description}
                                </span>
                              )}
                            </span>
                          </div>
                          <div className="ws-actions">
                            <button
                              type="button"
                              className="text-button"
                              onClick={() =>
                                onOpenDialog({ type: 'space', space: item })
                              }
                            >
                              Modifier
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
                {dialog.type === 'settings' &&
                  settingsTab === 'connections' && (
                    <div className="settings-connections">
                      <ExternalAccountsSection />
                      {workspace.dots.length > 1 && (
                        <>
                          <label
                            className="field-label"
                            htmlFor="connection-dot"
                          >
                            Dot
                          </label>
                          <select
                            id="connection-dot"
                            value={connectionDot}
                            onChange={(e) => setConnectionDot(e.target.value)}
                          >
                            {workspace.dots.map((item) => (
                              <option key={item.id} value={item.id}>
                                {item.name}
                              </option>
                            ))}
                          </select>
                        </>
                      )}
                      {connectionDot ? (
                        <ConnectionsSection dotId={connectionDot} />
                      ) : (
                        <p className="muted">
                          Créez un Dot pour gérer des services MCP.
                        </p>
                      )}
                    </div>
                  )}
                {dialog.type === 'settings' && settingsTab === 'health' && (
                  <div className="config-note">
                    <strong>État du service</strong>
                    <ul className="settings-flags">
                      <li>Transcriptions : locales (auto-hébergées)</li>
                      <li>
                        Modèle :{' '}
                        {workspace.setup.model ? 'configuré' : 'absent'}
                      </li>
                      <li>
                        Navigateur :{' '}
                        {workspace.setup.browser ? 'actif' : 'inactif'}
                      </li>
                      <li>
                        Voix :{' '}
                        {workspace.setup.voice ? 'configurée' : 'à configurer'}
                      </li>
                      <li>
                        Slack : {workspace.setup.slack.replaceAll('_', ' ')}
                      </li>
                    </ul>
                    {metrics && (
                      <p>
                        Hôte · CPU {Math.round(metrics.cpu ?? 0)}% · RAM{' '}
                        {Math.round(metrics.mem ?? 0)}% · Disque{' '}
                        {Math.round(metrics.disk ?? 0)}% · en service depuis{' '}
                        {Math.floor(metrics.uptime / 3600)} h
                      </p>
                    )}
                    <p>
                      {workspace.setup.missing.length ? (
                        <>
                          À ajouter dans <code>.env</code> puis redémarrer :{' '}
                          {workspace.setup.missing.map((name, index) => (
                            <span key={name}>
                              {index > 0 && ', '}
                              <code>{name}</code>
                            </span>
                          ))}
                        </>
                      ) : (
                        'Configuration présente.'
                      )}
                    </p>
                  </div>
                )}
                {dialog.type === 'settings' && settingsTab === 'about' && (
                  <div className="config-note">
                    <strong>NevaDots v0.1.0</strong>
                    <p>
                      Assistant personnel auto-hébergé (Dots, Spaces, Computers,
                      Intelligence). Fork d’OpenDots (CopilotKit), interface
                      inspirée de Cetas Lite.
                    </p>
                    <p>
                      Données stockées localement dans le conteneur. Thème,
                      palettes et préférences restent dans ce navigateur.
                    </p>
                    <a
                      href="https://github.com/CopilotKit/OpenDots"
                      target="_blank"
                      rel="noreferrer"
                    >
                      OpenDots (projet amont) ↗
                    </a>
                  </div>
                )}
                {dialog.type === 'settings' &&
                  settingsTab === 'accounts' &&
                  myRole === 'admin' && <AccountsPanel />}
              </div>
            </div>
          )}
          {dialog.type === 'memory' && (
            <p className="muted">
              Memories are explicit preferences, not automatic learning. Avoid
              secrets; enabled memories go to your model provider.
            </p>
          )}
          {error && (
            <p className="chat-error" role="alert">
              {error}
            </p>
          )}
          {dialog.type === 'settings' ? (
            settingsTab === 'preferences' && (
              <button className="primary full settings-save" disabled={busy}>
                {busy ? 'Saving…' : 'Enregistrer'}
              </button>
            )
          ) : (
            <button className="primary full" disabled={busy}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          )}
        </form>
      </section>
    </div>
  );
}
