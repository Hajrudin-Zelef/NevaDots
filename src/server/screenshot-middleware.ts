import type { ChatMiddleware } from '@tanstack/ai';
import { takePendingScreenshots } from './computer-screenshots.js';

/**
 * Phase 5a : injecte les screenshots computer comme images multimodales.
 * `onConfig` est appelé à chaque itération de la boucle agentique : les
 * screenshots mis en attente par `computer_screenshot` sont ajoutés comme
 * messages utilisateur avec parties image, juste avant l'appel modèle.
 */
export function screenshotMiddleware(dotId: string): ChatMiddleware {
  return {
    name: 'nevadots-screenshot-injection',
    onConfig: (_ctx, config) => {
      const shots = takePendingScreenshots(dotId);
      if (!shots.length) return;
      const imageMessages = shots.map((base64) => ({
        role: 'user' as const,
        content: [
          {
            type: 'image' as const,
            source: {
              type: 'data' as const,
              value: base64,
              mimeType: 'image/png',
            },
          },
        ],
      }));
      return { messages: [...config.messages, ...imageMessages] };
    },
  };
}
