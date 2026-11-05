// Erreurs communes de l'application.

/** Réponse HTTP en erreur du démon. */
export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
