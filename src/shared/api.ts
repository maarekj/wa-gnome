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
});
export type Chat = z.infer<typeof Chat>;

export const MessageKind = z.enum(['text', 'image', 'video', 'audio', 'document', 'sticker', 'location', 'contact', 'reaction', 'other']);
export type MessageKind = z.infer<typeof MessageKind>;

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
});
export type Message = z.infer<typeof Message>;

export const SendBody = z.object({ text: z.string().check(z.minLength(1)) });
export type SendBody = z.infer<typeof SendBody>;

/** Événements du flux `GET /events` (une ligne `data:` JSON par événement). */
export const Event = z.discriminatedUnion('type', [
  z.object({ type: z.literal('status'), status: Status }),
  z.object({ type: z.literal('chats'), chats: z.array(Chat) }),
  z.object({ type: z.literal('chats.delete'), ids: z.array(z.string()) }),
  z.object({ type: z.literal('message'), message: Message }),
]);
export type Event = z.infer<typeof Event>;

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
