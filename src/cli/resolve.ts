// Désignation d'une discussion ou d'une liste par l'utilisateur : identifiant, nom (approché) ou
// numéro de téléphone.
import type { Chat, ChatList } from '../shared/api.ts';

/** Texte comparable : minuscules, sans accents. */
export const fold = (s: string): string => s.normalize('NFD').replaceAll(/\p{M}/gu, '').toLowerCase().trim();

/** Résultat d'une recherche par nom : trouvé, plusieurs candidats, ou rien. */
export type Match<T> = { kind: 'one'; item: T } | { kind: 'many'; items: T[] } | { kind: 'none' };

/**
 * Élément désigné par `query` : identifiant exact, puis nom exact, puis début du nom, puis nom
 * contenant le texte (insensible à la casse et aux accents).
 */
export function match<T>(items: readonly T[], query: string, id: (it: T) => string, name: (it: T) => string): Match<T> {
  const byId = items.find((it) => id(it) === query);
  if (byId !== undefined) return { kind: 'one', item: byId };
  const q = fold(query);
  if (q === '') return { kind: 'none' };
  for (const test of [(n: string) => n === q, (n: string) => n.startsWith(q), (n: string) => n.includes(q)]) {
    const found = items.filter((it) => test(fold(name(it))));
    if (found.length === 1 && found[0] !== undefined) return { kind: 'one', item: found[0] };
    if (found.length > 1) return { kind: 'many', items: found };
  }
  return { kind: 'none' };
}

export const matchChat = (chats: readonly Chat[], query: string): Match<Chat> =>
  match(
    chats,
    query,
    (c) => c.id,
    (c) => c.name,
  );
export const matchList = (lists: readonly ChatList[], query: string): Match<ChatList> =>
  match(
    lists,
    query,
    (l) => l.id,
    (l) => l.name,
  );

/**
 * Discussion dans la liste : listes prédéfinies (non lues, favoris, groupes) d'après l'état de la
 * discussion, comme dans l'application ; listes personnalisées d'après ses étiquettes.
 */
export function inList(c: Chat, l: ChatList): boolean {
  if (l.kind === 'unread') return c.unread > 0 || c.markedUnread;
  if (l.kind === 'favorites') return c.favorite;
  if (l.kind === 'groups') return c.group;
  return c.labels.includes(l.id);
}

/** Chiffres d'un numéro saisi (« +33 6 12 34 56 78 »), ou null si ce n'en est pas un. */
export function phoneOf(query: string): string | null {
  if (!/^\+?[\d\s.()-]{6,}$/u.test(query.trim())) return null;
  const digits = query.replaceAll(/\D/gu, '');
  return digits.length >= 6 ? digits : null;
}

/** Durée saisie (« 8h », « 30m », « 2d », « 1w », « toujours ») en millisecondes ; -1 : toujours. */
export function parseDuration(text: string): number {
  const t = fold(text);
  if (['toujours', 'always', 'forever'].includes(t)) return -1;
  const m = /^(\d+)\s*(m|min|h|d|j|w|s)$/u.exec(t);
  if (m === null) throw new Error(`durée invalide : « ${text} » (ex. 30m, 8h, 2j, 1w, toujours)`);
  const unit: Record<string, number> = { s: 1000, m: 60_000, min: 60_000, h: 3_600_000, d: 86_400_000, j: 86_400_000, w: 604_800_000 };
  return Number(m[1]) * (unit[m[2] ?? 'h'] ?? 3_600_000);
}

/**
 * Heure d'envoi saisie : « 18:30 » (aujourd'hui, ou demain si passée), « +2h » / « +30m », ou
 * date ISO (« 2026-12-24T09:00 ») ; en secondes depuis l'époque.
 */
export function parseWhen(text: string, now = new Date()): number {
  const t = text.trim();
  if (t.startsWith('+')) return Math.floor((now.getTime() + parseDuration(t.slice(1))) / 1000);
  const hm = /^(\d{1,2})[:h](\d{2})$/u.exec(t);
  if (hm !== null) {
    const d = new Date(now);
    d.setHours(Number(hm[1]), Number(hm[2]), 0, 0);
    if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
    return Math.floor(d.getTime() / 1000);
  }
  const ms = Date.parse(t);
  if (Number.isNaN(ms)) throw new Error(`heure invalide : « ${text} » (ex. 18:30, +2h, 2026-12-24T09:00)`);
  return Math.floor(ms / 1000);
}
