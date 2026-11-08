import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import {
  groupBlocksForApi,
  listAllVoices,
  listFrenchVoices,
  playAudioQueue,
  prepareSpeechBlocks,
  speakBrowser,
  type PlaybackControl,
} from './speech-engine';
import type { Settings, TtsMode, TtsProvider } from '../shared/types';

/** Extrait de test : court (coût neuronal négligeable), avec ponctuation,
 *  liste et pause à vérifier à l'oreille. */
export const VOICE_SAMPLE =
  'Bonjour ! Ceci est un essai de la voix. Écoutez bien les pauses : après une phrase, courte ; après un paragraphe, plus longue.\n\nDeuxième paragraphe : la lecture doit rester claire, sans lire les symboles.';

function browserVoices(): SpeechSynthesisVoice[] {
  try {
    return window.speechSynthesis?.getVoices() ?? [];
  } catch {
    return [];
  }
}

/**
 * Onglet Réglages → Voix : moteur (navigateur gratuit / neuronal qualité),
 * voix, vitesse, pauses calibrées, extrait de test. Sauvegarde via
 * PATCH /api/settings (appliquée aux lectures suivantes).
 */
export function VoicePanel({ settings }: { settings: Settings }) {
  const [mode, setMode] = useState<TtsMode>(settings.ttsMode);
  const [voice, setVoice] = useState(settings.ttsVoice);
  const [rate, setRate] = useState(settings.ttsRate);
  const [pauseSentenceMs, setPauseSentence] = useState(
    settings.ttsPauseSentenceMs,
  );
  const [pauseParagraphMs, setPauseParagraph] = useState(
    settings.ttsPauseParagraphMs,
  );
  const [provider, setProvider] = useState<string | null>(settings.ttsProvider);
  const [model, setModel] = useState<string | null>(settings.ttsModel);
  const [nativeVoices, setNativeVoices] = useState<
    ReturnType<typeof listFrenchVoices>
  >([]);
  /** Opt-in : afficher aussi les voix non françaises (dépannage — accent
   *  étranger sur du français, jamais proposé par défaut). */
  const [allLanguages, setAllLanguages] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [providers, setProviders] = useState<TtsProvider[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [modelVoices, setModelVoices] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [control, setControl] = useState<PlaybackControl | null>(null);

  useEffect(() => {
    const load = () =>
      setNativeVoices(
        allLanguages
          ? listAllVoices(browserVoices())
          : listFrenchVoices(browserVoices()),
      );
    load();
    try {
      window.speechSynthesis?.addEventListener?.('voiceschanged', load);
      return () =>
        window.speechSynthesis?.removeEventListener?.('voiceschanged', load);
    } catch {
      return undefined;
    }
  }, [allLanguages]);

  /** Recharge manuelle : Chrome charge les voix en retard au premier
   *  affichage — un clic suffit, sans recharger la page. */
  const reloadVoices = () => {
    setRefreshing(true);
    const load = () =>
      setNativeVoices(
        allLanguages
          ? listAllVoices(browserVoices())
          : listFrenchVoices(browserVoices()),
      );
    load();
    window.setTimeout(() => {
      load();
      setRefreshing(false);
    }, 500);
  };

  useEffect(
    () => () => {
      control?.stop();
    },
    [control],
  );

  useEffect(() => {
    let active = true;
    void api<{ providers: TtsProvider[] }>('/tts/providers')
      .then((value) => {
        if (active) setProviders(value.providers);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!provider) {
      setModels([]);
      setModelVoices([]);
      return;
    }
    let active = true;
    void api<{ models: string[]; voices?: string[] }>(
      `/tts/models?provider=${encodeURIComponent(provider)}`,
    )
      .then((value) => {
        if (!active) return;
        setModels(value.models);
        setModelVoices(value.voices ?? []);
      })
      .catch(() => {
        if (active) {
          setModels([]);
          setModelVoices([]);
        }
      });
    return () => {
      active = false;
    };
  }, [provider]);

  const stopTest = useCallback(() => {
    control?.stop();
    setControl(null);
    setPlaying(false);
    setTesting(false);
  }, [control]);

  const listenSample = async () => {
    stopTest();
    setError('');
    setTesting(true);
    try {
      const blocks = prepareSpeechBlocks(VOICE_SAMPLE, {
        sentenceMs: pauseSentenceMs,
        paragraphMs: pauseParagraphMs,
      });
      if (mode === 'browser') {
        const synth = window.speechSynthesis;
        if (!synth) throw new Error('Synthèse vocale indisponible ici.');
        const candidates = synth.getVoices();
        const uri =
          voice ||
          candidates.find((v) => v.lang.toLowerCase() === 'fr-FR')?.voiceURI;
        const found = candidates.find((v) => v.voiceURI === uri);
        if (!found)
          throw new Error(
            'Aucune voix française installée. Ajoutez-en une au système.',
          );
        const next = speakBrowser(blocks, {
          synth,
          voice: found,
          rate,
          onend: () => {
            setControl(null);
            setPlaying(false);
            setTesting(false);
          },
          onerror: (e) => {
            setError(e.message);
            setTesting(false);
          },
        });
        setControl(next);
        setPlaying(true);
        return;
      }
      if (!provider || !model)
        throw new Error(
          'Choisissez un provider et un modèle compatibles, puis réessayez.',
        );
      const groups = groupBlocksForApi(blocks);
      const blobs: Blob[] = [];
      for (const group of groups) {
        const response = await fetch('/api/tts', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: group,
            voice: voice || undefined,
            model,
            provider,
            speed: rate,
          }),
        });
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as {
            error?: string;
          };
          throw new Error(body.error ?? `Essai refusé (${response.status}).`);
        }
        blobs.push(await response.blob());
      }
      const next = playAudioQueue(blobs, {
        rate,
        onend: () => {
          setControl(null);
          setPlaying(false);
          setTesting(false);
        },
        onerror: (e) => {
          setError(e.message);
          setTesting(false);
        },
      });
      setControl(next);
      setPlaying(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Essai impossible.');
      setTesting(false);
    }
  };

  const save = async () => {
    setBusy(true);
    setError('');
    setSaved(false);
    try {
      await api('/settings', 'PATCH', {
        ttsMode: mode,
        ttsVoice: voice,
        ttsRate: rate,
        ttsPauseSentenceMs: pauseSentenceMs,
        ttsPauseParagraphMs: pauseParagraphMs,
        ttsProvider: provider,
        ttsModel: model,
      });
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Enregistrement impossible.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="prefs">
      <h3 className="prefs-section">Moteur de lecture</h3>
      <p className="muted prefs-lead">
        Navigateur : gratuit, instantané. Neuronal : qualité top, ~0,015 $/1000
        caractères, texte entier lu sans plafond.
      </p>
      <div className="segmented" role="radiogroup" aria-label="Moteur vocal">
        {(
          [
            ['browser', 'Navigateur'],
            ['model', 'Neuronal'],
          ] as [TtsMode, string][]
        ).map(([option, label]) => (
          <label key={option}>
            <input
              type="radio"
              name="tts-mode"
              value={option}
              checked={mode === option}
              onChange={() => {
                control?.stop();
                setControl(null);
                setPlaying(false);
                setMode(option);
              }}
            />
            <span>{label}</span>
          </label>
        ))}
      </div>

      {mode === 'browser' && (
        <>
          <div className="prefs-field">
            <span className="prefs-field-label">Voix française</span>
            <div className="voice-test-row">
              <button
                type="button"
                className="text-button"
                disabled={refreshing}
                onClick={reloadVoices}
              >
                {refreshing ? 'Recherche…' : 'Recharger les voix'}
              </button>
              <label className="muted">
                <input
                  type="checkbox"
                  checked={allLanguages}
                  onChange={(e) => setAllLanguages(e.target.checked)}
                />{' '}
                Toutes les langues
              </label>
            </div>
            {nativeVoices.length ? (
              <select
                className="field-input"
                aria-label="Voix française"
                value={voice}
                onChange={(e) => setVoice(e.target.value)}
              >
                <option value="">Voix système par défaut</option>
                {nativeVoices.map((v) => (
                  <option key={v.uri} value={v.uri}>
                    {v.name} ({v.lang}
                    {v.natural ? ', naturelle' : ''})
                  </option>
                ))}
              </select>
            ) : (
              <p className="muted">
                Aucune voix française détectée dans ce navigateur. Vérifiez les
                voix système (Windows : Paramètres → Heure et langue → Voix ;
                Android : synthèse vocale Google).
              </p>
            )}
            {nativeVoices.length <= 1 && (
              <p className="muted prefs-lead">
                Pour obtenir plus de voix : sur Windows, ajoutez une voix dans
                Paramètres → Heure et langue → Voix puis redémarrez Chrome ; sur
                Android, installez des voix françaises dans la synthèse vocale
                Google puis rechargez la page.
              </p>
            )}
          </div>
          <RangeField
            label="Vitesse"
            value={rate}
            min={0.5}
            max={2}
            step={0.1}
            format={(v) => `${v.toFixed(1)}×`}
            onChange={setRate}
          />
          <RangeField
            label="Pause entre phrases"
            value={pauseSentenceMs}
            min={0}
            max={1000}
            step={50}
            format={(v) => `${v} ms`}
            onChange={setPauseSentence}
          />
          <RangeField
            label="Pause entre paragraphes"
            value={pauseParagraphMs}
            min={0}
            max={2000}
            step={50}
            format={(v) => `${v} ms`}
            onChange={setPauseParagraph}
          />
        </>
      )}

      {mode === 'model' && (
        <>
          <div className="prefs-field">
            <span className="prefs-field-label">Provider neuronal</span>
            {providers.length ? (
              <select
                className="field-input"
                aria-label="Provider neuronal"
                value={provider ?? ''}
                onChange={(e) => {
                  setProvider(e.target.value || null);
                  setModel(null);
                }}
              >
                <option value="">Choisir…</option>
                {providers
                  .filter((p) => p.support !== 'unknown')
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                      {p.support === 'gateway' ? ' (passerelle)' : ''}
                    </option>
                  ))}
                {providers.some((p) => p.support === 'unknown') && (
                  <optgroup label="Autres (catalogue live à vérifier)">
                    {providers
                      .filter((p) => p.support === 'unknown')
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.label}
                        </option>
                      ))}
                  </optgroup>
                )}
              </select>
            ) : (
              <p className="muted">
                Aucun provider configuré. Ajoutez une clé API dans l’onglet API
                et Modèles.
              </p>
            )}
          </div>
          <div className="prefs-field">
            <span className="prefs-field-label">Modèle compatible</span>
            {!provider ? (
              <p className="muted">Choisissez d’abord un provider.</p>
            ) : models.length ? (
              <select
                className="field-input"
                aria-label="Modèle TTS compatible"
                value={model ?? ''}
                onChange={(e) => setModel(e.target.value || null)}
              >
                <option value="">Choisir…</option>
                {models.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
            ) : (
              <p className="muted">
                Aucun modèle TTS détecté dans le catalogue live de ce provider.
                Vérifiez sa clé et ses modèles disponibles, puis rechargez la
                liste.
              </p>
            )}
          </div>
          <div className="prefs-field">
            <span className="prefs-field-label">Voix du modèle</span>
            <select
              className="field-input"
              aria-label="Voix du modèle"
              value={voice}
              onChange={(e) => setVoice(e.target.value)}
            >
              <option value="">Auto (le provider décide)</option>
              {modelVoices.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
            {!modelVoices.length && (
              <p className="muted prefs-lead">
                Ce provider n’expose pas de liste de voix : « Auto » laisse le
                endpoint choisir. N’inventez pas de nom : un nom inconnu est
                refusé (erreur 400 du provider).
              </p>
            )}
          </div>
          <RangeField
            label="Vitesse"
            value={rate}
            min={0.5}
            max={2}
            step={0.1}
            format={(v) => `${v.toFixed(1)}×`}
            onChange={setRate}
          />
          <RangeField
            label="Pause entre phrases"
            value={pauseSentenceMs}
            min={0}
            max={1000}
            step={50}
            format={(v) => `${v} ms`}
            onChange={setPauseSentence}
          />
          <RangeField
            label="Pause entre paragraphes"
            value={pauseParagraphMs}
            min={0}
            max={2000}
            step={50}
            format={(v) => `${v} ms`}
            onChange={setPauseParagraph}
          />
        </>
      )}

      <div className="prefs-field">
        <span className="prefs-field-label">Essai</span>
        <div className="voice-test-row">
          <button
            type="button"
            className="text-button"
            disabled={testing && !playing}
            onClick={() => void listenSample()}
          >
            {playing ? 'En écoute…' : 'Écouter un extrait'}
          </button>
          {playing && (
            <button type="button" className="text-button" onClick={stopTest}>
              Arrêter
            </button>
          )}
        </div>
      </div>

      {error && (
        <p className="chat-error" role="alert">
          {error}
        </p>
      )}
      {saved && (
        <p className="muted" role="status">
          Enregistré — appliqué aux prochaines lectures.
        </p>
      )}
      <div className="prefs-actions">
        <button
          type="button"
          className="primary"
          disabled={busy}
          onClick={() => void save()}
        >
          {busy ? 'Enregistrement…' : 'Enregistrer'}
        </button>
      </div>
    </div>
  );
}

function RangeField({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
  onChange: (value: number) => void;
}) {
  return (
    <div className="prefs-field">
      <span className="prefs-field-label">
        {label} · <strong>{format(value)}</strong>
      </span>
      <input
        className="voice-range"
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}
