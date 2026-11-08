import { describe, expect, it } from 'vitest';
import { filterModelGroups } from '../src/client/ModelSelector';
import type { ModelsResponse } from '../src/shared/models';

const providers: ModelsResponse['providers'] = [
  {
    id: 'openrouter',
    label: 'OpenRouter',
    configured: true,
    models: ['a', 'b'],
  },
  { id: 'litellm', label: 'LiteLLM', configured: false, models: [] },
] as ModelsResponse['providers'];

describe('filterModelGroups', () => {
  it('sans requête : tout est visible, groupes vides inclus', () => {
    const groups = filterModelGroups(providers, '');
    expect(groups).toHaveLength(2);
    expect(groups[0].models).toEqual(['a', 'b']);
  });

  it('filtre insensible à la casse, groupes vides exclus', () => {
    const groups = filterModelGroups(providers, 'B');
    expect(groups).toHaveLength(1);
    expect(groups[0].provider.id).toBe('openrouter');
    expect(groups[0].models).toEqual(['b']);
  });

  it('sans correspondance : aucun groupe', () => {
    expect(filterModelGroups(providers, 'zzz')).toHaveLength(0);
  });
});
