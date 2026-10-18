import { claimUnconsumedImages } from './attachment-routes.js';
import type { Store } from './store.js';

interface MessageLike {
  role: string;
  content?: unknown;
}

/**
 * Injecte les images jointes comme parties multimodales (phase 5).
 * Les images sont rattachées à l'envoi (mark-attached) ; ce module les
 * consomme au moment de l'appel modèle et les ajoute au dernier message
 * utilisateur au format AG-UI ({ type: 'image', source: { type: 'data' } }),
 * que convertInputToTanStackAI sait convertir.
 */
export async function injectAttachedImages<T extends MessageLike>(
  messages: T[],
  store: Store,
): Promise<T[]> {
  const images = await claimUnconsumedImages(store);
  if (!images.length) return messages;
  let idx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      idx = i;
      break;
    }
  }
  if (idx === -1) return messages;
  const message = messages[idx];
  const existing = Array.isArray(message.content) ? message.content : [];
  const parts = [
    ...(existing.length
      ? existing
      : [
          {
            type: 'text',
            text: typeof message.content === 'string' ? message.content : '',
          },
        ]),
    ...images.map((image) => ({
      type: 'image',
      source: {
        type: 'data',
        value: image.base64,
        mimeType: image.mime,
      },
    })),
  ];
  const next = [...messages];
  next[idx] = { ...message, content: parts };
  return next;
}
