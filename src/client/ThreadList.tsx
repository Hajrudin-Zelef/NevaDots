import { useThreads } from '@copilotkit/react-core/v2';
import { MessageCircle, Plus, Trash2 } from 'lucide-react';
import type { Conversation, Dot } from '../shared/types';
export function ThreadList({
  dots,
  dotId,
  local,
  selected,
  onSelect,
  onNew,
  onDelete,
  onDeleteAll,
}: {
  dots: Dot[];
  dotId: string;
  local: Conversation[];
  selected?: string;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onDeleteAll: () => void;
}) {
  const threads = useThreads({
    agentId: dotId,
    enabled: true,
    includeArchived: false,
    limit: 20,
  });
  return (
    <section className="thread-list">
      <div className="nav-label">
        RECENT CHATS
        <span className="nav-label-actions">
          {local.length > 0 && (
            <button
              className="icon-button"
              onClick={onDeleteAll}
              aria-label="Delete all conversations"
              title="Delete all conversations"
            >
              <Trash2 size={14} />
            </button>
          )}
          <button
            className="icon-button"
            onClick={onNew}
            aria-label="New conversation"
          >
            <Plus size={14} />
          </button>
        </span>
      </div>
      {threads.error && (
        <p className="sidebar-error">
          Conversation sync unavailable. Check your runtime connection.
        </p>
      )}
      {local.map((thread) => {
        const remote = threads.threads.find((item) => item.id === thread.id);
        return (
          <div className="thread-row" key={thread.id}>
            <button
              className={`nav-item ${selected === thread.id ? 'active' : ''}`}
              onClick={() => onSelect(thread.id)}
            >
              <MessageCircle size={15} />
              <span className="thread-summary">
                <span>{remote?.name || thread.title}</span>
                <small>{dots.find((dot) => dot.id === thread.dotId)?.name}</small>
              </span>
            </button>
            <button
              className="icon-button thread-delete"
              aria-label={`Delete conversation ${thread.title}`}
              title="Delete conversation"
              onClick={(event) => {
                event.stopPropagation();
                onDelete(thread.id);
              }}
            >
              <Trash2 size={14} />
            </button>
          </div>
        );
      })}
      {!local.length && (
        <p className="sidebar-empty">Your first conversation will live here.</p>
      )}
      {threads.hasMoreThreads && (
        <button
          className="text-button"
          disabled={threads.isFetchingMoreThreads}
          onClick={() => void threads.fetchMoreThreads()}
        >
          Load more conversations
        </button>
      )}
    </section>
  );
}
