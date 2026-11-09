// Contrat HTTP + SSE entre le démon (Node, Baileys) et l'application (GJS).
// Sans dépendance à Node ni à GJS : importé des deux côtés.
import * as z from 'zod/mini';

/** Port local par défaut du démon (surchargé par WA_GNOME_PORT / WA_GNOME_URL). */
export const DEFAULT_PORT = 4180;

/** Jeton d'accès, dans le dossier de données du démon (lu par l'app). */
export const TOKEN_FILE = 'token';

export const ConnectionState = z.enum([
  /** démarrage, session pas encore chargée */
  'starting',
  /** appareil non appairé : QR code à scanner */
  'qr',
  'connecting',
  'open',
  /** déconnecté depuis le téléphone : session effacée, nouvel appairage nécessaire */
  'logged-out',
  /** connexion perdue, reconnexion automatique en cours */
  'closed',
]);
export type ConnectionState = z.infer<typeof ConnectionState>;

export const Me = z.object({ id: z.string(), name: z.nullable(z.string()) });
export type Me = z.infer<typeof Me>;

export const Status = z.object({
  state: ConnectionState,
  /** contenu du QR code d'appairage (état `qr`) */
  qr: z.nullable(z.string()),
  me: z.nullable(Me),
  /** message de la dernière erreur de connexion */
  error: z.nullable(z.string()),
});
export type Status = z.infer<typeof Status>;

export const Chat = z.object({
  /** JID WhatsApp (`…@s.whatsapp.net`, `…@g.us`, `…@lid`) */
  id: z.string(),
  name: z.string(),
  group: z.boolean(),
  unread: z.number(),
  /** horodatage du dernier message (secondes), 0 si inconnu */
  timestamp: z.number(),
  /** aperçu du dernier message */
  preview: z.string(),
  /** archivée : absente de la liste principale */
  archived: z.boolean(),
  /** mode silencieux jusqu'à (ms depuis l'époque) ; 0 : non ; -1 : toujours */
  mutedUntil: z.number(),
  /** épinglée en tête de liste : date de l'épinglage (ms), 0 sinon */
  pinned: z.number(),
  /** marquée comme non lue (pastille sans nombre) */
  markedUnread: z.boolean(),
  /** listes (étiquettes) de la discussion */
  labels: z.array(z.string()),
  /** dans les favoris */
  favorite: z.boolean(),
});
export type Chat = z.infer<typeof Chat>;

/** Genre d'une liste de WhatsApp (proto.SyncActionValue.LabelEditAction.ListType). */
export const ListKind = z.enum(['unread', 'groups', 'favorites', 'custom', 'other']);
export type ListKind = z.infer<typeof ListKind>;
const LIST_KINDS: Readonly<Record<number, ListKind>> = { 0: 'custom', 1: 'unread', 2: 'groups', 3: 'favorites', 5: 'custom' };
export const listKind = (t: number): ListKind => LIST_KINDS[t] ?? 'other';

/** Liste de discussions (« Ajouter à la liste ») ; `GET /lists`. */
export const ChatList = z.object({ id: z.string(), name: z.string(), color: z.number(), kind: ListKind });
export type ChatList = z.infer<typeof ChatList>;

/** Mode silencieux actif à l'instant `now` (ms). */
export const isMuted = (c: Pick<Chat, 'mutedUntil'>, now = Date.now()): boolean => c.mutedUntil === -1 || c.mutedUntil > now;

/** Épinglées au plus (limite de WhatsApp). */
export const MAX_PINNED = 3;

/** Action sur une discussion (`POST /chats/:id/action`). */
export const ChatAction = z.discriminatedUnion('action', [
  z.object({ action: z.literal('archive'), value: z.boolean() }),
  /** `until` : fin du silence (ms), -1 toujours, null pour réactiver les notifications */
  z.object({ action: z.literal('mute'), until: z.nullable(z.number()) }),
  z.object({ action: z.literal('pin'), value: z.boolean() }),
  z.object({ action: z.literal('unread'), value: z.boolean() }),
  /** effacer les messages, garder la discussion */
  z.object({ action: z.literal('clear') }),
  /** supprimer la discussion */
  z.object({ action: z.literal('delete') }),
  /** quitter le groupe */
  z.object({ action: z.literal('leave') }),
  z.object({ action: z.literal('favorite'), value: z.boolean() }),
  /** ajouter à / retirer d'une liste personnalisée */
  z.object({ action: z.literal('label'), labelId: z.string(), value: z.boolean() }),
]);
export type ChatAction = z.infer<typeof ChatAction>;

export const MessageKind = z.enum(['text', 'image', 'video', 'audio', 'document', 'sticker', 'location', 'contact', 'reaction', 'other']);
export type MessageKind = z.infer<typeof MessageKind>;

/** Média joint à un message (contenu téléchargé à la demande : `GET …/messages/:mid/media`). */
export const Media = z.object({
  mimetype: z.string(),
  /** dimensions en pixels (images, vidéos, autocollants), null si inconnues */
  width: z.nullable(z.number()),
  height: z.nullable(z.number()),
  /** miniature JPEG ou PNG en base64, affichée en attendant le média complet */
  thumbnail: z.nullable(z.string()),
  fileName: z.nullable(z.string()),
  /** taille en octets */
  size: z.nullable(z.number()),
  /** durée en secondes (audio, vidéo) */
  seconds: z.nullable(z.number()),
  /** forme d'onde d'un vocal (valeurs de 0 à 100), absente des autres médias */
  waveform: z.optional(z.nullable(z.array(z.number()))),
});
export type Media = z.infer<typeof Media>;

/** Message cité par une réponse (aperçu ; le message lui-même n'est pas forcément chargé). */
export const Quoted = z.object({
  id: z.string(),
  fromMe: z.boolean(),
  /** auteur (JID), null si inconnu */
  sender: z.nullable(z.string()),
  /** nom affiché de l'auteur (résolu par le démon) */
  senderName: z.nullable(z.string()),
  kind: MessageKind,
  text: z.string(),
});
export type Quoted = z.infer<typeof Quoted>;

/** Réaction groupée par émoji sous un message. */
export const Reaction = z.object({
  emoji: z.string(),
  count: z.number(),
  /** j'ai réagi avec cet émoji */
  mine: z.boolean(),
  /** personnes, dans l'ordre de leurs réactions ; `id` null pour moi */
  people: z.array(z.object({ id: z.nullable(z.string()), name: z.string() })),
});
export type Reaction = z.infer<typeof Reaction>;

/** Émojis proposés pour réagir (comme WhatsApp). */
export const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'] as const;

export const ReactBody = z.object({ emoji: z.string() });

/** État d'un message envoyé : en attente, envoyé (1 coche), reçu (2 coches), lu / écouté (2 coches bleues). */
export const MessageStatus = z.enum(['error', 'pending', 'sent', 'delivered', 'read', 'played']);
export type MessageStatus = z.infer<typeof MessageStatus>;

/** proto.WebMessageInfo.Status (nombre, ou nom dans l'historique) → état ; null si inconnu. */
export function statusOf(s: unknown): MessageStatus | null {
  const byNumber: readonly MessageStatus[] = ['error', 'pending', 'sent', 'delivered', 'read', 'played'];
  const byName: Readonly<Record<string, MessageStatus>> = { ERROR: 'error', PENDING: 'pending', SERVER_ACK: 'sent', DELIVERY_ACK: 'delivered', READ: 'read', PLAYED: 'played' };
  if (typeof s === 'number') return byNumber[s] ?? null;
  if (typeof s === 'string') return byName[s] ?? null;
  return null;
}

/** « En attente » depuis plus longtemps que ce délai : état périmé de l'historique, considéré envoyé. */
export const PENDING_STALE_S = 10 * 60;

/** État affiché d'un message envoyé à `timestamp` (secondes). */
export const effectiveStatus = (s: MessageStatus, timestamp: number, now = Date.now() / 1000): MessageStatus => (s === 'pending' && now - timestamp > PENDING_STALE_S ? 'sent' : s);

/** Rang d'un état : un état n'est jamais remplacé par un moins avancé (accusés dans le désordre). */
export const statusRank = (s: MessageStatus): number => ['pending', 'sent', 'delivered', 'read', 'played', 'error'].indexOf(s);

/** Accusés d'un destinataire (secondes, null : pas encore). */
export const Receipt = z.object({
  id: z.string(),
  name: z.string(),
  delivered: z.nullable(z.number()),
  read: z.nullable(z.number()),
  played: z.nullable(z.number()),
});
export type Receipt = z.infer<typeof Receipt>;

/** Infos d'un message envoyé (`GET /chats/:id/messages/:mid/info`). */
export const MessageInfo = z.object({ receipts: z.array(Receipt) });
export type MessageInfo = z.infer<typeof MessageInfo>;

export const Message = z.object({
  id: z.string(),
  chatId: z.string(),
  fromMe: z.boolean(),
  /** JID de l'auteur dans un groupe, null en discussion directe */
  sender: z.nullable(z.string()),
  senderName: z.nullable(z.string()),
  /** secondes */
  timestamp: z.number(),
  kind: MessageKind,
  /** texte ou légende (vide pour un média sans légende) */
  text: z.string(),
  media: z.nullable(Media),
  /** message auquel celui-ci répond */
  quoted: z.nullable(Quoted),
  reactions: z.array(Reaction),
  /** messages envoyés seulement */
  status: z.nullable(MessageStatus),
  /** modifié par son auteur (texte ou légende) */
  edited: z.boolean(),
  /** supprimé pour tous : contenu effacé, « Ce message a été supprimé » */
  deleted: z.boolean(),
  /** transféré : nombre de transferts successifs (WhatsApp : « à plusieurs reprises » dès 5), 0 sinon */
  forwarded: z.number(),
});

/** Texte affiché à la place d'un message supprimé pour tous. */
export const DELETED_TEXT = 'Ce message a été supprimé';

/** Délais de WhatsApp : modification 15 min, suppression pour tous environ 2 jours (secondes). */
export const EDIT_WINDOW_S = 15 * 60;
export const REVOKE_WINDOW_S = 2 * 24 * 3600;

/** Genres modifiables : texte, et légende d'une photo, d'une vidéo ou d'un document (comme WhatsApp). */
export const EDITABLE_KINDS: readonly MessageKind[] = ['text', 'image', 'video', 'document'];

/**
 * Modification d'un message : possible, impossible (pas le mien, genre non modifiable, supprimé)
 * ou trop tard (délai de WhatsApp dépassé).
 */
export function editability(m: Pick<Message, 'fromMe' | 'kind' | 'deleted' | 'timestamp'>, now = Date.now() / 1000): 'yes' | 'no' | 'late' {
  if (!m.fromMe || m.deleted || !EDITABLE_KINDS.includes(m.kind)) return 'no';
  return now - m.timestamp < EDIT_WINDOW_S ? 'yes' : 'late';
}

/** Action sur un message (`POST /chats/:id/messages/:mid/action`). */
export const MessageAction = z.discriminatedUnion('action', [
  z.object({ action: z.literal('edit'), text: z.string().check(z.minLength(1)) }),
  /** supprimer pour tous (mes messages) */
  z.object({ action: z.literal('revoke') }),
  /** supprimer pour moi (localement et sur mes appareils) */
  z.object({ action: z.literal('delete-for-me') }),
  /** transférer vers ces discussions */
  z.object({ action: z.literal('forward'), to: z.array(z.string()).check(z.minLength(1)) }),
]);
export type MessageAction = z.infer<typeof MessageAction>;
export type Message = z.infer<typeof Message>;

/** Participant d'un groupe (fiche du groupe). */
export const Participant = z.object({
  id: z.string(),
  name: z.string(),
  admin: z.nullable(z.enum(['admin', 'superadmin'])),
  me: z.boolean(),
});
export type Participant = z.infer<typeof Participant>;

/** Fiche d'un contact ou d'un groupe (`GET /chats/:id/info`). */
export const ChatInfo = z.object({
  id: z.string(),
  name: z.string(),
  group: z.boolean(),
  /** numéro (chiffres), contact seulement */
  phone: z.nullable(z.string()),
  /** nom public choisi par la personne (« pushName ») */
  publicName: z.nullable(z.string()),
  /** « À propos » du contact, et sa date (secondes) */
  about: z.nullable(z.string()),
  aboutAt: z.nullable(z.number()),
  /** description et création du groupe (secondes) */
  description: z.nullable(z.string()),
  created: z.nullable(z.number()),
  participants: z.array(Participant),
  /** groupes en commun (contact seulement) */
  commonGroups: z.array(z.object({ id: z.string(), name: z.string(), size: z.number() })),
});
export type ChatInfo = z.infer<typeof ChatInfo>;

/** Onglets de la galerie des médias : genres de messages qu'ils regroupent. */
export const GALLERY_KINDS = {
  visual: ['image', 'video'],
  document: ['document'],
  audio: ['audio'],
} as const satisfies Record<string, readonly MessageKind[]>;
export type GalleryTab = keyof typeof GALLERY_KINDS;
export const isGalleryTab = (s: string | null): s is GalleryTab => s !== null && Object.hasOwn(GALLERY_KINDS, s);

/** Marqueurs des mots trouvés dans l'extrait d'un résultat de recherche. */
export const HIT_START = '\u0001';
export const HIT_END = '\u0002';

/** Message trouvé par la recherche (`GET /search?q=`). */
export const SearchHit = z.object({
  chatId: z.string(),
  chatName: z.string(),
  id: z.string(),
  timestamp: z.number(),
  fromMe: z.boolean(),
  /** auteur dans un groupe (null : discussion directe ou moi) */
  senderName: z.nullable(z.string()),
  /** extrait du texte, mots trouvés entre HIT_START et HIT_END */
  snippet: z.string(),
});
export type SearchHit = z.infer<typeof SearchHit>;

/** Contact du carnet (nouvelle discussion). */
export const Contact = z.object({
  /** JID (`…@s.whatsapp.net`) */
  id: z.string(),
  name: z.string(),
});
export type Contact = z.infer<typeof Contact>;

/** Numéro vérifié sur WhatsApp (`GET /lookup?phone=`) : JID, ou null s'il n'a pas de compte. */
export const Lookup = z.object({ id: z.nullable(z.string()) });

/** Chiffres d'un numéro saisi (`+33 6 12-34`), ou null s'il n'en a pas assez pour en être un. */
export function phoneDigits(text: string): string | null {
  const t = text.trim();
  if (!/^\+?[\d\s().-]+$/u.test(t)) return null;
  const digits = t.replaceAll(/\D/gu, '');
  return digits.length >= 8 && digits.length <= 15 ? digits : null;
}

export const SendBody = z.object({
  text: z.string().check(z.minLength(1)),
  /** réponse à ce message (identifiant dans la même discussion) */
  replyTo: z.optional(z.string()),
});

/** Taille maximale d'un fichier envoyé (limite de WhatsApp pour les documents : 2 Go ; ici raisonnable). */
export const MAX_UPLOAD = 100 * 1024 * 1024;

/**
 * Envoi d'un fichier (`POST /chats/:id/media`) : contenu brut dans le corps, type dans
 * `Content-Type`, métadonnées dans ces en-têtes (valeurs encodées avec encodeURIComponent).
 */
export const UPLOAD_NAME = 'X-WA-File-Name';
export const UPLOAD_CAPTION = 'X-WA-Caption';
/** `document` : envoyé comme fichier même si c'est une image ou une vidéo */
export const UPLOAD_AS = 'X-WA-Send-As';
/** réponse à ce message (identifiant) */
export const UPLOAD_REPLY = 'X-WA-Reply-To';
/** message vocal : durée (secondes) et forme d'onde (64 valeurs de 0 à 100, base64) */
export const UPLOAD_VOICE_SECONDS = 'X-WA-Voice-Seconds';
export const UPLOAD_VOICE_WAVEFORM = 'X-WA-Voice-Waveform';

/** Forme d'onde d'un vocal (WhatsApp : 64 valeurs de 0 à 100) à partir de niveaux en dB (≤ 0). */
export function waveform(levelsDb: readonly number[], size = 64): number[] {
  if (levelsDb.length === 0) return Array.from({ length: size }, () => 0);
  const norm = levelsDb.map((db) => Math.round(Math.max(0, Math.min(1, (db + 50) / 50)) * 100));
  return Array.from({ length: size }, (_, i) => {
    const from = Math.floor((i * norm.length) / size);
    const to = Math.max(from + 1, Math.floor(((i + 1) * norm.length) / size));
    const part = norm.slice(from, to);
    return Math.max(...part);
  });
}

/** Genre d'envoi selon le type MIME (comme WhatsApp : image, vidéo, audio, sinon document). */
export function uploadKind(mimetype: string, asDocument = false): 'image' | 'video' | 'audio' | 'document' {
  if (asDocument) return 'document';
  // GIF et SVG : pas des photos pour WhatsApp
  if (/^image\/(jpeg|png|webp)$/u.test(mimetype)) return 'image';
  if (/^video\/(mp4|3gpp|quicktime)$/u.test(mimetype)) return 'video';
  if (mimetype.startsWith('audio/')) return 'audio';
  return 'document';
}
export type SendBody = z.infer<typeof SendBody>;

/** Présence d'une discussion : en ligne / vu (discussion directe), personnes en train d'écrire. */
export const Presence = z.object({
  online: z.boolean(),
  /** dernière connexion (secondes), si la personne la partage */
  lastSeen: z.nullable(z.number()),
  /** en train d'écrire ou d'enregistrer : noms (groupe) ou l'autre personne */
  typing: z.array(z.object({ name: z.string(), recording: z.boolean() })),
});
export type Presence = z.infer<typeof Presence>;

/** Ma présence (`POST /presence`) : en ligne quand la fenêtre a le focus, comme WhatsApp Web. */
export const PresenceBody = z.object({ online: z.boolean() });
/** Ma saisie dans une discussion (`POST /chats/:id/typing`). */
export const TypingBody = z.object({ state: z.enum(['composing', 'recording', 'paused']) });

/** Événements du flux `GET /events` (une ligne `data:` JSON par événement). */
export const Event = z.discriminatedUnion('type', [
  z.object({ type: z.literal('status'), status: Status }),
  z.object({ type: z.literal('chats'), chats: z.array(Chat) }),
  z.object({ type: z.literal('chats.delete'), ids: z.array(z.string()) }),
  /** messages d'une discussion effacés */
  z.object({ type: z.literal('chat.cleared'), id: z.string() }),
  /** photo de profil changée ou retirée : à recharger */
  z.object({ type: z.literal('picture'), id: z.string() }),
  /** message supprimé pour moi : retiré de la discussion */
  z.object({ type: z.literal('message.delete'), chatId: z.string(), id: z.string() }),
  /** message modifié (réactions…) : remplace celui affiché, sans notification */
  z.object({ type: z.literal('message.update'), message: Message }),
  /** historique plus ancien reçu du téléphone (demande `POST /chats/:id/history`) */
  z.object({ type: z.literal('history'), ids: z.array(z.string()) }),
  /** présence d'une discussion suivie (`POST /chats/:id/subscribe`) */
  z.object({ type: z.literal('presence'), chatId: z.string(), presence: Presence }),
  /** listes modifiées (liste complète) */
  z.object({ type: z.literal('lists'), lists: z.array(ChatList) }),
  z.object({ type: z.literal('message'), message: Message }),
]);
export type Event = z.infer<typeof Event>;

/** Chiffres découpés en blocs de tailles données (le reste en dernier bloc). */
function groups(s: string, sizes: readonly number[]): string {
  const out: string[] = [];
  let i = 0;
  for (const n of sizes) {
    out.push(s.slice(i, i + n));
    i += n;
  }
  return [...out, s.slice(i)].filter((g) => g !== '').join(' ');
}

/**
 * Numéro international lisible (`33612345678` → `+33 6 12 34 56 78`) pour quelques pays
 * courants ; les autres restent groupés en un bloc après l'indicatif présumé.
 */
export function formatPhone(digits: string): string {
  const d = digits.replaceAll(/\D/gu, '');
  if (d.startsWith('33') && d.length === 11) return `+33 ${groups(d.slice(2), [1, 2, 2, 2, 2])}`;
  if (d.startsWith('972') && d.length === 12) return `+972 ${groups(d.slice(3), [2, 3, 4])}`;
  if (d.startsWith('1') && d.length === 11) return `+1 ${groups(d.slice(1), [3, 3, 4])}`;
  if (d.startsWith('44') && d.length === 12) return `+44 ${groups(d.slice(2), [4, 6])}`;
  return `+${d}`;
}

/** Texte court d'un message pour la liste des discussions. */
export function previewOf(m: Pick<Message, 'kind' | 'text'>): string {
  const label: Record<MessageKind, string> = {
    text: '',
    image: 'Photo',
    video: 'Vidéo',
    audio: 'Audio',
    document: 'Document',
    sticker: 'Autocollant',
    location: 'Position',
    contact: 'Contact',
    reaction: 'Réaction',
    other: 'Message',
  };
  if (m.text !== '') return m.kind === 'text' ? m.text : `${label[m.kind]} · ${m.text}`;
  return label[m.kind];
}
