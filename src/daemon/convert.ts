// Conversion des messages Baileys (protobuf) vers le format de l'API.
import { getContentType, isJidGroup, jidNormalizedUser, normalizeMessageContent, type proto, type WAMessage } from 'baileys';
import type { Message, MessageKind } from '../shared/api.ts';

/** Horodatage protobuf (number ou Long) en secondes. */
export const seconds = (ts: number | { toNumber: () => number } | null | undefined): number => {
  if (ts === null || ts === undefined) return 0;
  return typeof ts === 'number' ? ts : ts.toNumber();
};

/** Messages techniques (clés de chiffrement, accusés…) : jamais affichés. */
const HIDDEN = new Set(['protocolMessage', 'senderKeyDistributionMessage', 'messageContextInfo', 'pollUpdateMessage', 'keepInChatMessage']);

type Extract = (c: proto.IMessage) => { kind: MessageKind; text: string };

/** Genre et texte (ou légende) par type de contenu ; les autres types sont « other ». */
const EXTRACT: Partial<Record<keyof proto.IMessage, Extract>> = {
  conversation: (c) => ({ kind: 'text', text: c.conversation ?? '' }),
  extendedTextMessage: (c) => ({ kind: 'text', text: c.extendedTextMessage?.text ?? '' }),
  imageMessage: (c) => ({ kind: 'image', text: c.imageMessage?.caption ?? '' }),
  videoMessage: (c) => ({ kind: 'video', text: c.videoMessage?.caption ?? '' }),
  ptvMessage: (c) => ({ kind: 'video', text: c.ptvMessage?.caption ?? '' }),
  audioMessage: () => ({ kind: 'audio', text: '' }),
  documentMessage: (c) => ({ kind: 'document', text: c.documentMessage?.caption ?? c.documentMessage?.fileName ?? '' }),
  stickerMessage: () => ({ kind: 'sticker', text: '' }),
  locationMessage: (c) => ({ kind: 'location', text: c.locationMessage?.name ?? '' }),
  liveLocationMessage: (c) => ({ kind: 'location', text: c.liveLocationMessage?.caption ?? '' }),
  contactMessage: (c) => ({ kind: 'contact', text: c.contactMessage?.displayName ?? '' }),
  reactionMessage: (c) => ({ kind: 'reaction', text: c.reactionMessage?.text ?? '' }),
};

/** Message affichable, ou null (message technique, sans contenu, statut). */
export function toMessage(wa: WAMessage): Message | null {
  const { remoteJid, id } = wa.key;
  if (remoteJid === null || remoteJid === undefined || id === null || id === undefined) return null;
  // statuts (« stories ») : hors périmètre
  if (remoteJid === 'status@broadcast') return null;
  const content = normalizeMessageContent(wa.message);
  const type = getContentType(content);
  if (content === undefined || type === undefined || HIDDEN.has(type)) return null;

  const extract = EXTRACT[type];
  const { kind, text } = extract === undefined ? { kind: 'other' as const, text: '' } : extract(content);
  const fromMe = wa.key.fromMe === true;
  const participant = wa.key.participant ?? wa.participant ?? null;
  return {
    id,
    chatId: jidNormalizedUser(remoteJid),
    fromMe,
    sender: isJidGroup(remoteJid) === true && participant !== null ? jidNormalizedUser(participant) : null,
    senderName: fromMe ? null : (wa.pushName ?? null),
    timestamp: seconds(wa.messageTimestamp),
    kind,
    text,
  };
}
