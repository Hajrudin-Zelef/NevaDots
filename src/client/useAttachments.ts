import { useEffect, useRef, useState } from 'react';
import { api, authHeaders, ApiError } from './api';
import {
  buildMessageWithAttachments,
  clearPendingAttachments,
  loadPendingAttachments,
  savePendingAttachments,
  type Attachment,
  type AttachmentCategory,
} from './attachments';

interface ServerAttachment {
  id: string;
  name: string;
  size: number;
  mime: string;
  category: AttachmentCategory;
}

/**
 * Upload multipart brut.
 * Le helper api() force Content-Type: application/json et JSON.stringify()
 * le FormData — il est inutilisable pour l'upload de fichiers.
 */
async function uploadFiles(
  entries: { file: File; name: string }[],
): Promise<ServerAttachment[]> {
  const form = new FormData();
  for (const { file, name } of entries) form.append('files', file, name);
  const response = await fetch('/api/attachments', {
    method: 'POST',
    headers: { ...authHeaders() },
    body: form,
  });
  const data = (await response.json().catch(() => ({}))) as {
    attachments?: ServerAttachment[];
    error?: string;
  };
  if (!response.ok) {
    throw new ApiError(
      data.error ?? `Échec de l'envoi des fichiers (${response.status}).`,
      response.status,
    );
  }
  return data.attachments ?? [];
}

/**
 * Attente d'upload avant envoi : 500 ms × 120 rondes = 60 s max. Passé ce
 * délai, prepareSend lève (brouillon conservé) au lieu d'exclure en silence.
 */
const UPLOAD_WAIT_MS = 500;
const UPLOAD_WAIT_ROUNDS = 120;

/**
 * Gère les pièces jointes du composer.
 *
 * Phase 2a : upload immédiat en arrière-plan dès la sélection (un POST par
 * fichier, état par carte), persistance des IDs serveur en localStorage
 * (restauration au rechargement), marquage "rattaché" à l'envoi pour exclure
 * les fichiers du nettoyage des orphelins côté serveur.
 *
 * @param scope clé d'isolation du brouillon (ex. `home:<dotId>`, `thread:<id>`).
 */
export function useAttachments(scope: string) {
  const [items, setItemsState] = useState<Attachment[]>([]);
  const itemsRef = useRef<Attachment[]>([]);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const [restoring, setRestoring] = useState(true);

  const setItems = (
    next: Attachment[] | ((cur: Attachment[]) => Attachment[]),
  ) => {
    const value = typeof next === 'function' ? next(itemsRef.current) : next;
    itemsRef.current = value;
    setItemsState(value);
  };

  // Persistance : seuls les fichiers prêts (ID serveur) sont conservés.
  useEffect(() => {
    savePendingAttachments(scope, items);
  }, [scope, items]);

  // Restauration au montage / changement de contexte.
  useEffect(() => {
    let cancelled = false;
    setRestoring(true);
    void (async () => {
      const stored = loadPendingAttachments(scope);
      const revived: Attachment[] = [];
      for (const entry of stored) {
        try {
          const meta = await api<ServerAttachment>(
            `/attachments/${encodeURIComponent(entry.id)}`,
            'GET',
          );
          const attachment: Attachment = {
            id: meta.id,
            name: meta.name,
            size: meta.size,
            mime: meta.mime,
            category: meta.category,
            status: 'ready',
            textContent: entry.textContent,
          };
          // Réhydrate le contenu texte depuis le serveur si absent du cache.
          if (
            (meta.category === 'text' || meta.category === 'code') &&
            !attachment.textContent
          ) {
            try {
              const preview = await api<{ content: string }>(
                `/attachments/${encodeURIComponent(meta.id)}/text`,
                'GET',
              );
              attachment.textContent = preview.content;
            } catch {
              // Aperçu indisponible : la carte reste, sans contenu injecté.
            }
          }
          revived.push(attachment);
        } catch {
          // ID mort (nettoyé par le sweep serveur) : abandonné silencieusement.
        }
      }
      if (!cancelled) {
        itemsRef.current = revived;
        setItemsState(revived);
        setRestoring(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [scope]);

  /** Bascule une carte `local-` vers son ID serveur (upload réussi). */
  const finalizeUpload = (localId: string, server: ServerAttachment) => {
    setItems((cur) =>
      cur.map((a) => {
        if (a.id !== localId) return a;
        if (a.objectUrl) URL.revokeObjectURL(a.objectUrl);
        const {
          file: _file,
          objectUrl: _url,
          ...rest
        } = a as Attachment & {
          file?: File;
        };
        void _file;
        void _url;
        return {
          ...rest,
          id: server.id,
          mime: server.mime,
          category: server.category,
          status: 'ready' as const,
        };
      }),
    );
  };

  const failUpload = (localId: string) => {
    setItems((cur) =>
      cur.map((a) =>
        a.id === localId ? { ...a, status: 'error' as const } : a,
      ),
    );
  };

  const uploadOne = (localId: string, file: File, name: string) => {
    void uploadFiles([{ file, name }])
      .then((servers) => {
        const server = servers[0];
        if (!server) throw new Error('Réponse serveur vide.');
        finalizeUpload(localId, server);
      })
      .catch(() => failUpload(localId));
  };

  const addFiles = (files: FileList | File[]) => {
    const candidates = Array.from(files).filter(
      (file) =>
        !itemsRef.current.some(
          (a) => a.name === file.name && a.size === file.size,
        ),
    );
    if (!candidates.length) return;
    const fresh = candidates.map((file) => {
      const id = `local-${crypto.randomUUID()}`;
      const attachment: Attachment = {
        id,
        name: file.name,
        size: file.size,
        mime: file.type || 'application/octet-stream',
        category: guessCategory(file),
        status: 'uploading',
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
      // Garde le File d'origine pour l'upload immédiat et un éventuel réessai.
      (attachment as { file?: File }).file = file;
      return { id, file, attachment };
    });
    setItems((cur) => [...cur, ...fresh.map((f) => f.attachment)]);
    // Upload immédiat en arrière-plan.
    for (const { id, file } of fresh) uploadOne(id, file, file.name);
  };

  const retry = (id: string) => {
    const target = itemsRef.current.find((a) => a.id === id);
    const file = (target as (Attachment & { file?: File }) | undefined)?.file;
    if (!target || !file || target.status !== 'error') return;
    setItems((cur) =>
      cur.map((a) =>
        a.id === id ? { ...a, status: 'uploading' as const } : a,
      ),
    );
    uploadOne(id, file, target.name);
  };

  const remove = (id: string) => {
    const target = itemsRef.current.find((a) => a.id === id);
    if (target?.objectUrl) URL.revokeObjectURL(target.objectUrl);
    // Supprime aussi côté serveur si déjà uploadé (id non local).
    if (target && !target.id.startsWith('local-')) {
      void api(
        `/attachments/${encodeURIComponent(target.id)}`,
        'DELETE',
        {},
      ).catch(() => {});
    }
    setItems((cur) => cur.filter((a) => a.id !== id));
  };

  /**
   * Prépare l'envoi : attend les uploads en cours, refuse si échec ou si un
   * upload dépasse le délai, marque les fichiers comme rattachés au message,
   * construit le texte, vide le brouillon (local + localStorage).
   * Le brouillon n'est vidé qu'après préparation complète : en cas d'erreur
   * (timeout, échec d'upload, mark-attached refusé), rien n'est perdu.
   */
  const prepareSend = async (draft: string): Promise<string> => {
    for (let i = 0; i < UPLOAD_WAIT_ROUNDS; i++) {
      if (!itemsRef.current.some((a) => a.status === 'uploading')) break;
      await new Promise((resolve) => setTimeout(resolve, UPLOAD_WAIT_MS));
    }
    const snapshot = itemsRef.current;
    const stuck = snapshot.filter((a) => a.status === 'uploading');
    if (stuck.length) {
      throw new Error(
        `Téléversement toujours en cours après ${Math.round((UPLOAD_WAIT_ROUNDS * UPLOAD_WAIT_MS) / 1000)} s : ${stuck.map((a) => a.name).join(', ')}. Attendez la fin du téléversement puis réessayez — votre brouillon est conservé.`,
      );
    }
    const failed = snapshot.filter((a) => a.status === 'error');
    if (failed.length) {
      throw new Error(
        `Envoi impossible : ${failed.map((a) => a.name).join(', ')} n'a pas pu être téléversé.`,
      );
    }
    const ready = snapshot.filter(
      (a) => a.status === 'ready' && !a.id.startsWith('local-'),
    );
    if (ready.length) {
      // Exclut les fichiers du nettoyage des orphelins (rattachés à un message).
      // Attendu (pas de fire-and-forget) : si le rattachement échoue, on
      // lève avant de vider le brouillon pour ne rien perdre.
      try {
        await api('/attachments/mark-attached', 'POST', {
          ids: ready.map((a) => a.id),
        });
      } catch {
        throw new Error(
          'Impossible de rattacher les fichiers au message. Réessayez — votre brouillon est conservé.',
        );
      }
    }
    const text = buildMessageWithAttachments(draft, snapshot);
    clearPendingAttachments(scopeRef.current);
    // Vide l'état local sans DELETE : les fichiers sont rattachés au message.
    setItems((cur) => {
      for (const a of cur) if (a.objectUrl) URL.revokeObjectURL(a.objectUrl);
      return [];
    });
    return text;
  };

  // `uploading` couvre aussi la restauration : pas d'envoi avant cartes stables.
  const uploading = restoring || items.some((a) => a.status === 'uploading');

  return { items, addFiles, remove, retry, prepareSend, uploading };
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
