// Paramètres manquants : demandés avec Clack dans un terminal, erreur claire sinon (agent, script).
import * as p from '@clack/prompts';
import type { Chat, ChatList } from '../shared/api.ts';
import { CliError, type Client } from './client.ts';
import { fold, matchChat, matchList, phoneOf } from './resolve.ts';
import { oneLine, when } from './format.ts';

/** Contexte d'une commande : interaction permise ou non, client du compte choisi. */
export interface Session {
  readonly interactive: boolean;
  readonly client: Client;
  /** un paramètre a été demandé (l'envoi est alors confirmé) */
  prompted: boolean;
}

/** Code de sortie d'une erreur d'usage (paramètre manquant ou ambigu). */
export const USAGE = 2;

/** Valeur d'un prompt Clack ; Échap ou Ctrl+C : sortie propre. */
export function answered(value: string | symbol): string;
export function answered(value: boolean | symbol): boolean;
export function answered(value: string | boolean | symbol): string | boolean {
  if (typeof value === 'symbol') {
    p.cancel('Annulé');
    process.exit(130);
  }
  return value;
}

/** Paramètre manquant : demandé (terminal) ou erreur d'usage. */
export async function ask(s: Session, what: string, opts: { placeholder?: string; multiline?: boolean } = {}): Promise<string> {
  if (!s.interactive) throw new CliError(`${what} manquant(e) (mode non interactif)`, USAGE);
  s.prompted = true;
  const value = answered(
    await p.text({
      message: what,
      ...(opts.placeholder === undefined ? {} : { placeholder: opts.placeholder }),
      validate: (v) => (v === undefined || v.trim() === '' ? 'Valeur requise' : undefined),
    }),
  );
  return value.trim();
}

const chatOption = (c: Chat): { value: string; label: string; hint: string } => ({
  value: c.id,
  label: c.unread > 0 ? `${c.name} (${c.unread})` : c.name,
  hint: `${when(c.timestamp)} ${oneLine(c.preview, 40)}`.trim(),
});

/** Choix d'une discussion dans une liste (recherche en tapant). */
export async function chooseChat(s: Session, chats: readonly Chat[], message = 'Discussion'): Promise<Chat> {
  s.prompted = true;
  const id = answered(
    await p.autocomplete({
      message,
      options: chats.map((c) => chatOption(c)),
      maxItems: 12,
      placeholder: 'Tapez pour chercher…',
      filter: (search, o) => fold(o.label ?? '').includes(fold(search)),
    }),
  );
  const chat = chats.find((c) => c.id === id);
  if (chat === undefined) throw new CliError('discussion introuvable');
  return chat;
}

const candidates = (items: readonly { id: string; name: string }[]): string =>
  items
    .slice(0, 10)
    .map((c) => `  ${c.name}  (${c.id})`)
    .join('\n');

/**
 * Discussion désignée par `query` (identifiant, nom approché ou numéro) ; absente : choisie
 * (terminal). Un numéro sans discussion : vérifié sur WhatsApp (nouvelle discussion).
 */
export async function resolveChat(s: Session, query: string | undefined): Promise<Chat> {
  const chats = await s.client.chats();
  if (query === undefined || query.trim() === '') {
    if (!s.interactive) throw new CliError('discussion manquante : identifiant, nom ou numéro (voir `wa chats`)', USAGE);
    return chooseChat(s, chats);
  }
  const m = matchChat(chats, query);
  if (m.kind === 'one') return m.item;
  if (m.kind === 'many') {
    if (s.interactive) return chooseChat(s, m.items, `Plusieurs discussions pour « ${query} »`);
    throw new CliError(`plusieurs discussions pour « ${query} » ; préciser (nom exact ou identifiant) :\n${candidates(m.items)}`, USAGE);
  }
  const phone = phoneOf(query);
  if (phone !== null) {
    const id = await s.client.lookup(phone);
    if (id === null) throw new CliError(`le numéro ${query} n'est pas sur WhatsApp`);
    return chats.find((c) => c.id === id) ?? { ...emptyChat, id, name: query };
  }
  // contact du carnet sans discussion
  const contacts = await s.client.contacts();
  const people = contacts.filter((c) => fold(c.name).includes(fold(query)));
  const [person] = people;
  if (people.length === 1 && person !== undefined) return { ...emptyChat, id: person.id, name: person.name };
  if (people.length > 1 && !s.interactive) throw new CliError(`plusieurs contacts pour « ${query} » :\n${candidates(people)}`, USAGE);
  if (people.length > 1) {
    s.prompted = true;
    const id = answered(
      await p.select({ message: `Plusieurs contacts pour « ${query} »`, options: people.slice(0, 30).map((c) => ({ value: c.id, label: c.name })) }),
    );
    return { ...emptyChat, id, name: people.find((c) => c.id === id)?.name ?? id };
  }
  throw new CliError(`aucune discussion ni contact pour « ${query} »`, USAGE);
}

/** Discussion pas encore connue du démon (contact ou numéro). */
const emptyChat: Chat = {
  id: '',
  name: '',
  group: false,
  unread: 0,
  timestamp: 0,
  preview: '',
  archived: false,
  mutedUntil: 0,
  pinned: 0,
  markedUnread: false,
  labels: [],
  favorite: false,
  ephemeral: 0,
};

/** Liste désignée par son nom ou son identifiant ; absente : choisie (terminal). */
export async function resolveList(s: Session, query?: string): Promise<ChatList> {
  const lists = await s.client.lists();
  if (lists.length === 0) throw new CliError('aucune liste (à créer depuis le téléphone)');
  if (query === undefined || query.trim() === '') {
    if (!s.interactive) throw new CliError(`liste manquante ; listes : ${lists.map((l) => l.name).join(', ')}`, USAGE);
    s.prompted = true;
    const id = answered(await p.select({ message: 'Liste', options: lists.map((l) => ({ value: l.id, label: l.name })) }));
    const list = lists.find((l) => l.id === id);
    if (list === undefined) throw new CliError('liste introuvable');
    return list;
  }
  const m = matchList(lists, query);
  if (m.kind === 'one') return m.item;
  const names = (m.kind === 'many' ? m.items : lists).map((l) => l.name).join(', ');
  throw new CliError(m.kind === 'many' ? `plusieurs listes pour « ${query} » : ${names}` : `liste inconnue « ${query} » ; listes : ${names}`, USAGE);
}

/** Confirmation (seulement si un paramètre a été demandé : la commande complète vaut accord). */
export async function confirmed(s: Session, message: string): Promise<boolean> {
  if (!s.interactive || !s.prompted) return true;
  return answered(await p.confirm({ message }));
}
