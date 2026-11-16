// Affichage pour un humain (le JSON, pour les agents, est la donnée de l'API telle quelle).
import { styleText } from 'node:util';
import {
  type Chat,
  type ChatList,
  DELETED_TEXT,
  formatPhone,
  HIT_END,
  HIT_START,
  isMuted,
  type Message,
  type MessageStatus,
  previewOf,
  type SearchHit,
} from '../shared/api.ts';

type Style = Parameters<typeof styleText>[0];
/** Couleur si la sortie est un terminal (et sans NO_COLOR), texte brut sinon. */
export const paint = (style: Style, text: string): string => styleText(style, text, { stream: process.stdout });

const pad = (n: number): string => String(n).padStart(2, '0');

/** Date courte d'un horodatage (secondes) : heure aujourd'hui, sinon jour et heure. */
export function when(seconds: number, now = new Date()): string {
  if (seconds === 0) return '';
  const d = new Date(seconds * 1000);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.toDateString() === now.toDateString()) return time;
  const date = `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`;
  return d.getFullYear() === now.getFullYear() ? `${date} ${time}` : `${date}/${d.getFullYear()} ${time}`;
}

/** Texte sur une ligne, coupé à `max` caractères. */
export function oneLine(text: string, max: number): string {
  const flat = text.replaceAll(/\s+/gu, ' ').trim();
  // graphèmes (un émoji composé compte pour un)
  const chars = Array.from(new Intl.Segmenter('fr', { granularity: 'grapheme' }).segment(flat), (g) => g.segment);
  return chars.length <= max ? flat : `${chars.slice(0, max - 1).join('')}…`;
}

/** Numéro lisible d'un JID de personne (`33612…@s.whatsapp.net` → « +33 6 12… »), sinon le JID. */
export const jidLabel = (jid: string): string => (jid.endsWith('@s.whatsapp.net') ? formatPhone(jid.split('@')[0] ?? '') : jid);

/** Marques d'une discussion : épinglée, silencieuse, archivée, favorite, groupe. */
function flags(c: Chat): string {
  return [c.pinned > 0 ? 'épinglée' : '', isMuted(c) ? 'silencieuse' : '', c.archived ? 'archivée' : '', c.favorite ? 'favorite' : '', c.group ? 'groupe' : '']
    .filter((f) => f !== '')
    .join(', ');
}

/** Liste des discussions, une par ligne. */
export function chatLines(chats: readonly Chat[], lists: readonly ChatList[] = []): string[] {
  const names = new Map(lists.map((l) => [l.id, l.name]));
  return chats.map((c) => {
    const unread = c.unread > 0 ? paint(['bold', 'green'], ` (${c.unread})`) : c.markedUnread ? paint(['bold', 'green'], ' (•)') : '';
    const meta = [flags(c), c.labels.map((l) => names.get(l) ?? l).join(', ')].filter((m) => m !== '').join(' · ');
    const head = `${paint('bold', c.name)}${unread}  ${paint('dim', when(c.timestamp))}${meta === '' ? '' : `  ${paint('cyan', meta)}`}`;
    return `${head}\n  ${paint('dim', c.id)}  ${oneLine(c.preview, 80)}`;
  });
}

/** État d'envoi lisible. */
const STATUS: Readonly<Record<MessageStatus, string>> = {
  error: 'échec',
  pending: 'en attente',
  sent: 'envoyé',
  delivered: 'distribué',
  read: 'lu',
  played: 'écouté',
};

/** Auteur affiché d'un message. */
const author = (m: Message): string => (m.fromMe ? 'Moi' : (m.senderName ?? (m.sender === null ? '' : jidLabel(m.sender))) || 'Contact');

/** Messages, du plus ancien au plus récent. */
export function messageLines(messages: readonly Message[]): string[] {
  return messages.map((m) => {
    const body = m.deleted ? paint('italic', DELETED_TEXT) : previewOf(m);
    const extra = [
      m.quoted === null ? '' : `↪ ${oneLine(m.quoted.text, 40)}`,
      m.reactions.length === 0 ? '' : m.reactions.map((r) => r.emoji).join(''),
      m.edited ? 'modifié' : '',
      m.status === null ? '' : STATUS[m.status],
    ]
      .filter((x) => x !== '')
      .join(' · ');
    const who = m.fromMe ? paint(['bold', 'blue'], author(m)) : paint('bold', author(m));
    return `${paint('dim', when(m.timestamp))} ${who}: ${body}${extra === '' ? '' : `  ${paint('dim', `[${extra}]`)}`}\n  ${paint('dim', m.id)}`;
  });
}

/** Résultats de recherche (mots trouvés en évidence). */
export function hitLines(hits: readonly SearchHit[]): string[] {
  return hits.map((h) => {
    const snippet = h.snippet.replaceAll(new RegExp(`${HIT_START}(.*?)${HIT_END}`, 'gu'), (_m, w: string) => paint(['bold', 'yellow'], w));
    const who = h.fromMe ? 'Moi' : (h.senderName ?? '');
    return `${paint('bold', h.chatName)} ${paint('dim', when(h.timestamp))}${who === '' ? '' : ` ${who}:`} ${oneLine(snippet, 120)}\n  ${paint('dim', `${h.chatId} ${h.id}`)}`;
  });
}
