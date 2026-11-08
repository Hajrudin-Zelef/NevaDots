import { useCallback, useEffect, useState } from 'react';
import { ThumbsDown, ThumbsUp, Trash2 } from 'lucide-react';
import { api } from './api';
import type { Feedback } from '../shared/types';

/** Volet Réglages → Feedback (Admin) : les votes + commentaires « je n'aime
 *  pas » laissés sous les réponses, pour corriger ce qui coince. */
export function FeedbackPanel() {
  const [items, setItems] = useState<Feedback[] | null>(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<'all' | 'negatif'>('all');
  const [deleting, setDeleting] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError('');
    try {
      const data = await api<{ feedback: Feedback[] }>(
        `/feedback?filter=${filter}&limit=200`,
      );
      setItems(data.feedback);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Chargement impossible.');
    }
  }, [filter]);

  useEffect(() => {
    void load();
  }, [load]);

  const remove = async (id: string) => {
    if (!window.confirm('Supprimer ce retour ?')) return;
    setDeleting(id);
    try {
      await api(`/feedback/${encodeURIComponent(id)}`, 'DELETE');
      setItems((current) => current?.filter((item) => item.id !== id) ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Suppression impossible.');
    } finally {
      setDeleting(null);
    }
  };

  return (
    <div className="feedback-panel">
      <div className="segmented" role="tablist" aria-label="Filtre des retours">
        {(
          [
            ['all', 'Tous'],
            ['negatif', 'Négatifs'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={filter === value}
            className={filter === value ? 'active' : ''}
            onClick={() => setFilter(value)}
          >
            {label}
          </button>
        ))}
        <button
          type="button"
          className="text-button"
          onClick={() => void load()}
        >
          Actualiser
        </button>
      </div>
      {error && (
        <p className="chat-error" role="alert">
          {error}
        </p>
      )}
      {items === null && !error && <p className="muted">Chargement…</p>}
      {items !== null && items.length === 0 && (
        <p className="muted">
          Aucun retour pour ce filtre. Les votes sous les réponses apparaîtront
          ici.
        </p>
      )}
      {items !== null && items.length > 0 && (
        <ul className="feedback-list">
          {items.map((item) => (
            <li
              key={item.id}
              className={`feedback-item ${item.vote === 1 ? 'positive' : 'negative'}`}
            >
              <span
                className="feedback-vote"
                aria-label={item.vote === 1 ? 'J’aime' : 'Je n’aime pas'}
                title={item.vote === 1 ? 'J’aime' : 'Je n’aime pas'}
              >
                {item.vote === 1 ? (
                  <ThumbsUp size={14} />
                ) : (
                  <ThumbsDown size={14} />
                )}
              </span>
              <div className="feedback-body">
                <div className="feedback-meta">
                  <span>
                    {new Date(item.ts).toLocaleString('fr-FR', {
                      day: '2-digit',
                      month: '2-digit',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                  {item.username && <span>{item.username}</span>}
                  {item.model && <span>{item.model}</span>}
                </div>
                {item.comment ? (
                  <p className="feedback-comment">{item.comment}</p>
                ) : (
                  <p className="muted">(sans commentaire)</p>
                )}
              </div>
              <button
                type="button"
                className="icon-button"
                aria-label="Supprimer ce retour"
                title="Supprimer"
                disabled={deleting === item.id}
                onClick={() => void remove(item.id)}
              >
                <Trash2 size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
