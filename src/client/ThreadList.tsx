import { useEffect, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import type { Conversation, Dot } from '../shared/types';
import {
  MAX_DISPLAYED_SESSIONS,
  groupSessions,
  sortSessions,
} from './session-groups';
import { dotAvatarStyle } from './dot-color';
import { isUnread, type SeenMap } from './read-state';

/**
 * Liste des sessions de la sidebar (Lot 2 du portage visuel OpenCode).
 *
 * - Tri `updatedAt ?? createdAt` décroissant, groupes Aujourd'hui / Hier /
 *   Plus anciennes, 64 lignes max, maître (« Discussion principale »)
 *   épinglée au-dessus.
 * - Ligne 40 px : avatar 16 px (initiale du Dot, couleur par Dot), nom du
 *   Dot visible, barre de sélection 2 px (CSS), point non-lu 7 px (CSS).
 * - Clic = aperçu éphémère (`preview`), double-clic = conserver l'onglet.
 * - Menu contextuel (clic droit, Maj+F10, appui long 500 ms / 8 px) :
 *   Renommer / Exporter / Marquer lu / Supprimer.
 * - Renommage inline (Entrée / Échap / blur, trim, no-op si inchangé,
 *   retour en édition avec le brouillon en cas d'échec).
 * - Recherche en tête de liste, navigation clavier (flèches avec bouclage,
 *   Entrée, Échap), lookup par ID local (l'ID fait partie du filtre).
 *
 * La liste est 100 % locale (`workspace.conversations`, déjà en mémoire) :
 * le hook CopilotKit `useThreads` a été retiré — son seul usage était
 * `remote.name`, et le runtime local renvoie toujours `name: null`
 * (`InMemoryAgentRunner.listThreads` le code en dur ; `SqliteAgentRunner`
 * réutilise le même store). Le titre local est donc la seule source
 * affichée, et un renommage local est toujours visible.
 */

const MENU_ITEMS = ['rename', 'export', 'mark-read', 'delete'] as const;
type MenuItem = (typeof MENU_ITEMS)[number];

const MENU_LABELS: Record<MenuItem, string> = {
  rename: 'Renommer',
  export: 'Exporter',
  'mark-read': 'Marquer lu',
  delete: 'Supprimer',
};

const LONG_PRESS_MS = 500;
const LONG_PRESS_MOVE_PX = 8;

export function ThreadList({
  dots,
  local,
  selected,
  previewThreadId,
  seen,
  category,
  search,
  onSearchChange,
  onSelect,
  onKeepPreview,
  onRename,
  onExport,
  onMarkRead,
  onDelete,
}: {
  dots: Dot[];
  local: Conversation[];
  selected?: string;
  previewThreadId?: string;
  seen: SeenMap;
  category: string;
  search: string;
  onSearchChange: (value: string) => void;
  onSelect: (id: string) => void;
  onKeepPreview: (id: string) => void;
  /** Renomme ; résout `true` si le serveur a confirmé, `false` sinon. */
  onRename: (id: string, title: string) => Promise<boolean>;
  onExport: (id: string) => void;
  onMarkRead: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const query = search.trim().toLocaleLowerCase();
  const filtered = sortSessions(
    local
      .filter((thread) => category === 'all' || thread.dotId === category)
      .filter((thread) => {
        if (!query) return true;
        const dotName = dots.find((dot) => dot.id === thread.dotId)?.name ?? '';
        return `${thread.title} ${dotName} ${thread.id}`
          .toLocaleLowerCase()
          .includes(query);
      }),
  );
  // Phase D : la maître (1ère requête du compte) est épinglée en tête,
  // les autres conversations sont des parallèles.
  const master = filtered.find((thread) => thread.isMaster);
  const parallels = filtered.filter((thread) => !thread.isMaster);
  const groups = groupSessions(parallels);
  // Lignes affichées, dans l'ordre, capées à 64 (maître incluse).
  const flat: Conversation[] = [
    ...(master ? [master] : []),
    ...groups.flatMap((group) => group.items),
  ].slice(0, MAX_DISPLAYED_SESSIONS);
  const shownMaster = master && flat.includes(master) ? master : undefined;
  const shownParallels = flat.filter((thread) => !thread.isMaster);
  const shownGroups = groupSessions(shownParallels);

  // --- Navigation clavier (flèches avec bouclage, Entrée, Échap) ---
  const [focusIndex, setFocusIndex] = useState(0);
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);
  useEffect(() => {
    if (focusIndex >= flat.length) setFocusIndex(Math.max(0, flat.length - 1));
  }, [flat.length, focusIndex]);
  const focusRow = (index: number) => {
    if (flat.length === 0) return;
    const wrapped = ((index % flat.length) + flat.length) % flat.length;
    setFocusIndex(wrapped);
    rowRefs.current[wrapped]?.focus();
  };
  const onListKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusRow(focusIndex + 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      focusRow(focusIndex - 1);
    } else if (event.key === 'Enter') {
      // Entrée sur un bouton : le clic natif ouvre déjà la ligne —
      // ne pas rouvrir ici (double `openTab`).
      if ((event.target as HTMLElement).tagName === 'BUTTON') return;
      const thread = flat[focusIndex];
      if (thread) {
        event.preventDefault();
        onSelect(thread.id);
      }
    } else if (event.key === 'Escape') {
      if (menu) return;
      if (search) {
        event.preventDefault();
        onSearchChange('');
      }
    }
  };

  // --- Menu contextuel ---
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(
    null,
  );
  const [menuFocus, setMenuFocus] = useState(0);
  const menuRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const longPressAtRef = useRef(0);
  const openMenu = (id: string, x: number, y: number) => {
    setMenu({
      id,
      x: Math.max(4, Math.min(x, window.innerWidth - 216)),
      y: Math.max(4, Math.min(y, window.innerHeight - 184)),
    });
    setMenuFocus(0);
  };
  const closeMenu = () => setMenu(null);
  useEffect(() => {
    if (!menu) return;
    menuRefs.current[0]?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeMenu();
      }
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [menu]);
  const onMenuKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      const next = (menuFocus + 1) % MENU_ITEMS.length;
      setMenuFocus(next);
      menuRefs.current[next]?.focus();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      const next = (menuFocus - 1 + MENU_ITEMS.length) % MENU_ITEMS.length;
      setMenuFocus(next);
      menuRefs.current[next]?.focus();
    }
  };
  // Appui long (500 ms, tolérance de déplacement 8 px) — tactile.
  const longPressTimer = useRef<number | undefined>(undefined);
  const longPressStart = useRef<{ x: number; y: number } | null>(null);
  const cancelLongPress = () => {
    window.clearTimeout(longPressTimer.current);
    longPressTimer.current = undefined;
    longPressStart.current = null;
  };
  const startLongPress = (id: string, event: React.PointerEvent) => {
    if (event.pointerType === 'mouse') return;
    longPressStart.current = { x: event.clientX, y: event.clientY };
    longPressTimer.current = window.setTimeout(() => {
      longPressAtRef.current = Date.now();
      openMenu(id, event.clientX, event.clientY);
      longPressStart.current = null;
    }, LONG_PRESS_MS);
  };
  const moveLongPress = (event: React.PointerEvent) => {
    const start = longPressStart.current;
    if (!start) return;
    if (
      Math.abs(event.clientX - start.x) > LONG_PRESS_MOVE_PX ||
      Math.abs(event.clientY - start.y) > LONG_PRESS_MOVE_PX
    )
      cancelLongPress();
  };
  const menuThread = menu
    ? local.find((thread) => thread.id === menu.id)
    : undefined;
  const menuUnread = menuThread ? isUnread(menuThread, seen) : false;
  const runMenuItem = (item: MenuItem) => {
    if (!menu) return;
    const id = menu.id;
    closeMenu();
    if (item === 'rename') {
      const thread = local.find((candidate) => candidate.id === id);
      if (thread) setEditing({ id, draft: thread.title });
    } else if (item === 'export') onExport(id);
    else if (item === 'mark-read') onMarkRead(id);
    else if (item === 'delete') onDelete(id);
  };

  // --- Renommage inline ---
  const [editing, setEditing] = useState<{ id: string; draft: string } | null>(
    null,
  );
  const [renaming, setRenaming] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const skipBlurCommit = useRef(false);
  useEffect(() => {
    if (editing) renameInputRef.current?.select();
  }, [editing]);
  const commitRename = async () => {
    if (!editing || renaming) return;
    const current = local.find((thread) => thread.id === editing.id);
    const title = editing.draft.trim();
    if (!title || title === current?.title) {
      setEditing(null);
      setRenameError(null);
      return;
    }
    setRenaming(true);
    setRenameError(null);
    const ok = await onRename(editing.id, title);
    setRenaming(false);
    if (ok) {
      setEditing(null);
      setRenameError(null);
    } else {
      // Échec : retour en édition, brouillon conservé.
      setRenameError('Impossible de renommer. Réessayez.');
      renameInputRef.current?.focus();
    }
  };
  const cancelRename = () => {
    skipBlurCommit.current = true;
    setEditing(null);
    setRenameError(null);
  };

  const renderRow = (thread: Conversation, index: number) => {
    const dot = dots.find((candidate) => candidate.id === thread.dotId);
    const dotName = dot?.name ?? '';
    const unread = isUnread(thread, seen);
    const isPreview = previewThreadId === thread.id;
    if (editing?.id === thread.id) {
      return (
        <div className="thread-row" key={thread.id}>
          <div className="thread-rename">
            <input
              ref={renameInputRef}
              aria-label="Renommer la conversation"
              value={editing.draft}
              disabled={renaming}
              maxLength={120}
              onChange={(event) => {
                setEditing({ id: thread.id, draft: event.target.value });
                setRenameError(null);
              }}
              onKeyDown={(event) => {
                // Les flèches / Entrée / Échap de l'édition ne doivent pas
                // atteindre la navigation de la liste (section).
                event.stopPropagation();
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void commitRename();
                } else if (event.key === 'Escape') {
                  event.preventDefault();
                  cancelRename();
                }
              }}
              onBlur={() => {
                if (skipBlurCommit.current) {
                  skipBlurCommit.current = false;
                  return;
                }
                void commitRename();
              }}
            />
            {renameError && (
              <span className="thread-rename-error" role="alert">
                {renameError}
              </span>
            )}
          </div>
        </div>
      );
    }
    return (
      <div className="thread-row" key={thread.id}>
        <button
          ref={(element) => {
            rowRefs.current[index] = element;
          }}
          type="button"
          tabIndex={index === focusIndex ? 0 : -1}
          className={`nav-item thread-row-button ${selected === thread.id ? 'active' : ''} ${isPreview ? 'preview' : ''}`}
          aria-current={selected === thread.id ? 'true' : undefined}
          onClick={() => {
            // Clic qui suit un appui long : il ne servait qu'à ouvrir le
            // menu, pas à ouvrir la conversation.
            if (Date.now() - longPressAtRef.current < 350) return;
            onSelect(thread.id);
          }}
          onDoubleClick={() => onKeepPreview(thread.id)}
          onFocus={() => setFocusIndex(index)}
          onContextMenu={(event) => {
            event.preventDefault();
            openMenu(thread.id, event.clientX, event.clientY);
          }}
          onKeyDown={(event) => {
            if (event.shiftKey && event.key === 'F10') {
              event.preventDefault();
              const rect = event.currentTarget.getBoundingClientRect();
              openMenu(thread.id, rect.left + 40, rect.bottom + 4);
            }
          }}
          onPointerDown={(event) => startLongPress(thread.id, event)}
          onPointerMove={moveLongPress}
          onPointerUp={cancelLongPress}
          onPointerCancel={cancelLongPress}
          title={`${thread.title}${isPreview ? ' (aperçu — double-clic pour conserver)' : ''}`}
        >
          <span
            className="thread-avatar"
            style={dotAvatarStyle(thread.dotId)}
            aria-hidden="true"
          >
            {(dotName.trim().charAt(0) || '•').toUpperCase()}
          </span>
          <span className="thread-summary">
            <span className="thread-title">{thread.title}</span>
            <small>{dotName}</small>
          </span>
          {unread && (
            <span
              className="thread-unread"
              aria-label="Non lue"
              title="Non lue"
            />
          )}
        </button>
      </div>
    );
  };

  return (
    <section className="thread-list" onKeyDown={onListKeyDown}>
      <label className="conversation-search thread-search">
        <Search size={15} />
        <input
          aria-label="Rechercher une conversation"
          placeholder="Rechercher…"
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          onKeyDown={(event) => {
            // Flèches / Entrée / Échap : la navigation vit sur la liste
            // (section) ; ici on ne laisse passer que la saisie.
            if (
              event.key === 'ArrowDown' ||
              event.key === 'ArrowUp' ||
              event.key === 'Enter'
            ) {
              event.preventDefault();
              event.stopPropagation();
              focusRow(event.key === 'ArrowUp' ? flat.length - 1 : 0);
            }
          }}
        />
        {search && (
          <button
            type="button"
            className="icon-button thread-search-clear"
            aria-label="Effacer la recherche"
            onClick={() => onSearchChange('')}
          >
            <X size={14} />
          </button>
        )}
      </label>
      {search && (
        <p className="thread-search-count" role="status">
          {flat.length === 0
            ? 'Aucun résultat.'
            : `${flat.length} résultat${flat.length > 1 ? 's' : ''}.`}
        </p>
      )}
      {shownMaster && (
        <div className="thread-group">
          <h3 className="thread-group-title">Discussion principale</h3>
          {renderRow(shownMaster, flat.indexOf(shownMaster))}
        </div>
      )}
      {shownGroups.map((group) => (
        <div className="thread-group" key={group.label}>
          <h3 className="thread-group-title">{group.label}</h3>
          {group.items.map((thread) => renderRow(thread, flat.indexOf(thread)))}
        </div>
      ))}
      {!flat.length && (
        <p className="sidebar-empty">
          {local.length
            ? 'Aucune conversation ne correspond à la recherche.'
            : 'Vos conversations apparaîtront ici.'}
        </p>
      )}
      {menu && (
        <>
          <div
            className="thread-menu-backdrop"
            onClick={closeMenu}
            onContextMenu={(event) => {
              event.preventDefault();
              closeMenu();
            }}
          />
          <div
            className="thread-menu"
            role="menu"
            aria-label={`Actions pour ${menuThread?.title ?? 'cette conversation'}`}
            style={{ left: menu.x, top: menu.y }}
            onKeyDown={(event) => {
              // Les flèches du menu ne doivent pas déplacer le focus
              // des lignes (navigation de la section).
              event.stopPropagation();
              onMenuKeyDown(event);
            }}
          >
            {MENU_ITEMS.map((item, itemIndex) => (
              <button
                key={item}
                ref={(element) => {
                  menuRefs.current[itemIndex] = element;
                }}
                type="button"
                role="menuitem"
                className={`thread-menu-item ${item === 'delete' ? 'danger' : ''}`}
                disabled={item === 'mark-read' && !menuUnread}
                onClick={() => runMenuItem(item)}
                onFocus={() => setMenuFocus(itemIndex)}
              >
                {MENU_LABELS[item]}
              </button>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
