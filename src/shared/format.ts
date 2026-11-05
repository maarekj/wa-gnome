// Mise en forme : échappement Pango, dates.
import GLib from 'gi://GLib';

/** Texte échappé pour le balisage Pango (titres d'Adw.ActionRow, etc.). */
export const esc = (s: string): string => GLib.markup_escape_text(s, -1);

/** Heure d'un message (`14:05`). */
export function fmtTime(seconds: number): string {
  return GLib.DateTime.new_from_unix_local(seconds)?.format('%H:%M') ?? '';
}

/** Date courte pour la liste : heure aujourd'hui, « Hier », jour de la semaine, sinon date. */
export function fmtShortDate(seconds: number, now = GLib.DateTime.new_now_local()): string {
  if (seconds <= 0) return '';
  const d = GLib.DateTime.new_from_unix_local(seconds);
  if (d === null) return '';
  const days = Math.round(dayIndex(now) - dayIndex(d));
  if (days <= 0) return d.format('%H:%M') ?? '';
  if (days === 1) return 'Hier';
  if (days < 7) return d.format('%A') ?? '';
  return d.format('%d/%m/%Y') ?? '';
}

/** Libellé du séparateur de jour dans une conversation. */
export function fmtDay(seconds: number, now = GLib.DateTime.new_now_local()): string {
  const d = GLib.DateTime.new_from_unix_local(seconds);
  if (d === null) return '';
  const days = Math.round(dayIndex(now) - dayIndex(d));
  if (days <= 0) return "Aujourd'hui";
  if (days === 1) return 'Hier';
  return d.format('%A %e %B %Y') ?? '';
}

/** Numéro du jour local (pour comparer deux dates au jour près). */
const dayIndex = (d: GLib.DateTime): number => {
  const local = GLib.DateTime.new_local(d.get_year(), d.get_month(), d.get_day_of_month(), 0, 0, 0);
  return (local?.to_unix() ?? 0) / 86_400;
};

/** Clé de jour (`2026-11-05`) pour grouper les messages. */
export const dayKey = (seconds: number): string => GLib.DateTime.new_from_unix_local(seconds)?.format('%F') ?? '';
