# Télémétrie des étapes de configuration

NevaDots suit les étapes de son écran de configuration via le contrat d'ingest du SDK CopilotKit (voir [TELEMETRY.md](TELEMETRY.md)). **Ces événements sont recommandés désactivés** en usage personnel : `DO_NOT_TRACK=1` ou `COPILOTKIT_TELEMETRY_DISABLED=true`, puis redémarrage de l'API. La désactivation supprime la ligne de suivi (file d'attente et identité d'installation comprises) sans toucher aux conversations ni aux réglages.

## Événements (si actif)

| Événement                       | Propriétés bornées                                                                       |
| ------------------------------- | ---------------------------------------------------------------------------------------- |
| `oss.runtime.setup_step_viewed` | étape : `setup_required`, `ready`, `settings`                                            |
| `oss.runtime.setup_failed`      | étape + classe d'erreur : `configuration_missing`, `assistant_run_failed`, …             |
| `oss.runtime.setup_activated`   | activation : premier tour assistant réussi (texte non vide + `RUN_FINISHED` sans erreur) |
| `oss.runtime.setup_abandoned`   | dernière étape observée (reprise après onglet fermé quand possible)                      |

`ready` signale la présence de la configuration requise ; l'activation est enregistrée une fois par installation, dédupliquée redémarrages.

## Garde-fous

- Route `POST /api/setup-telemetry` authentifiée : schéma strict, clés inconnues rejetées, pas d'activation ou d'échec forgé côté client ; mêmes gardes host/origin/cross-site/taille que le reste de l'API.
- Aucun message, réponse, clé, URL, chemin, modèle, email ou identifiant propriétaire dans les événements.
- File SQLite bornée (256 événements, plus anciens sacrifiés), IDs UUID + timestamps secondes, retries bornés au démarrage et à l'arrêt.
- Portée tests locales : `DO_NOT_TRACK=1 npm exec vitest run tests/setup-telemetry.test.ts tests/telemetry.test.ts`.
