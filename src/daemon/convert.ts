// Conversion des messages Baileys (protobuf) vers le format de l'API.
import { getContentType, isJidGroup, jidNormalizedUser, normalizeMessageContent, type proto, type WAMessage } from 'baileys';
import type { Media, Message, MessageKind } from '../shared/api.ts';

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

/** Champs communs des messages média (image, vidéo, audio, document, autocollant). */
interface MediaContent {
  mimetype?: string | null;
  width?: number | null;
  height?: number | null;
  jpegThumbnail?: Uint8Array | null;
  pngThumbnail?: Uint8Array | null;
  fileName?: string | null;
  fileLength?: number | { toNumber: () => number } | null;
  seconds?: number | null;
}

const MEDIA_TYPES = ['imageMessage', 'videoMessage', 'ptvMessage', 'audioMessage', 'documentMessage', 'stickerMessage'] as const;

/** Contenu média d'un message, ou null (texte, position…). */
export function mediaContent(content: proto.IMessage): MediaContent | null {
  for (const t of MEDIA_TYPES) {
    const c = content[t];
    if (c !== null && c !== undefined) return c;
  }
  return null;
}

export function mediaOf(content: proto.IMessage): Media | null {
  const c = mediaContent(content);
  if (c === null) return null;
  const thumb = c.jpegThumbnail ?? c.pngThumbnail ?? null;
  return {
    mimetype: c.mimetype ?? 'application/octet-stream',
    width: c.width ?? null,
    height: c.height ?? null,
    thumbnail: thumb === null || thumb.length === 0 ? null : Buffer.from(thumb).toString('base64'),
    fileName: c.fileName ?? null,
    size: c.fileLength === null || c.fileLength === undefined ? null : seconds(c.fileLength),
    seconds: c.seconds ?? null,
  };
}

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
    media: mediaOf(content),
  };
}
