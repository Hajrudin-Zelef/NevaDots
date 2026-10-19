import { useThreads } from '@copilotkit/react-core/v2';
import { MessageCircle, Trash2 } from 'lucide-react';
import type { Conversation, Dot } from '../shared/types';
export function ThreadList({
  dots,
  dotId,
  local,
  selected,
  category,
  search,
  onSelect,
  onDelete,
}: {
  dots: Dot[];
  dotId: string;
  local: Conversation[];
  selected?: string;
  category: string;
  search: string;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const threads = useThreads({
    agentId: dotId,
    enabled: true,
    includeArchived: false,
    limit: 20,
  });
  const filtered = local
    .filter((thread) => category === 'all' || thread.dotId === category)
    .filter((thread) => {
      const dotName = dots.find((dot) => dot.id === thread.dotId)?.name ?? '';
      return `${thread.title} ${dotName}`
        .toLocaleLowerCase()
        .includes(search.toLocaleLowerCase());
    })
    .sort((a, b) => b.createdAt - a.createdAt);
  // Phase D : la maître (1ère requête du compte) est épinglée en tête,
  // les autres conversations sont des parallèles.
  const master = filtered.find((thread) => thread.isMaster);
  const parallels = filtered.filter((thread) => !thread.isMaster);
  const groups = new Map<string, Conversation[]>();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const monthAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  for (const thread of parallels) {
    const created = new Date(thread.createdAt);
    const label =
      created >= today
        ? "Aujourd'hui"
        : thread.createdAt >= weekAgo
          ? '7 derniers jours'
          : thread.createdAt >= monthAgo
            ? '30 derniers jours'
            : created.toLocaleDateString('fr-FR', {
                month: 'long',
                year: 'numeric',
              });
    groups.set(label, [...(groups.get(label) ?? []), thread]);
  }
  const renderRow = (thread: Conversation) => {
    const remote = threads.threads.find((item) => item.id === thread.id);
    return (
      <div className="thread-row" key={thread.id}>
        <button
          className={`nav-item ${selected === thread.id ? 'active' : ''}`}
          onClick={() => onSelect(thread.id)}
          title={remote?.name || thread.title}
        >
          <MessageCircle size={15} />
          <span className="thread-summary">
            <span>{remote?.name || thread.title}</span>
            <small>{dots.find((dot) => dot.id === thread.dotId)?.name}</small>
          </span>
        </button>
        <button
          className="icon-button thread-delete"
          aria-label={`Supprimer la conversation ${thread.title}`}
          title="Supprimer la conversation"
          onClick={(event) => {
            event.stopPropagation();
            onDelete(thread.id);
          }}
        >
          <Trash2 size={14} />
        </button>
      </div>
    );
  };
  return (
    <section className="thread-list">
      {threads.error && (
        <p className="sidebar-error">
          Synchronisation indisponible. Vérifiez la connexion au runtime.
        </p>
      )}
      {master && (
        <div className="thread-group">
          <h3 className="thread-group-title">Discussion principale</h3>
          {renderRow(master)}
        </div>
      )}
      {parallels.length > 0 && (
        <h3 className="thread-group-title">Discussions parallèles</h3>
      )}
      {[...groups].map(([label, conversations]) => (
        <div className="thread-group" key={label}>
          <h3 className="thread-group-title">{label}</h3>
          {conversations.map((thread) => renderRow(thread))}
        </div>
      ))}
      {!filtered.length && (
        <p className="sidebar-empty">
          {local.length
            ? 'Aucune conversation ne correspond à la recherche.'
            : 'Vos conversations apparaîtront ici.'}
        </p>
      )}
      {threads.hasMoreThreads && category === 'all' && !search && (
        <button
          className="text-button"
          disabled={threads.isFetchingMoreThreads}
          onClick={() => void threads.fetchMoreThreads()}
        >
          Charger plus de conversations
        </button>
      )}
    </section>
  );
}
