// Stockage local des discussions, contacts et messages (SQLite intégré à Node : node:sqlite).
// Baileys ne garde rien en mémoire : l'historique reçu à l'appairage et les nouveaux messages
// sont écrits ici, l'app ne lit que cette base (via l'API HTTP).
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import * as z from 'zod/mini';
import { type Chat, type Message, MessageKind, previewOf } from '../shared/api.ts';

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
});

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

  constructor(file: string) {
    this.#db = new DatabaseSync(file);
    this.#db.exec(SCHEMA);
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
        `INSERT OR REPLACE INTO messages (chat_id, id, from_me, sender, sender_name, timestamp, kind, text, raw)
         VALUES (:chat_id, :id, :from_me, :sender, :sender_name, :timestamp, :kind, :text, :raw)`,
      )
      .run({ chat_id: m.chatId, id: m.id, from_me: m.fromMe ? 1 : 0, sender: m.sender, sender_name: m.senderName, timestamp: m.timestamp, kind: m.kind, text: m.text, raw });
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
    }));
  }

  /** WAMessage brut (BufferJSON), pour `getMessage` de Baileys (renvoi des messages). */
  raw(chatId: string, id: string): string | null {
    const row = this.#db.prepare('SELECT raw FROM messages WHERE chat_id = ? AND id = ?').get(chatId, id);
    return typeof row?.['raw'] === 'string' ? row['raw'] : null;
  }
}
