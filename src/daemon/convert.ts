// Conversion des messages Baileys (protobuf) vers le format de l'API.
import { getContentType, isJidGroup, jidNormalizedUser, normalizeMessageContent, proto, type WAMessage } from 'baileys';
import { callText, type Media, type Message, type MessageKind, type Quoted, statusOf } from '../shared/api.ts';

/** Horodatage protobuf (number ou Long) en secondes. */
export const seconds = (ts: number | { toNumber: () => number } | null | undefined): number => {
  if (ts === null || ts === undefined) return 0;
  return typeof ts === 'number' ? ts : ts.toNumber();
};

/** Messages techniques (clés de chiffrement, accusés…) : jamais affichés. */
// call : appel de groupe annoncé par Baileys (rangé chez l'appelant) ; ligne écrite par le démon
const HIDDEN = new Set(['call', 'reactionMessage', 'protocolMessage', 'senderKeyDistributionMessage', 'messageContextInfo', 'pollUpdateMessage', 'keepInChatMessage']);

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
  // journal d'appel (historique d'un autre appareil)
  callLogMesssage: (c) => {
    const log = c.callLogMesssage;
    const O = proto.Message.CallLogMessage.CallOutcome;
    const outcome = log?.callOutcome;
    const missed = outcome === O.MISSED || outcome === O.SILENCED_BY_DND || outcome === O.SILENCED_UNKNOWN_CALLER;
    // FAILED et autres : simple appel (pas d'issue sûre)
    return { kind: 'call', text: callText(log?.isVideo === true, missed ? 'missed' : outcome === O.REJECTED ? 'rejected' : 'answered') };
  },
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
  /** vocaux : 64 octets de 0 à 100 */
  waveform?: Uint8Array | null;
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
    ...(c.waveform === null || c.waveform === undefined || c.waveform.length === 0 ? {} : { waveform: [...c.waveform].map((v) => Math.min(100, v)) }),
  };
}

/** Citation brute d'un message : auteur tel que reçu (JID), sans nom ni « moi » (résolus à la lecture). */
export type RawQuoted = Omit<Quoted, 'fromMe' | 'senderName'>;

/** Message cité par une réponse (`contextInfo` du contenu), ou null. */
export function quotedOf(content: proto.IMessage): RawQuoted | null {
  // contexte porté par le contenu principal (extendedTextMessage, imageMessage…)
  const type = getContentType(content);
  const value: unknown = type === undefined ? undefined : content[type];
  if (typeof value !== 'object' || value === null || !('contextInfo' in value)) return null;
  // instance (message reçu, décodé) ou objet simple (message que l'on vient d'envoyer) : normalisé
  const info: unknown = value.contextInfo;
  const ctx = typeof info === 'object' && info !== null ? proto.ContextInfo.fromObject(info) : null;
  const id = ctx?.stanzaId;
  if (ctx === null || id === null || id === undefined || id === '') return null;
  {
    const inner = normalizeMessageContent(ctx.quotedMessage);
    const innerType = getContentType(inner);
    const extract = innerType === undefined ? undefined : EXTRACT[innerType];
    const { kind, text } = inner === undefined || extract === undefined ? { kind: 'other' as const, text: '' } : extract(inner);
    const sender = ctx.participant === null || ctx.participant === undefined || ctx.participant === '' ? null : jidNormalizedUser(ctx.participant);
    return { id, sender, kind, text };
  }
}

const Stub = proto.WebMessageInfo.StubType;
/** Appels manqués (messages techniques) : vidéo ou non. */
const CALL_STUBS = new Map<number, boolean>([
  [Stub.CALL_MISSED_VOICE, false],
  [Stub.CALL_MISSED_VIDEO, true],
]);
/** Appels de groupe manqués de Baileys : rangés chez l'appelant ; ligne écrite par le démon dans le groupe. */
const GROUP_CALL_STUBS = new Set<number>([Stub.CALL_MISSED_GROUP_VOICE, Stub.CALL_MISSED_GROUP_VIDEO]);

/** Message reçu par une liste de diffusion (pas un statut, pas une de mes listes). */
export const isReceivedBroadcast = (remoteJid: string, fromMe: boolean): boolean => !fromMe && remoteJid.endsWith('@broadcast') && remoteJid !== 'status@broadcast';

/** Message affichable, ou null (message technique, sans contenu, statut). */
/** Message converti : citation brute en plus, sans réactions (noms résolus par le Store). */
export type Converted = Omit<Message, 'quoted' | 'reactions' | 'edited' | 'deleted' | 'forwarded' | 'viewOnce'> & {
  quoted: RawQuoted | null;
  deleted?: boolean;
  forwarded?: number;
  viewOnce?: boolean;
  /** messages éphémères : durée annoncée par le message (secondes, 0 : non éphémère) */
  expiration?: number;
};

/** Contexte (`contextInfo`) du contenu principal, ou null. */
function contextOf(content: proto.IMessage): proto.IContextInfo | null {
  const type = getContentType(content);
  const value: unknown = type === undefined ? undefined : content[type];
  if (typeof value !== 'object' || value === null || !('contextInfo' in value)) return null;
  const info: unknown = value.contextInfo;
  return typeof info === 'object' && info !== null ? proto.ContextInfo.fromObject(info) : null;
}

/** Message gardé (« garder » dans une discussion éphémère) : nombre ou nom selon la source. */
export const isKept = (t: unknown): boolean => t === proto.KeepType.KEEP_FOR_ALL || t === 'KEEP_FOR_ALL';

/** Message gardé ou plus gardé (`keepInChatMessage`) : message visé, ou null. */
export function keepOf(content: proto.IMessage | undefined): { id: string; kept: boolean } | null {
  const k = content?.keepInChatMessage;
  const id = k?.key?.id;
  if (k === null || k === undefined || id === null || id === undefined) return null;
  return { id, kept: isKept(k.keepType) };
}

/** Durée éphémère annoncée par le message (secondes), 0 sinon. */
export const expirationOf = (content: proto.IMessage): number => contextOf(content)?.expiration ?? 0;

/** Média à vue unique : enveloppe `viewOnceMessage*`, ou drapeau `viewOnce` du média. */
export function viewOnceOf(message: proto.IMessage | null | undefined, content: proto.IMessage): boolean {
  if (message === null || message === undefined) return false;
  if (message.viewOnceMessage !== null && message.viewOnceMessage !== undefined) return true;
  if (message.viewOnceMessageV2 !== null && message.viewOnceMessageV2 !== undefined) return true;
  if (message.viewOnceMessageV2Extension !== null && message.viewOnceMessageV2Extension !== undefined) return true;
  const type = getContentType(content);
  const value: unknown = type === undefined ? undefined : content[type];
  return typeof value === 'object' && value !== null && 'viewOnce' in value && value.viewOnce === true;
}

/** Transfert porté par le contenu (`contextInfo`) : nombre de transferts, 0 si non transféré. */
export function forwardedOf(content: proto.IMessage): number {
  const type = getContentType(content);
  const value: unknown = type === undefined ? undefined : content[type];
  if (typeof value !== 'object' || value === null || !('contextInfo' in value)) return 0;
  const info: unknown = value.contextInfo;
  const ctx = typeof info === 'object' && info !== null ? proto.ContextInfo.fromObject(info) : null;
  if (ctx === null || ctx.isForwarded !== true) return 0;
  return Math.max(1, ctx.forwardingScore ?? 1);
}

/** Auteur d'un message ou d'une réaction d'après sa clé. */
const senderOf = (key: proto.IMessageKey, fallback: string): string => (key.fromMe === true ? 'me' : jidNormalizedUser(key.participant !== null && key.participant !== undefined && key.participant !== '' ? key.participant : (key.remoteJid ?? fallback)));

/** Modification ou suppression d'un message, portée par un message technique (protocolMessage). */
export type Change = ({ kind: 'edit'; text: string; msgKind: MessageKind } | { kind: 'revoke' }) & {
  chatId: string;
  targetId: string;
  /** auteur du changement : `me`, ou JID tel que reçu */
  by: string;
};

/** Nouveau contenu d'une modification → genre et texte (texte, ou légende d'un média). */
export function editedContent(content: proto.IMessage | null | undefined): { kind: MessageKind; text: string } | null {
  const inner = normalizeMessageContent(content);
  const type = getContentType(inner);
  const extract = type === undefined ? undefined : EXTRACT[type];
  return inner === undefined || extract === undefined ? null : extract(inner);
}

/** Modification ou suppression pour tous portée par ce message, ou null. */
export function changeOf(wa: WAMessage): Change | null {
  const p = normalizeMessageContent(wa.message)?.protocolMessage;
  const chatId = wa.key.remoteJid;
  const targetId = p?.key?.id;
  if (p === null || p === undefined || chatId === null || chatId === undefined || targetId === null || targetId === undefined) return null;
  const by = senderOf(wa.key, chatId);
  if (p.type === proto.Message.ProtocolMessage.Type.REVOKE) return { kind: 'revoke', chatId: jidNormalizedUser(chatId), targetId, by };
  if (p.type === proto.Message.ProtocolMessage.Type.MESSAGE_EDIT) {
    const e = editedContent(p.editedMessage);
    return e === null ? null : { kind: 'edit', chatId: jidNormalizedUser(chatId), targetId, text: e.text, msgKind: e.kind, by };
  }
  return null;
}

/** Réaction à enregistrer : auteur `me` pour les miennes, JID tel que reçu sinon ; émoji vide : retirée. */
export interface RawReaction {
  chatId: string;
  targetId: string;
  sender: string;
  emoji: string;
  /** ms */
  timestamp: number;
}


/** Message de réaction (reactionMessage) → réaction, null sinon. */
export function reactionOf(wa: WAMessage): RawReaction | null {
  const content = normalizeMessageContent(wa.message);
  const r = content?.reactionMessage;
  const chatId = wa.key.remoteJid;
  const targetId = r?.key?.id;
  if (r === null || r === undefined || chatId === null || chatId === undefined || targetId === null || targetId === undefined) return null;
  const ts = seconds(r.senderTimestampMs) || seconds(wa.messageTimestamp) * 1000;
  return { chatId: jidNormalizedUser(chatId), targetId, sender: senderOf(wa.key, chatId), emoji: r.text ?? '', timestamp: ts };
}

/** Réactions portées par un message de l'historique (`WebMessageInfo.reactions`). */
export function reactionsOf(wa: WAMessage): RawReaction[] {
  const chatId = wa.key.remoteJid;
  const targetId = wa.key.id;
  if (chatId === null || chatId === undefined || targetId === null || targetId === undefined) return [];
  return (wa.reactions ?? []).flatMap((r) =>
    r.key === null || r.key === undefined ? [] : [{ chatId: jidNormalizedUser(chatId), targetId, sender: senderOf(r.key, chatId), emoji: r.text ?? '', timestamp: seconds(r.senderTimestampMs) }],
  );
}

export function toMessage(wa: WAMessage): Converted | null {
  const { remoteJid, id } = wa.key;
  if (remoteJid === null || remoteJid === undefined || id === null || id === undefined) return null;
  // statuts (« stories ») : hors périmètre
  if (remoteJid === 'status@broadcast') return null;
  // appel manqué (message technique créé par Baileys) : ligne d'appel
  if (GROUP_CALL_STUBS.has(wa.messageStubType ?? -1)) return null;
  const missed = CALL_STUBS.get(wa.messageStubType ?? -1);
  if (missed !== undefined) {
    return { id, chatId: jidNormalizedUser(remoteJid), fromMe: false, sender: null, senderName: wa.pushName ?? null, timestamp: seconds(wa.messageTimestamp), kind: 'call', text: callText(missed, 'missed'), media: null, quoted: null, status: null };
  }
  // supprimé pour tous (historique) : gardé comme « Ce message a été supprimé »
  if (wa.messageStubType === proto.WebMessageInfo.StubType.REVOKE) {
    const fromMe = wa.key.fromMe === true;
    const participant = wa.key.participant ?? wa.participant ?? null;
    return {
      id,
      chatId: jidNormalizedUser(remoteJid),
      fromMe,
      sender: isJidGroup(remoteJid) === true && participant !== null ? jidNormalizedUser(participant) : null,
      senderName: fromMe ? null : (wa.pushName ?? null),
      timestamp: seconds(wa.messageTimestamp),
      kind: 'other',
      text: '',
      media: null,
      quoted: null,
      status: fromMe ? 'sent' : null,
      deleted: true,
    };
  }
  const content = normalizeMessageContent(wa.message);
  // journal d'appel : champ mal orthographié par WhatsApp, ignoré par getContentType
  const type = content?.callLogMesssage === null || content?.callLogMesssage === undefined ? getContentType(content) : 'callLogMesssage';
  if (content === undefined || type === undefined || HIDDEN.has(type)) return null;

  const extract = EXTRACT[type];
  const fromMe = wa.key.fromMe === true;
  const extracted = extract === undefined ? { kind: 'other' as const, text: '' } : extract(content);
  // appel que j'ai passé (journal du téléphone) : ni manqué ni refusé de mon côté
  const { kind, text } = fromMe && extracted.kind === 'call' ? { kind: 'call' as const, text: callText(content.callLogMesssage?.isVideo === true, 'outgoing') } : extracted;
  const participant = wa.key.participant ?? wa.participant ?? null;
  // liste de diffusion reçue : dans la discussion avec l'expéditeur (comme sur le téléphone)
  const broadcast = isReceivedBroadcast(remoteJid, fromMe) && participant !== null;
  return {
    id,
    chatId: jidNormalizedUser(broadcast ? participant : remoteJid),
    fromMe,
    sender: isJidGroup(remoteJid) === true && participant !== null ? jidNormalizedUser(participant) : null,
    senderName: fromMe ? null : (wa.pushName ?? null),
    timestamp: seconds(wa.messageTimestamp),
    kind,
    text,
    media: mediaOf(content),
    quoted: quotedOf(content),
    forwarded: forwardedOf(content),
    viewOnce: viewOnceOf(wa.message, content),
    // gardé dans la discussion (« garder ») : ne disparaît pas
    expiration: isKept(wa.keepInChat?.keepType) ? 0 : expirationOf(content),
    // « en attente » : seulement pour un envoi de l'app (voir WhatsApp.#sent) ; un message envoyé
    // depuis un autre appareil est déjà parti
    status: fromMe ? (statusOf(wa.status) === 'pending' || statusOf(wa.status) === null ? 'sent' : statusOf(wa.status)) : null,
  };
}
