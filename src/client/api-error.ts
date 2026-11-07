/** Erreur d'appel API (statut HTTP). Module dédié (sans dépendance) pour
 *  que le Modèle session puisse tester `instanceof` sans cycle d'import. */
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
