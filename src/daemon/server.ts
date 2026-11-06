// API HTTP + SSE locale du démon, consommée par l'application GJS.
//   GET  /status                    état de la connexion (QR code d'appairage)
//   GET  /chats                     discussions, la plus récente d'abord
//   GET  /lists                     listes (favoris, listes personnalisées)
//   GET  /chats/:id/messages        derniers messages (?limit, ?before en secondes)
//   POST /chats/:id/messages        envoi d'un texte { text }
//   GET  /chats/:id/messages/:mid/media  contenu d'un média (octets, Content-Type du média)
//   POST /chats/:id/media           envoi d'un fichier (corps brut, voir shared/api.ts)
//   GET  /chats/:id/picture         photo de profil (JPEG), 404 sans photo
//   GET  /chats/:id/messages/:mid/info   infos d'un message envoyé (accusés par destinataire)
//   POST /chats/:id/messages/:mid/action  modifier, supprimer pour tous, supprimer pour moi
//   POST /chats/:id/messages/:mid/react  réaction { emoji } (vide : retirée)
//   POST /chats/:id/history         messages plus anciens demandés au téléphone (arrivent par l'événement `history`)
//   POST /chats/:id/read            discussion lue
//   POST /chats/:id/action          archiver, silencieux, épingler, non lue, effacer, supprimer, quitter
//   POST /chats/:id/subscribe       suit la présence de la discussion ; renvoie la présence connue
//   POST /chats/:id/typing          ma saisie { state }
//   POST /presence                  ma présence { online }
//   POST /logout                    déconnexion du compte
//   GET  /events                    flux SSE des événements (voir shared/api.ts)
// Toutes les routes demandent `Authorization: Bearer <jeton>` (fichier `token` du dossier de données).
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import * as z from 'zod/mini';
import { ChatAction, type Event, MAX_UPLOAD, MessageAction, type MessageInfo, type Presence, PresenceBody, ReactBody, TypingBody, SendBody, type Status, UPLOAD_AS, UPLOAD_CAPTION, UPLOAD_NAME, UPLOAD_REPLY } from '../shared/api.ts';
import type { Store } from './store.ts';

/** Commentaire SSE périodique : garde la connexion ouverte, détecte un client parti. */
const HEARTBEAT_MS = 10_000;
const MAX_BODY = 1024 * 1024;

/** Connexion WhatsApp vue par l'API (le vrai Baileys, ou un faux pour les tests et captures). */
export interface Backend {
  readonly status: Status;
  send: (chatId: string, text: string, replyTo?: string) => Promise<void>;
  markRead: (chatId: string) => Promise<void>;
  chatAction: (chatId: string, action: ChatAction) => Promise<void>;
  /** photo de profil, null sans photo */
  picture: (chatId: string) => Promise<Buffer | null>;
  logout: () => Promise<void>;
  media: (chatId: string, id: string) => Promise<{ mimetype: string; data: Buffer }>;
  sendMedia: (chatId: string, file: Upload) => Promise<void>;
  /** demande au téléphone les messages antérieurs au plus ancien connu ; false s'il n'y a rien à demander */
  requestHistory: (chatId: string) => Promise<boolean>;
  react: (chatId: string, messageId: string, emoji: string) => Promise<void>;
  messageInfo: (chatId: string, messageId: string) => MessageInfo;
  messageAction: (chatId: string, messageId: string, action: MessageAction) => Promise<void>;
  subscribe: (chatId: string) => Promise<Presence>;
  setOnline: (online: boolean) => Promise<void>;
  typing: (chatId: string, state: 'composing' | 'recording' | 'paused') => Promise<void>;
}

/** Fichier à envoyer. */
export interface Upload {
  data: Buffer;
  mimetype: string;
  fileName: string;
  caption: string;
  asDocument: boolean;
  /** réponse à ce message */
  replyTo?: string;
}

export interface Server {
  emit: (e: Event) => void;
  close: () => Promise<void>;
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const readRaw = async (req: http.IncomingMessage, max: number): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    if (!Buffer.isBuffer(chunk)) throw new HttpError(400, 'corps invalide');
    size += chunk.length;
    if (size > max) throw new HttpError(413, 'corps trop volumineux');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
};

/** En-tête encodé (encodeURIComponent), vide s'il est absent ou mal formé. */
const header = (req: http.IncomingMessage, name: string): string => {
  const v = req.headers[name.toLowerCase()];
  try {
    return typeof v === 'string' ? decodeURIComponent(v) : '';
  } catch {
    return '';
  }
};

const readBody = async (req: http.IncomingMessage): Promise<unknown> => {
  const raw = await readRaw(req, MAX_BODY);
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw new HttpError(400, 'JSON invalide');
  }
};

const json = (res: http.ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

export function startServer(opts: { host: string; port: number; token: string; store: Store; wa: () => Backend }): Promise<Server> {
  const clients = new Set<http.ServerResponse>();
  const expected = Buffer.from(`Bearer ${opts.token}`);
  const authorized = (req: http.IncomingMessage): boolean => {
    const got = Buffer.from(req.headers.authorization ?? '');
    return got.length === expected.length && timingSafeEqual(got, expected);
  };

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    if (!authorized(req)) throw new HttpError(401, 'jeton invalide');
    const url = new URL(req.url ?? '/', 'http://localhost');
    const parts = url.pathname.split('/').filter((p) => p !== '').map((p) => decodeURIComponent(p));
    // segments variables : /chats/:id/messages/:mid
    const route = `${req.method ?? 'GET'} /${parts.map((p, i) => (parts[0] === 'chats' && (i === 1 || (i === 3 && parts[2] === 'messages')) ? (i === 1 ? ':id' : ':mid') : p)).join('/')}`;
    const chatId = parts[1] ?? '';
    const messageId = parts[3] ?? '';
    switch (route) {
      case 'GET /status':
        json(res, 200, opts.wa().status);
        return;
      case 'GET /lists':
        json(res, 200, opts.store.lists());
        return;
      case 'GET /chats':
        json(res, 200, opts.store.chats());
        return;
      case 'GET /chats/:id/messages': {
        const limit = Math.min(Number(url.searchParams.get('limit') ?? 50) || 50, 500);
        const before = url.searchParams.get('before');
        json(res, 200, opts.store.messages(chatId, limit, before === null ? undefined : Number(before)));
        return;
      }
      case 'POST /chats/:id/messages': {
        const body = SendBody.safeParse(await readBody(req));
        if (!body.success) throw new HttpError(400, z.prettifyError(body.error));
        await opts.wa().send(chatId, body.data.text, body.data.replyTo);
        json(res, 200, {});
        return;
      }
      case 'GET /chats/:id/messages/:mid/media': {
        const { mimetype, data } = await opts.wa().media(chatId, messageId);
        res.writeHead(200, { 'Content-Type': mimetype, 'Content-Length': data.length, 'Cache-Control': 'private, max-age=31536000, immutable' });
        res.end(data);
        return;
      }
      case 'GET /chats/:id/picture': {
        const data = await opts.wa().picture(chatId);
        if (data === null) throw new HttpError(404, 'pas de photo');
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': data.length, 'Cache-Control': 'private, no-cache' });
        res.end(data);
        return;
      }
      case 'POST /chats/:id/media': {
        const data = await readRaw(req, MAX_UPLOAD);
        if (data.length === 0) throw new HttpError(400, 'fichier vide');
        const mimetype = (req.headers['content-type'] ?? 'application/octet-stream').split(';')[0]?.trim() ?? 'application/octet-stream';
        await opts.wa().sendMedia(chatId, { data, mimetype, fileName: header(req, UPLOAD_NAME) || 'fichier', caption: header(req, UPLOAD_CAPTION), asDocument: header(req, UPLOAD_AS) === 'document', replyTo: header(req, UPLOAD_REPLY) });
        json(res, 200, {});
        return;
      }
      case 'GET /chats/:id/messages/:mid/info':
        json(res, 200, opts.wa().messageInfo(chatId, messageId));
        return;
      case 'POST /chats/:id/messages/:mid/action': {
        const body = MessageAction.safeParse(await readBody(req));
        if (!body.success) throw new HttpError(400, z.prettifyError(body.error));
        await opts.wa().messageAction(chatId, messageId, body.data);
        json(res, 200, {});
        return;
      }
      case 'POST /chats/:id/messages/:mid/react': {
        const body = ReactBody.safeParse(await readBody(req));
        if (!body.success) throw new HttpError(400, z.prettifyError(body.error));
        await opts.wa().react(chatId, messageId, body.data.emoji);
        json(res, 200, {});
        return;
      }
      case 'POST /chats/:id/history':
        json(res, 200, { requested: await opts.wa().requestHistory(chatId) });
        return;
      case 'POST /chats/:id/read':
        await opts.wa().markRead(chatId);
        json(res, 200, {});
        return;
      case 'POST /chats/:id/action': {
        const body = ChatAction.safeParse(await readBody(req));
        if (!body.success) throw new HttpError(400, z.prettifyError(body.error));
        await opts.wa().chatAction(chatId, body.data);
        json(res, 200, {});
        return;
      }
      case 'POST /chats/:id/subscribe':
        json(res, 200, await opts.wa().subscribe(chatId));
        return;
      case 'POST /chats/:id/typing': {
        const body = TypingBody.safeParse(await readBody(req));
        if (!body.success) throw new HttpError(400, z.prettifyError(body.error));
        await opts.wa().typing(chatId, body.data.state);
        json(res, 200, {});
        return;
      }
      case 'POST /presence': {
        const body = PresenceBody.safeParse(await readBody(req));
        if (!body.success) throw new HttpError(400, z.prettifyError(body.error));
        await opts.wa().setOnline(body.data.online);
        json(res, 200, {});
        return;
      }
      case 'POST /logout':
        await opts.wa().logout();
        json(res, 200, {});
        return;
      case 'GET /events': {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        // état courant d'abord : le client n'a pas à le redemander après une reconnexion
        res.write(`data: ${JSON.stringify({ type: 'status', status: opts.wa().status } satisfies Event)}\n\n`);
        clients.add(res);
        req.on('close', () => {
          clients.delete(res);
        });
        return;
      }
      default:
        throw new HttpError(404, `route inconnue : ${route}`);
    }
  };

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      const status = error instanceof HttpError ? error.status : 500;
      if (res.headersSent) res.end();
      else json(res, status, { error: error instanceof Error ? error.message : String(error) });
    });
  });

  const heartbeat = setInterval(() => {
    for (const c of clients) c.write(': ping\n\n');
  }, HEARTBEAT_MS);

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host, () => {
      resolve({
        emit: (e) => {
          const line = `data: ${JSON.stringify(e)}\n\n`;
          for (const c of clients) c.write(line);
        },
        close: async () => {
          clearInterval(heartbeat);
          for (const c of clients) c.end();
          await new Promise<void>((done) => {
            server.close(() => done());
          });
        },
      });
    });
  });
}
