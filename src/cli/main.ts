#!/usr/bin/env node
// CLI `wa` : piloter le démon wa-gnome (discussions, messages, listes, envoi…).
// Humain : `wa` seul ouvre le menu interactif ; ce qui manque à une commande est demandé.
// Agent / script : `--json` (sortie), `--no-input` (jamais de question : erreur d'usage, code 2).
// Codes de sortie : 0 succès, 1 erreur, 2 usage (paramètre manquant ou ambigu), 3 démon injoignable.
import { buildApplication, run, text_en } from '@stricli/core';
import { CliError } from './client.ts';
import { routes } from './commands.ts';
import { interactive } from './interactive.ts';

const app = buildApplication(routes, {
  name: 'wa',
  // oxlint-disable-next-line typescript/no-deprecated -- configuration simple, sans intégration
  versionInfo: { currentVersion: '0.1.0' },
  scanner: { caseStyle: 'allow-kebab-for-camel' },
  // oxlint-disable-next-line typescript/no-deprecated -- configuration simple, sans intégration
  documentation: { caseStyle: 'convert-camel-to-kebab' },
  determineExitCode: (e) => (e instanceof CliError ? e.code : 1),
  localization: {
    // erreur d'une commande : message seul, sans pile (CliError : déjà rédigée pour l'utilisateur)
    loadText: () => ({
      ...text_en,
      exceptionWhileRunningCommand: (exc: unknown) => `wa : ${exc instanceof Error ? exc.message : String(exc)}`,
    }),
  },
});

/** Erreur montrée sans pile (CliError), puis code de sortie. */
function fail(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`wa : ${message}\n`);
  process.exitCode = error instanceof CliError ? error.code : 1;
}

const args = process.argv.slice(2);
try {
  if (args.length === 0 && process.stdin.isTTY && process.stdout.isTTY) await interactive();
  else {
    await run(app, args, {
      process: {
        stdout: process.stdout,
        stderr: process.stderr,
        env: process.env,
        get exitCode() {
          return process.exitCode ?? null;
        },
        set exitCode(code: number | string | null) {
          process.exitCode = code ?? undefined;
        },
      },
    });
  }
} catch (error) {
  fail(error);
}
