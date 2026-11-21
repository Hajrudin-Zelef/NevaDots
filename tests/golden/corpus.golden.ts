import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { searchRag } from '../../src/server/rag.js';
import { slimDocuments } from '../../src/server/agent-prompt.js';

/**
 * Questions d'or — garde-fou du corpus et de la directive.
 *
 * Appelle le **vrai** pipeline (recherche RAG + directive `REFERENCE DATA`) et
 * le **vrai** modèle, puis vérifie des faits dans la réponse. Pas de juge LLM,
 * pas de statistiques : un échec = une régression visible.
 *
 * Hors `npm test` (le fichier ne finit pas par `.test.ts`) :
 *   npm run golden
 */

function dotenv(): Record<string, string> {
  try {
    const raw = readFileSync(join(process.cwd(), '.env'), 'utf8');
    const out: Record<string, string> = {};
    for (const line of raw.split('\n')) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (!match) continue;
      out[match[1]] = match[2].replace(/^["']|["']$/g, '').trim();
    }
    return out;
  } catch {
    return {};
  }
}

const file = dotenv();
const env = (key: string): string => process.env[key] ?? file[key] ?? '';

const CONFIG = {
  baseUrl: env('GOLDEN_BASE_URL') || 'https://nevallm.neva-ci.pro/v1',
  apiKey: env('GOLDEN_API_KEY') || env('FREELLMAPI_API_KEY'),
  model: env('GOLDEN_MODEL') || 'qwen/qwen3.8-27b',
  ragUrl: env('RAG_URL'),
  ragKey: env('RAG_KEY'),
  ragTimeoutMs: 4000,
};

interface GoldenCase {
  name: string;
  question: string;
  required: RegExp[];
  forbidden?: RegExp[];
  expectCovered?: boolean;
}

const COMMON_FORBIDDEN = [
  /knowledge cutoff/i,
  /mes données s['’]arrêtent/i,
  /chercher sur (le )?web/i,
  /recherche web/i,
];

const CASES: GoldenCase[] = [
  {
    name: 'date de sortie de Fable 5.1',
    question: 'Fable 5.1 est sorti quand ?',
    required: [/1\s*(?:er|ᵉʳ|e)?\s*septembre 2026|2026-09-01/i],
    forbidden: [/je ne sais pas/i, /n['’]existe pas/i],
    expectCovered: true,
  },
  {
    name: 'Kimi K3 face à Fable 5.1',
    question: 'Kimi-K3 est au niveau de Fable 5.1 ?',
    required: [/53/, /43[.,]8/],
    forbidden: [/n['’]existe pas/i],
    expectCovered: true,
  },
  {
    name: 'fiche GLM-5.3',
    question: 'GLM-5.3 est parmi les meilleurs en code ?',
    required: [/GLM[- ]?5[.,]3/i],
    expectCovered: true,
  },
  {
    name: 'fiche Qwen3.8-Flash-Next',
    question: 'Qu’est-ce que Qwen3.8-Flash-Next ?',
    required: [/Qwen3[.,]8[- ]Flash[- ]Next/i],
    expectCovered: true,
  },
  {
    name: 'prix de Fable 5.1',
    question: 'Quel est le prix de Fable 5.1 par million de tokens ?',
    required: [/10/, /50/],
    expectCovered: true,
  },
  {
    name: 'date de sortie de Fable 5',
    question: 'Quand est sorti Fable 5 ?',
    // Le corpus ne donne le jour (« 9 juin 2026 ») que dans quelques fiches
    // françaises noyées sous 1 172 documents « fable 5 » : la retrieval
    // remonte « June 2026 ». Accepter le mois, exiger l’année — inventer un
    // jour serait pire.
    required: [/(?:9\s*)?(?:juin|june)\s*2026|2026-06-\d\d/i],
    expectCovered: true,
  },
  {
    name: 'modèle abandonné : le dire une fois, puis nommer l’existant',
    question: 'GPT-6.1 Astra est-il sorti, vaut-il le coup ?',
    required: [/6\.2/, /8[\s$]*\/[\s$]*40/],
    forbidden: [
      // Le Dot ne renvoie pas l'utilisateur à un questionnaire, ni ne parle
      // de sa base (constaté 2026-11-21 : « source : couverture presse… »).
      /dis[- ]moi.*(?:usage|budget)/i,
      /quel est ton (?:usage|budget)/i,
      /sources?\s*:/i,
      /couverture presse/i,
      /d['’]apr[èe]s (?:mes|la|les)/i,
      /faits bruts|la r[ée]f[ée]rence au|les donn[ée]es (?:brutes|indiquent)/i,
    ],
    expectCovered: true,
  },
  {
    name: 'score AA de Fable 5.1 (corpus multi-vintages)',
    question:
      'Quel score Claude Fable 5.1 obtient-il sur l’index Artificial Analysis ?',
    required: [/53|66/],
    expectCovered: true,
  },
  {
    name: 'poids d’un modèle open-weight (Beam)',
    question: 'Quel est le poids exact de Beam-1.0-501B-A23B-FP8 ?',
    required: [/501/, /23/],
    // Le corpus donne 501B total / 23B actifs et les checkpoints BF16/FP8/NVFP4,
    // mais pas la taille disque exacte : le Dot doit le dire, pas nier le modèle.
    forbidden: [/je ne connais pas|n['’]existe pas|mod[èe]le inconnu/i],
    expectCovered: true,
  },
  {
    name: 'modèle chinois récent (MiMo v2.6 Pro)',
    question: 'Le modèle MiMo-V2.6-Pro existe-t-il ?',
    required: [/MiMo/i, /2\.6/],
    forbidden: [/je ne connais pas|n['’]existe pas|pas de fiche/i],
    expectCovered: true,
  },
  {
    name: 'modèle absent du corpus',
    question: 'Que vaut le modèle Zorbania-9 de la société Inexistante ?',
    required: [
      /fictif|fictive|n['’]existe pas|pas de valeur|inconnu|je ne (?:sais|connais) pas|aucune (?:donn[ée]e|information|fiche)|pas de (?:donn[ée]es|fiche)|invent[ée]|n['’]appara[îi]t/i,
    ],
    expectCovered: false,
  },
  {
    name: 'question hors corpus, pas d’invention',
    question: 'Quel temps fera-t-il à Paris demain ?',
    required: [
      /je ne (?:sais|peux) pas|pas (?:d['’]?\s*)?acc[èe]s|pas la capacit[ée]|aucune information|temps r[ée]el|pas de donn[ée]es/i,
    ],
    expectCovered: false,
  },
  {
    name: 'date du jour non inventée',
    question: 'Quelle est la date d’aujourd’hui ?',
    required: [/2026/],
    forbidden: [/2025/],
    expectCovered: false,
  },
];

async function ask(question: string): Promise<string> {
  const rag = await searchRag(question, {
    ragUrl: CONFIG.ragUrl,
    ragKey: CONFIG.ragKey,
    ragTimeoutMs: CONFIG.ragTimeoutMs,
  });
  const documents = rag.covered ? rag.hits : [];
  const prompt = slimDocuments(documents, rag.corpusVersion);
  // Même repère temporel que le prompt réel : sans lui, le modèle invente une
  // date (constaté : « 20 août 2025 »).
  const now = new Date();
  const dateLine = `Date: ${now.toLocaleDateString('fr-FR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })} (${now.toISOString().slice(0, 10)}) — use for dates, never guess.`;
  const response = await fetch(`${CONFIG.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${CONFIG.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: CONFIG.model,
      max_tokens: 800,
      messages: [
        {
          role: 'system',
          content:
            'You are a specialist assistant. Answer in French, concisely, using the reference data when it answers. ' +
            dateLine,
        },
        {
          role: 'user',
          content: `${prompt}\n\nQuestion : ${question}`,
        },
      ],
    }),
    signal: AbortSignal.timeout(90_000),
  });
  const body = (await response.json().catch(() => ({}))) as {
    choices?: Array<{ message?: { content?: string } }>;
    error?: { message?: string };
  };
  const text = body.choices?.[0]?.message?.content ?? '';
  if (!response.ok || !text)
    throw new Error(
      `modèle ${CONFIG.model} : ${body.error?.message ?? response.status}`,
    );
  return text;
}

describe.skipIf(!CONFIG.apiKey)('questions d’or (corpus)', () => {
  for (const item of CASES) {
    it(
      item.name,
      async () => {
        const forbidden = [...COMMON_FORBIDDEN, ...(item.forbidden ?? [])];
        // Le modèle juge est stochastique : un seul échantillon ne fait pas un
        // verdict (constat 2026-11-21 : cas différents en échec d'un run à
        // l'autre). Deux essais, puis échec avec la dernière réponse.
        let lastError: unknown = null;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const answer = await ask(item.question);
          try {
            for (const pattern of item.required)
              expect(answer, `réponse : ${answer}`).toMatch(pattern);
            for (const pattern of forbidden)
              expect(answer, `réponse : ${answer}`).not.toMatch(pattern);
            return;
          } catch (error) {
            lastError = error;
          }
        }
        throw lastError;
      },
      120_000,
    );
  }
});
