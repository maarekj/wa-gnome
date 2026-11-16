// Erreurs de la CLI.

/** Erreur à montrer telle quelle (sans pile) ; `code` : code de sortie. */
export class CliError extends Error {
  readonly code: number;
  constructor(message: string, code = 1) {
    super(message);
    this.code = code;
  }
}
