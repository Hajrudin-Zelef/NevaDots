import { useState } from 'react';
import {
  DEFAULT_AVATAR_QUALITY,
  type AvatarQuality,
  type AvatarQualitySetting,
} from '../shared/avatars';
import {
  getAvatarQuality,
  getAvatarQualitySetting,
  saveAvatarQuality,
} from './avatar-quality';

const OPTIONS: { value: AvatarQualitySetting; label: string; hint: string }[] =
  [
    { value: 'auto', label: 'Auto', hint: 'selon la connexion et l’appareil' },
    { value: 'low', label: 'Bas · 12 fps', hint: 'connexions faibles' },
    { value: 'standard', label: 'Standard · 15 fps', hint: 'équilibré' },
    { value: 'high', label: 'Haut · 30 fps', hint: 'connexions rapides' },
  ];

const QUALITY_LABEL: Record<AvatarQuality, string> = {
  low: 'Bas · 12 fps',
  standard: 'Standard · 15 fps',
  high: 'Haut · 30 fps',
};

/**
 * Avatar animation quality. `auto` (default) resolves a tier from the network
 * (Network Information API), the device and reduced-motion; a manual choice
 * forces a tier. Persisted server-side, cached client-side (localStorage).
 */
export function AvatarPanel() {
  const [setting, setSetting] = useState<AvatarQualitySetting>(
    getAvatarQualitySetting,
  );
  const [resolved, setResolved] = useState<AvatarQuality>(getAvatarQuality);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  const choose = async (value: AvatarQualitySetting) => {
    setSetting(value);
    setError('');
    try {
      await saveAvatarQuality(value);
      setResolved(getAvatarQuality());
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2500);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Enregistrement refusé.',
      );
    }
  };

  return (
    <div className="api-panel">
      <p className="config-note api-panel-intro">
        Qualité d’animation des avatars animés (Leo, Sam). Les paliers plus bas
        sont plus légers et plus rapides à charger sur connexion ou appareil
        modestes.
      </p>

      <section className="settings-card" aria-label="Animation de l’avatar">
        <h3>Animation de l’avatar</h3>
        <div className="seg-row" role="group" aria-label="Qualité d’animation">
          {OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`seg-btn ${setting === option.value ? 'active' : ''}`}
              aria-pressed={setting === option.value}
              title={option.hint}
              onClick={() => void choose(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <p className="muted">
          {setting === 'auto'
            ? `Auto — palier retenu : ${QUALITY_LABEL[resolved] ?? DEFAULT_AVATAR_QUALITY}.`
            : 'Palier fixé manuellement.'}
          {saved ? ' Enregistré ✓' : ''}
        </p>
      </section>

      {error && <p className="config-note api-error">{error}</p>}
    </div>
  );
}
