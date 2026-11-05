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
});
export type Chat = z.infer<typeof Chat>;

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
});
export type Media = z.infer<typeof Media>;

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
});
export type Message = z.infer<typeof Message>;

export const SendBody = z.object({ text: z.string().check(z.minLength(1)) });
export type SendBody = z.infer<typeof SendBody>;

/** Événements du flux `GET /events` (une ligne `data:` JSON par événement). */
export const Event = z.discriminatedUnion('type', [
  z.object({ type: z.literal('status'), status: Status }),
  z.object({ type: z.literal('chats'), chats: z.array(Chat) }),
  z.object({ type: z.literal('chats.delete'), ids: z.array(z.string()) }),
  /** messages d'une discussion effacés */
  z.object({ type: z.literal('chat.cleared'), id: z.string() }),
  /** photo de profil changée ou retirée : à recharger */
  z.object({ type: z.literal('picture'), id: z.string() }),
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
