import { Hono } from 'hono';
import { z } from 'zod';
import type { Platform } from './platform.js';
import type { AppVariables } from './request-context.js';

const TTS_TIMEOUT_MS = 30_000;
const TTS_MAX_CHARS = 4000;

/** Modèles TTS connus par provider (repli quand le catalogue live échoue). */
const KNOWN_TTS_MODELS: Record<string, string[]> = {
  openai: ['tts-1', 'tts-1-hd', 'gpt-4o-mini-tts'],
  // Passerelle OpenCode (zen) : compatible OpenAI, modèles OpenAI servis.
  opencode: ['tts-1', 'tts-1-hd', 'gpt-4o-mini-tts'],
};
/** Voix connues par provider (repli quand `/audio/voices` est absent). */
const KNOWN_TTS_VOICES: Record<string, string[]> = {
  openai: ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'],
  opencode: ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'],
};
/** Motifs de modèles TTS dans un catalogue OpenAI-compatible. */
const TTS_MODEL_PATTERN = /(tts|audio|speak|voice|bark|xtts|parler|vits)/i;
const STT_PATTERN = /(whisper|transcri|stt|diariz)/i;

async function fetchJson(url: string, key: string, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${key}` },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return (await response.json().catch(() => null)) as {
      data?: Array<{ id?: unknown }>;
    } | null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function ttsRoutes(platform: Platform) {
  const app = new Hono<{ Variables: AppVariables }>();

  /** Modèles TTS compatibles d'un provider : catalogue live filtré,
   *  sinon liste statique connue, sinon vide explicite. */
  app.get('/tts/models', async (c) => {
    const registry = platform.config.providerRegistry;
    const providerId = c.req.query('provider') ?? undefined;
    const provider =
      (providerId ? registry?.get(providerId) : undefined) ??
      registry?.list().find((p) => !!p.apiKey);
    if (!provider || !provider.apiKey)
      return c.json({ models: [], voices: [], reason: 'no-key' });
    const catalog = await fetchJson(
      `${provider.baseUrl.replace(/\/$/, '')}/models`,
      provider.apiKey,
      8000,
    );
    const live = (catalog?.data ?? [])
      .map((entry) => (typeof entry.id === 'string' ? entry.id : ''))
      .filter(Boolean)
      .filter((id) => TTS_MODEL_PATTERN.test(id) && !STT_PATTERN.test(id));
    if (live.length)
      return c.json({ models: live, voices: [], source: 'live' });
    const known = KNOWN_TTS_MODELS[provider.id] ?? [];
    return c.json({
      models: known,
      voices: KNOWN_TTS_VOICES[provider.id] ?? [],
      source: known.length ? 'static' : 'none',
    });
  });

  /** Synthèse vocale neuronale : le texte part au provider (clé serveur,
   *  jamais exposée), l'audio revient tel quel. Tout compte connecté. */
  app.post('/tts', async (c) => {
    const parsed = z
      .object({
        text: z.string().min(1).max(TTS_MAX_CHARS),
        voice: z.string().max(120).nullish(),
        model: z.string().max(160).nullish(),
        provider: z.string().max(120).nullish(),
        speed: z.number().finite().min(0.25).max(4).nullish(),
      })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Invalid TTS request.' }, 400);
    const registry = platform.config.providerRegistry;
    const { text, voice, model, provider: providerId, speed } = parsed.data;
    const provider =
      (providerId ? registry?.get(providerId) : undefined) ??
      registry?.list().find((p) => !!p.apiKey);
    if (!provider || !provider.apiKey)
      return c.json(
        {
          error:
            'Aucun provider configuré pour la synthèse vocale. Ajoutez une clé API dans Réglages.',
        },
        404,
      );
    const ttsModel =
      model ??
      KNOWN_TTS_MODELS[provider.id]?.[0] ??
      provider.models.find(
        (m) => TTS_MODEL_PATTERN.test(m) && !STT_PATTERN.test(m),
      );
    if (!ttsModel)
      return c.json(
        {
          error: `Aucun modèle TTS connu pour ${provider.label}. Choisissez-en un dans Réglages → Voix.`,
        },
        404,
      );
    const ttsVoice = voice ?? KNOWN_TTS_VOICES[provider.id]?.[0] ?? 'alloy';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TTS_TIMEOUT_MS);
    try {
      const response = await fetch(
        `${provider.baseUrl.replace(/\/$/, '')}/audio/speech`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${provider.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: ttsModel,
            input: text,
            voice: ttsVoice,
            response_format: 'mp3',
            speed: speed ?? 1,
          }),
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        return c.json(
          {
            error: `Synthèse vocale refusée (${response.status}). ${detail.slice(0, 200) || 'Vérifiez le modèle et la clé.'}`,
          },
          response.status === 401 || response.status === 403 ? 502 : 502,
        );
      }
      const audio = await response.arrayBuffer();
      if (!audio.byteLength)
        return c.json({ error: 'Réponse audio vide du provider.' }, 502);
      return new Response(audio, {
        status: 200,
        headers: {
          'Content-Type': response.headers.get('content-type') ?? 'audio/mpeg',
          'Content-Length': String(audio.byteLength),
          'Cache-Control': 'no-store',
        },
      });
    } catch (error) {
      const timeout =
        error instanceof DOMException && error.name === 'AbortError';
      return c.json(
        {
          error: timeout
            ? 'Synthèse vocale trop longue (timeout 30 s). Raccourcissez le texte.'
            : 'Voix neuronale injoignable. Réessayez ou repassez en voix navigateur.',
        },
        504,
      );
    } finally {
      clearTimeout(timer);
    }
  });

  return app;
}
