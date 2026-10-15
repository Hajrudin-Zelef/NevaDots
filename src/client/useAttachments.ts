import { useRef, useState } from 'react';
import { api } from './api';
import type { Attachment } from './attachments';

interface ServerAttachment {
  id: string;
  name: string;
  size: number;
  mime: string;
  category: Attachment['category'];
}

/**
 * Gère les fichiers joints du composer : sélection locale, cartes,
 * upload vers le serveur à l'envoi, retrait.
 */
export function useAttachments() {
  const [items, setItemsState] = useState<Attachment[]>([]);
  const itemsRef = useRef<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');

  const setItems = (
    next: Attachment[] | ((cur: Attachment[]) => Attachment[]),
  ) => {
    const value = typeof next === 'function' ? next(itemsRef.current) : next;
    itemsRef.current = value;
    setItemsState(value);
  };

  const addFiles = (files: FileList | File[]) => {
    const list = Array.from(files);
    if (!list.length) return;
    setItems((current) => {
      const next = [...current];
      for (const file of list) {
        // Évite les doublons (même nom + même taille).
        if (next.some((a) => a.name === file.name && a.size === file.size))
          continue;
        const id = `local-${crypto.randomUUID()}`;
        const attachment: Attachment = {
          id,
          name: file.name,
          size: file.size,
          mime: file.type || 'application/octet-stream',
          category: guessCategory(file),
        };
        // Miniature locale immédiate pour les images.
        if (attachment.category === 'image') {
          attachment.objectUrl = URL.createObjectURL(file);
        }
        // Lecture texte immédiate pour text/code (injection au modèle).
        if (attachment.category === 'text' || attachment.category === 'code') {
          void file
            .text()
            .then((text) =>
              setItems((cur) =>
                cur.map((a) => (a.id === id ? { ...a, textContent: text } : a)),
              ),
            )
            .catch(() => {});
        }
        // Garde le File d'origine pour l'upload.
        (attachment as { file?: File }).file = file;
        next.push(attachment);
      }
      return next;
    });
  };

  const remove = (id: string) => {
    setItems((current) => {
      const target = current.find((a) => a.id === id);
      if (target?.objectUrl) URL.revokeObjectURL(target.objectUrl);
      // Supprime aussi côté serveur si déjà uploadé (id non local).
      if (target && !target.id.startsWith('local-')) {
        void api(
          `/attachments/${encodeURIComponent(target.id)}`,
          'DELETE',
          {},
        ).catch(() => {});
      }
      return current.filter((a) => a.id !== id);
    });
  };

  const clear = () => {
    setItems((current) => {
      for (const a of current) {
        if (a.objectUrl) URL.revokeObjectURL(a.objectUrl);
      }
      return [];
    });
  };

  /**
   * Upload les fichiers locaux vers le serveur.
   * Retourne les pièces jointes avec leurs ids serveur.
   */
  const uploadAll = async (): Promise<Attachment[]> => {
    // Capture l'état actuel de façon synchrone via un ref miroir.
    const snapshot = itemsRef.current;
    const pending = snapshot.filter((a) => a.id.startsWith('local-'));
    if (!pending.length) return snapshot;
    setUploading(true);
    setError('');
    try {
      const form = new FormData();
      for (const a of pending) {
        const file = (a as { file?: File }).file;
        if (file) form.append('files', file, a.name);
      }
      const result = await api<{ attachments: ServerAttachment[] }>(
        '/attachments',
        'POST',
        form,
      );
      const byName = new Map(result.attachments.map((s) => [s.name, s]));
      const updated = snapshot.map((a) => {
        const server = byName.get(a.name);
        if (!server || !a.id.startsWith('local-')) return a;
        if (a.objectUrl) URL.revokeObjectURL(a.objectUrl);
        const {
          file: _omit,
          objectUrl: _omitUrl,
          ...rest
        } = a as Attachment & {
          file?: File;
        };
        void _omit;
        void _omitUrl;
        return {
          ...rest,
          id: server.id,
          mime: server.mime,
          category: server.category,
        };
      });
      setItems(updated);
      itemsRef.current = updated;
      return updated;
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Échec de l'envoi des fichiers.",
      );
      throw cause;
    } finally {
      setUploading(false);
    }
  };

  return { items, addFiles, remove, clear, uploadAll, uploading, error };
}

function guessCategory(file: File): Attachment['category'] {
  const mime = file.type || '';
  const name = file.name.toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime === 'application/pdf' || name.endsWith('.pdf')) return 'pdf';
  const ext = name.split('.').pop() ?? '';
  const codeExts = new Set([
    'js',
    'jsx',
    'ts',
    'tsx',
    'mjs',
    'cjs',
    'py',
    'rb',
    'go',
    'rs',
    'java',
    'kt',
    'c',
    'h',
    'cpp',
    'hpp',
    'cs',
    'php',
    'swift',
    'sh',
    'sql',
    'html',
    'css',
    'scss',
    'json',
    'yaml',
    'yml',
    'toml',
    'xml',
    'md',
    'vue',
    'svelte',
  ]);
  if (codeExts.has(ext)) return 'code';
  if (mime.startsWith('text/')) return 'text';
  return 'other';
}
