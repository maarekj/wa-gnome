// Journal du démon (pino, sortie standard → journal systemd) ; les derniers avertissements et
// erreurs sont aussi gardés en mémoire pour l'écran de diagnostic de l'application.
import pino from 'pino';
import type { LogLine } from '../shared/api.ts';

/** Lignes gardées au plus. */
const KEEP = 200;
const recent: LogLine[] = [];
const LEVELS: Readonly<Record<number, string>> = { 10: 'trace', 20: 'debug', 30: 'info', 40: 'avertissement', 50: 'erreur', 60: 'fatale' };

/** Texte d'une ligne de journal : message, puis erreur éventuelle. */
function lineText(args: unknown[]): string {
  const parts: string[] = [];
  for (const a of args) {
    if (typeof a === 'string') parts.push(a);
    else if (a instanceof Error) parts.push(a.message);
    else if (typeof a === 'object' && a !== null) {
      const err = 'error' in a ? a.error : 'err' in a ? a.err : undefined;
      if (err instanceof Error) parts.push(err.message);
      else if ('msg' in a && typeof a.msg === 'string') parts.push(a.msg);
    }
  }
  return parts.join(' — ');
}

export const logger = pino({
  level: process.env['WA_GNOME_LOG'] ?? 'warn',
  // erreurs passées sous `error` (usage du projet) : message et pile dans le journal, pas `{}`
  serializers: { error: pino.stdSerializers.err },
  hooks: {
    logMethod(args, method, level) {
      if (level >= 40) {
        recent.push({ time: Date.now(), level: LEVELS[level] ?? String(level), msg: lineText(args).slice(0, 2000) });
        if (recent.length > KEEP) recent.splice(0, recent.length - KEEP);
      }
      method.apply(this, args);
    },
  },
});

/** Derniers avertissements et erreurs, les plus récents à la fin. */
export const recentLogs = (): LogLine[] => [...recent];
