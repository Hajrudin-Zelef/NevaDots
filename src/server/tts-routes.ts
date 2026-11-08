import { Hono } from 'hono';
import { z } from 'zod';
import type { Platform } from './platform.js';
import type { AppVariables } from './request-context.js';

const TTS_TIMEOUT_MS = 30_000;

/** Voix par défaut quand l'utilisateur n'en choisit pas (le provider
 *  tranche ; 'auto' laisse le endpoint décider). */
const DEFAULT_VOICE = 'auto';
/** Motifs de modèles TTS dans un catalogue OpenAI-compatible. */
const TTS_MODEL_PATTERN =
  /(tts|audio|speak|voice|bark|xtts|parler|vits|suno|fish|cosyvoice)/i;
const STT_PATTERN = /(whisper|transcri|stt|diariz)/i;

interface CatalogEntry {
  id?: unknown;
  architecture?: { output_modalities?: unknown };
}

function isTtsModel(entry: CatalogEntry): entry is { id: string } {
  if (typeof entry.id !== 'string' || !entry.id) return false;
  if (TTS_MODEL_PATTERN.test(entry.id) && !STT_PATTERN.test(entry.id))
    return true;
  const modalities = entry.architecture?.output_modalities;
  return (
    Array.isArray(modalities) &&
    modalities.some((m) => typeof m === 'string' && m.toLowerCase() === 'audio')
  );
}

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
      data?: Array<{
        id?: unknown;
        architecture?: { output_modalities?: unknown };
      }>;
    } | null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Extrait le message d'erreur lisible d'une réponse provider (JSON OpenAI
 *  `{error:{message}}` ou texte brut), tronqué. */
function extractProviderMessage(detail: string): string {
  if (!detail) return 'Vérifiez le modèle, la voix et la clé.';
  try {
    const parsed = JSON.parse(detail) as {
      error?: { message?: unknown } | string;
      message?: unknown;
      detail?: unknown;
    };
    const message =
      typeof parsed.error === 'string'
        ? parsed.error
        : typeof parsed.error?.message === 'string'
          ? parsed.error.message
          : typeof parsed.message === 'string'
            ? parsed.message
            : typeof parsed.detail === 'string'
              ? parsed.detail
              : detail;
    return String(message).slice(0, 300);
  } catch {
    return detail.slice(0, 300);
  }
}

export function ttsRoutes(platform: Platform) {
  const app = new Hono<{ Variables: AppVariables }>();

  /** Providers configurés (clé présente). Le support TTS réel n'est
   *  prouvé que par `/api/tts/models` + l'extrait de test — aucun modèle
   *  n'est inventé ici. */
  app.get('/tts/providers', (c) => {
    const registry = platform.config.providerRegistry;
    const providers = (registry?.list() ?? [])
      .filter((provider) => !!provider.apiKey)
      .map((provider) => ({
        id: provider.id,
        label: provider.label,
        support: provider.id === 'litellm' ? 'gateway' : 'unknown',
      }));
    return c.json({ providers });
  });
  /** Modèles TTS compatibles d'un provider : UNIQUEMENT le catalogue live
   *  filtré (motif TTS ou modalité de sortie audio, STT exclus). Jamais de
   *  liste devinée : catalogue injoignable = liste vide + explication. */
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
    if (!catalog)
      return c.json({
        models: [],
        voices: [],
        source: 'none',
        error:
          'Catalogue injoignable : vérifiez la clé et l’endpoint du provider.',
      });
    const live = (catalog.data ?? []).filter(isTtsModel).map((e) => e.id);
    // Voix : endpoint dédié quand il existe, sinon l'utilisateur garde
    // 'auto' (le provider tranche).
    const voicesCatalog = await fetchJson(
      `${provider.baseUrl.replace(/\/$/, '')}/audio/voices`,
      provider.apiKey,
      8000,
    );
    const voices = (voicesCatalog?.data ?? [])
      .map((entry) => {
        const id = (entry as { id?: unknown }).id;
        return typeof id === 'string' ? id : '';
      })
      .filter(Boolean);
    return c.json({ models: live, voices, source: 'live' });
  });

  /** Synthèse vocale neuronale : le texte part au provider (clé serveur,
   *  jamais exposée), l'audio revient tel quel. Tout compte connecté. */
  // Texte entier, sans plafond (décision utilisateur) : le client découpe
  // déjà en groupes ≤ 3000 car. (`groupBlocksForApi`), chaque requête
  // reste petite ; le serveur ne tronque jamais.
  app.post('/tts', async (c) => {
    const parsed = z
      .object({
        text: z.string().min(1),
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
    // Modèle : choix explicite de l'utilisateur, sinon un modèle TTS
    // déclaré dans la config du provider (jamais deviné).
    const ttsModel =
      model ??
      provider.models.find(
        (m) => TTS_MODEL_PATTERN.test(m) && !STT_PATTERN.test(m),
      );
    if (!ttsModel)
      return c.json(
        {
          error: `Aucun modèle TTS pour ${provider.label}. Listez-en un via Réglages → Voix (catalogue live du provider), puis réessayez.`,
        },
        400,
      );
    // Voix : choix explicite, sinon 'auto' (le endpoint tranche — cf.
    // certains providers qui refusent les noms inconnus).
    const ttsVoice = voice || DEFAULT_VOICE;
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
        const providerMessage = extractProviderMessage(detail);
        // 4xx = demande à corriger (modèle/voix/clé) → 400 lisible ;
        // le reste = panne côté provider/passerelle.
        if (response.status >= 400 && response.status < 500)
          return c.json(
            {
              error: `Synthèse vocale refusée (${response.status}). ${providerMessage}`,
            },
            400,
          );
        return c.json(
          {
            error: `Synthèse vocale refusée (${response.status}). ${providerMessage}`,
          },
          502,
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
