// Stockage local des discussions, contacts et messages (SQLite intégré à Node : node:sqlite).
// Baileys ne garde rien en mémoire : l'historique reçu à l'appairage et les nouveaux messages
// sont écrits ici, l'app ne lit que cette base (via l'API HTTP).
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import * as z from 'zod/mini';
import { type Chat, Media, type Message, MessageKind, previewOf } from '../shared/api.ts';

const SCHEMA = `
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  name TEXT,
  unread INTEGER NOT NULL DEFAULT 0,
  timestamp INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  name TEXT
);
CREATE TABLE IF NOT EXISTS messages (
  chat_id TEXT NOT NULL,
  id TEXT NOT NULL,
  from_me INTEGER NOT NULL,
  sender TEXT,
  sender_name TEXT,
  timestamp INTEGER NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  -- WAMessage complet (BufferJSON) : médias, réponses, renvoi à WhatsApp (getMessage)
  raw TEXT NOT NULL,
  -- Media de l'API (JSON), null sans média
  media TEXT,
  PRIMARY KEY (chat_id, id)
);
CREATE INDEX IF NOT EXISTS messages_by_time ON messages (chat_id, timestamp);
`;

// lignes SQLite validées : la base peut venir d'une version antérieure
const ChatRow = z.object({
  id: z.string(),
  name: z.nullable(z.string()),
  unread: z.number(),
  timestamp: z.number(),
  contact: z.nullable(z.string()),
  last_kind: z.nullable(z.string()),
  last_text: z.nullable(z.string()),
});

const MessageRow = z.object({
  id: z.string(),
  chat_id: z.string(),
  from_me: z.number(),
  sender: z.nullable(z.string()),
  sender_name: z.nullable(z.string()),
  timestamp: z.number(),
  kind: z.string(),
  text: z.string(),
  media: z.nullable(z.string()),
});

/** Média JSON de la base, ignoré s'il est invalide. */
const parseMedia = (json: string | null): Media | null => {
  if (json === null) return null;
  try {
    const parsed = Media.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

/** Version du schéma (PRAGMA user_version) ; migrations ci-dessous. */
const VERSION = 1;

const asKind = (k: string): MessageKind => {
  const parsed = MessageKind.safeParse(k);
  return parsed.success ? parsed.data : 'other';
};

/** Partie « utilisateur » d'un JID, pour l'affichage d'un contact sans nom. */
const userPart = (jid: string): string => {
  const user = jid.split('@')[0] ?? jid;
  return jid.endsWith('@s.whatsapp.net') ? `+${user.split(':')[0] ?? user}` : user;
};

export class Store {
  readonly #db: DatabaseSync;
  /** base créée avant les médias : messages existants à reconvertir depuis `raw` */
  readonly needsMediaBackfill: boolean;

  constructor(file: string) {
    this.#db = new DatabaseSync(file);
    const version = Number(this.#db.prepare('PRAGMA user_version').get()?.['user_version'] ?? 0);
    const fresh = this.#db.prepare("SELECT name FROM sqlite_master WHERE name = 'messages'").get() === undefined;
    this.#db.exec(SCHEMA);
    this.needsMediaBackfill = false;
    if (!fresh && version < 1) {
      this.#db.exec('ALTER TABLE messages ADD COLUMN media TEXT');
      this.needsMediaBackfill = true;
    }
    this.#db.exec(`PRAGMA user_version = ${VERSION}`);
  }

  close(): void {
    this.#db.close();
  }

  // ------------------------------------------------------------------ écriture

  /** Discussion créée ou mise à jour ; les champs absents sont conservés. */
  upsertChat(c: { id: string; name?: string | null; unread?: number | null; timestamp?: number | null }): void {
    this.#db
      .prepare(
        `INSERT INTO chats (id, name, unread, timestamp) VALUES (:id, :name, coalesce(:unread, 0), coalesce(:timestamp, 0))
         ON CONFLICT (id) DO UPDATE SET
           name = coalesce(excluded.name, chats.name),
           unread = coalesce(:unread, chats.unread),
           timestamp = max(chats.timestamp, excluded.timestamp)`,
      )
      .run({ id: c.id, name: c.name ?? null, unread: c.unread ?? null, timestamp: c.timestamp ?? null });
  }

  deleteChats(ids: readonly string[]): void {
    const del = this.#db.prepare('DELETE FROM chats WHERE id = ?');
    const msgs = this.#db.prepare('DELETE FROM messages WHERE chat_id = ?');
    for (const id of ids) {
      del.run(id);
      msgs.run(id);
    }
  }

  upsertContact(id: string, name: string | null): void {
    if (name === null || name === '') return;
    this.#db.prepare('INSERT INTO contacts (id, name) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET name = excluded.name').run(id, name);
  }

  /** Message enregistré (remplacé s'il existe) ; la discussion est créée au besoin. */
  upsertMessage(m: Message, raw: string): void {
    this.#db
      .prepare(
        `INSERT OR REPLACE INTO messages (chat_id, id, from_me, sender, sender_name, timestamp, kind, text, raw, media)
         VALUES (:chat_id, :id, :from_me, :sender, :sender_name, :timestamp, :kind, :text, :raw, :media)`,
      )
      .run({ chat_id: m.chatId, id: m.id, from_me: m.fromMe ? 1 : 0, sender: m.sender, sender_name: m.senderName, timestamp: m.timestamp, kind: m.kind, text: m.text, raw, media: m.media === null ? null : JSON.stringify(m.media) });
    this.upsertChat({ id: m.chatId, timestamp: m.timestamp });
  }

  incrementUnread(chatId: string): void {
    this.#db.prepare('UPDATE chats SET unread = unread + 1 WHERE id = ?').run(chatId);
  }

  markRead(chatId: string): void {
    this.#db.prepare('UPDATE chats SET unread = 0 WHERE id = ?').run(chatId);
  }

  /** Tout effacer (déconnexion du compte). */
  clear(): void {
    this.#db.exec('DELETE FROM messages; DELETE FROM chats; DELETE FROM contacts;');
  }

  /** Plusieurs écritures dans une transaction (synchronisation de l'historique). */
  transaction(fn: () => void): void {
    this.#db.exec('BEGIN');
    try {
      fn();
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  // ------------------------------------------------------------------ lecture

  #chats(where: string, params: SQLInputValue[]): Chat[] {
    const rows = this.#db
      .prepare(
        `SELECT c.id, c.name, c.unread, c.timestamp, ct.name AS contact,
                m.kind AS last_kind, m.text AS last_text
         FROM chats c
         LEFT JOIN contacts ct ON ct.id = c.id
         LEFT JOIN messages m ON m.rowid = (
           SELECT rowid FROM messages WHERE chat_id = c.id ORDER BY timestamp DESC LIMIT 1)
         ${where}
         ORDER BY c.timestamp DESC`,
      )
      .all(...params)
      .map((r) => z.parse(ChatRow, r));
    return rows.map((r) => ({
      id: r.id,
      name: r.name ?? r.contact ?? userPart(r.id),
      group: r.id.endsWith('@g.us'),
      unread: r.unread,
      timestamp: r.timestamp,
      preview: r.last_kind === null ? '' : previewOf({ kind: asKind(r.last_kind), text: r.last_text ?? '' }),
    }));
  }

  chats(): Chat[] {
    // discussions sans message ni date (contacts du carnet synchronisés) : masquées
    return this.#chats('WHERE c.timestamp > 0', []);
  }

  chat(id: string): Chat | null {
    return this.#chats('WHERE c.id = ?', [id])[0] ?? null;
  }

  /** Derniers messages d'une discussion avant `before` (secondes), ordre chronologique. */
  messages(chatId: string, limit: number, before?: number): Message[] {
    const rows = this.#db
      .prepare(
        `SELECT m.*, coalesce(m.sender_name, ct.name) AS sender_name FROM messages m
         LEFT JOIN contacts ct ON ct.id = m.sender
         WHERE m.chat_id = ? AND m.timestamp < ? ORDER BY m.timestamp DESC LIMIT ?`,
      )
      .all(chatId, before ?? Number.MAX_SAFE_INTEGER, limit)
      .map((r) => z.parse(MessageRow, r));
    return rows.toReversed().map((r) => ({
      id: r.id,
      chatId: r.chat_id,
      fromMe: r.from_me === 1,
      sender: r.sender,
      senderName: r.sender_name,
      timestamp: r.timestamp,
      kind: asKind(r.kind),
      text: r.text,
      media: parseMedia(r.media),
    }));
  }

  /** Média d'un message, ou null. */
  media(chatId: string, id: string): Media | null {
    const row = this.#db.prepare('SELECT media FROM messages WHERE chat_id = ? AND id = ?').get(chatId, id);
    return typeof row?.['media'] === 'string' ? parseMedia(row['media']) : null;
  }

  /** Messages média sans `media` (base antérieure) : WAMessage brut à reconvertir. */
  mediaToBackfill(): { chatId: string; id: string; raw: string }[] {
    // lu en entier avant les mises à jour (pas d'écriture pendant un parcours)
    return this.#db
      .prepare("SELECT chat_id, id, raw FROM messages WHERE media IS NULL AND kind IN ('image', 'video', 'audio', 'document', 'sticker')")
      .all()
      .flatMap((r) => (typeof r['chat_id'] === 'string' && typeof r['id'] === 'string' && typeof r['raw'] === 'string' ? [{ chatId: r['chat_id'], id: r['id'], raw: r['raw'] }] : []));
  }

  setMedia(chatId: string, id: string, media: Media | null): void {
    this.#db.prepare('UPDATE messages SET media = ? WHERE chat_id = ? AND id = ?').run(media === null ? null : JSON.stringify(media), chatId, id);
  }

  /** WAMessage brut (BufferJSON), pour `getMessage` de Baileys (renvoi des messages). */
  raw(chatId: string, id: string): string | null {
    const row = this.#db.prepare('SELECT raw FROM messages WHERE chat_id = ? AND id = ?').get(chatId, id);
    return typeof row?.['raw'] === 'string' ? row['raw'] : null;
  }
}
