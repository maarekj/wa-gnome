// Stockage local des discussions, contacts et messages (SQLite intégré à Node : node:sqlite).
// Baileys ne garde rien en mémoire : l'historique reçu à l'appairage et les nouveaux messages
// sont écrits ici, l'app ne lit que cette base (via l'API HTTP).
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import * as z from 'zod/mini';
import { type Chat, type ChatList, formatPhone, listKind, Media, type Message, MessageKind, previewOf } from '../shared/api.ts';

const SCHEMA = `
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  name TEXT,
  unread INTEGER NOT NULL DEFAULT 0,
  timestamp INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  -- fin du mode silencieux (ms) ; -1 : toujours
  muted_until INTEGER NOT NULL DEFAULT 0,
  -- date d'épinglage (ms), 0 : non épinglée
  pinned INTEGER NOT NULL DEFAULT 0,
  marked_unread INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  -- nom du carnet d'adresses (ou nom vérifié d'une entreprise)
  name TEXT,
  -- nom public choisi par la personne (« pushName »), affiché « ~ nom » à défaut du carnet
  notify TEXT
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
CREATE INDEX IF NOT EXISTS messages_by_sender ON messages (sender);
-- identifiant anonyme (…@lid) → numéro (…@s.whatsapp.net) : une personne, une discussion
-- indicateurs du démon (opérations à faire une fois, survivant aux redémarrages)
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- listes de discussions de WhatsApp (étiquettes : favoris, listes personnalisées…)
CREATE TABLE IF NOT EXISTS labels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  color INTEGER NOT NULL DEFAULT 0,
  -- proto.SyncActionValue.LabelEditAction.ListType (3 : favoris, 5 : personnalisée…)
  list_type INTEGER NOT NULL DEFAULT 0,
  order_index INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS chat_labels (
  chat_id TEXT NOT NULL,
  label_id TEXT NOT NULL,
  PRIMARY KEY (chat_id, label_id)
);
-- favoris (favoritesAction), dans l'ordre de WhatsApp
CREATE TABLE IF NOT EXISTS favorites (
  chat_id TEXT PRIMARY KEY,
  position INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS lid_map (
  lid TEXT PRIMARY KEY,
  pn TEXT NOT NULL
);
`;

// lignes SQLite validées : la base peut venir d'une version antérieure
const ChatRow = z.object({
  id: z.string(),
  name: z.nullable(z.string()),
  unread: z.number(),
  timestamp: z.number(),
  archived: z.number(),
  muted_until: z.number(),
  pinned: z.number(),
  marked_unread: z.number(),
  labels: z.nullable(z.string()),
  favorite: z.number(),
  contact: z.nullable(z.string()),
  notify: z.nullable(z.string()),
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
  contact: z.nullable(z.string()),
  notify: z.nullable(z.string()),
});

const LabelRow = z.object({ id: z.string(), name: z.string(), color: z.number(), list_type: z.number(), order_index: z.number() });

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
const VERSION = 4;

/** Nom public d'une personne absente du carnet, comme dans WhatsApp. */
const publicName = (notify: string): string => `~ ${notify}`;

const asKind = (k: string): MessageKind => {
  const parsed = MessageKind.safeParse(k);
  return parsed.success ? parsed.data : 'other';
};

/** Partie « utilisateur » d'un JID, pour l'affichage d'un contact sans nom. */
const userPart = (jid: string): string => {
  const user = jid.split('@')[0] ?? jid;
  return jid.endsWith('@s.whatsapp.net') ? formatPhone(user.split(':')[0] ?? user) : user;
};

/** Champs modifiables d'une discussion (absents : inchangés). */
/** Booléen → 0/1 pour SQLite ; absent : null (inchangé). */
const flag = (b: boolean | null | undefined): number | null => (b === null || b === undefined ? null : Number(b));

export interface ChatPatch {
  id: string;
  name?: string | null;
  unread?: number | null;
  timestamp?: number | null;
  archived?: boolean | null;
  mutedUntil?: number | null;
  pinned?: number | null;
  markedUnread?: boolean | null;
}

export class Store {
  readonly #db: DatabaseSync;
  /** base créée avant les médias : messages existants à reconvertir depuis `raw` */
  readonly needsMediaBackfill: boolean;
  /** lid → numéro, en mémoire (consulté à chaque message) */
  readonly #pn = new Map<string, string>();
  #depth = 0;

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
    if (!fresh && version < 4) {
      // listes et favoris ignorés jusqu'ici : nouvelle relecture de l'état de WhatsApp
      this.setFlag('resync-chat-state', true);
    }
    if (!fresh && version < 3) {
      this.#db.exec(`
        ALTER TABLE chats ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE chats ADD COLUMN muted_until INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE chats ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE chats ADD COLUMN marked_unread INTEGER NOT NULL DEFAULT 0;`);
      // état (archivée, silencieux…) connu seulement après une resynchronisation de WhatsApp
      this.setFlag('resync-chat-state', true);
    }
    if (!fresh && version < 2) {
      this.#db.exec('ALTER TABLE contacts ADD COLUMN notify TEXT');
      // noms publics des messages déjà reçus (le plus récent par personne)
      this.#db.exec(`
        INSERT INTO contacts (id, notify)
          SELECT coalesce(sender, chat_id) AS who, json_extract(raw, '$.pushName') AS push
          FROM (SELECT * FROM messages WHERE from_me = 0 AND json_valid(raw) AND json_extract(raw, '$.pushName') IS NOT NULL ORDER BY timestamp)
          WHERE push <> '' GROUP BY who
        ON CONFLICT (id) DO UPDATE SET notify = excluded.notify`);
    }
    this.#db.exec(`PRAGMA user_version = ${VERSION}`);
    for (const r of this.#db.prepare('SELECT lid, pn FROM lid_map').all()) {
      if (typeof r['lid'] === 'string' && typeof r['pn'] === 'string') this.#pn.set(r['lid'], r['pn']);
    }
  }

  // ------------------------------------------------------------------ identifiants

  /**
   * Identifiant retenu pour une personne : son numéro s'il est connu (les contacts du carnet
   * sont indexés par numéro), sinon l'identifiant tel quel.
   */
  canonical(jid: string): string {
    return this.#pn.get(jid) ?? jid;
  }

  /** Identifiant anonyme (lid) d'un numéro, s'il est connu : forme utilisée par WhatsApp dans ses listes. */
  lidOf(pn: string): string | null {
    for (const [lid, p] of this.#pn) if (p === pn) return lid;
    return null;
  }

  /** Identifiants anonymes présents dans la base sans numéro connu. */
  unresolvedLids(): string[] {
    const rows = this.#db
      .prepare(
        `SELECT id AS lid FROM chats WHERE id LIKE '%@lid'
         UNION SELECT DISTINCT sender FROM messages WHERE sender LIKE '%@lid'
         UNION SELECT id FROM contacts WHERE id LIKE '%@lid'`,
      )
      .all();
    return rows.flatMap((r) => (typeof r['lid'] === 'string' && !this.#pn.has(r['lid']) ? [r['lid']] : []));
  }

  /**
   * Correspondances lid → numéro apprises ; les données rangées sous un lid sont fusionnées
   * dans celles du numéro. Retourne les discussions disparues (lid) et celles mises à jour (numéro).
   */
  addMappings(pairs: Iterable<{ lid: string; pn: string }>): { removed: string[]; updated: string[] } {
    const removed: string[] = [];
    const updated: string[] = [];
    this.transaction(() => {
      for (const { lid, pn } of pairs) {
        if (lid === pn || this.#pn.get(lid) === pn) continue;
        this.#pn.set(lid, pn);
        this.#db.prepare('INSERT INTO lid_map (lid, pn) VALUES (?, ?) ON CONFLICT (lid) DO UPDATE SET pn = excluded.pn').run(lid, pn);
        if (this.#merge(lid, pn)) {
          removed.push(lid);
          updated.push(pn);
        }
      }
    });
    return { removed, updated };
  }

  /** Données de `lid` reportées sur `pn` ; true si une discussion `lid` existait. */
  #merge(lid: string, pn: string): boolean {
    const db = this.#db;
    // messages : ceux déjà présents sous le numéro (même id) l'emportent
    db.prepare('UPDATE OR IGNORE messages SET chat_id = ? WHERE chat_id = ?').run(pn, lid);
    db.prepare('DELETE FROM messages WHERE chat_id = ?').run(lid);
    db.prepare('UPDATE messages SET sender = ? WHERE sender = ?').run(pn, lid);
    db.prepare('UPDATE OR IGNORE chat_labels SET chat_id = ? WHERE chat_id = ?').run(pn, lid);
    db.prepare('DELETE FROM chat_labels WHERE chat_id = ?').run(lid);
    db.prepare('UPDATE OR IGNORE favorites SET chat_id = ? WHERE chat_id = ?').run(pn, lid);
    db.prepare('DELETE FROM favorites WHERE chat_id = ?').run(lid);
    db.prepare(
      `INSERT INTO contacts (id, name, notify) SELECT ?, name, notify FROM contacts WHERE id = ?
       ON CONFLICT (id) DO UPDATE SET name = coalesce(contacts.name, excluded.name), notify = coalesce(excluded.notify, contacts.notify)`,
    ).run(pn, lid);
    db.prepare('DELETE FROM contacts WHERE id = ?').run(lid);
    if (db.prepare('SELECT 1 FROM chats WHERE id = ?').get(lid) === undefined) return false;
    db.prepare(
      `INSERT INTO chats (id, name, unread, timestamp, archived, muted_until, pinned, marked_unread)
         SELECT ?, name, unread, timestamp, archived, muted_until, pinned, marked_unread FROM chats WHERE id = ?
       ON CONFLICT (id) DO UPDATE SET
         name = coalesce(chats.name, excluded.name),
         unread = chats.unread + excluded.unread,
         timestamp = max(chats.timestamp, excluded.timestamp),
         archived = max(chats.archived, excluded.archived),
         muted_until = CASE WHEN chats.muted_until = -1 OR excluded.muted_until = -1 THEN -1 ELSE max(chats.muted_until, excluded.muted_until) END,
         pinned = max(chats.pinned, excluded.pinned),
         marked_unread = max(chats.marked_unread, excluded.marked_unread)`,
    ).run(pn, lid);
    db.prepare('DELETE FROM chats WHERE id = ?').run(lid);
    return true;
  }

  flag(key: string): boolean {
    return this.#db.prepare('SELECT 1 FROM meta WHERE key = ?').get(key) !== undefined;
  }

  setFlag(key: string, on: boolean): void {
    if (on) this.#db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, '1')").run(key);
    else this.#db.prepare('DELETE FROM meta WHERE key = ?').run(key);
  }

  meta(key: string): string | null {
    const row = this.#db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
    return typeof row?.['value'] === 'string' ? row['value'] : null;
  }

  setMeta(key: string, value: string): void {
    this.#db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value);
  }

  close(): void {
    this.#db.close();
  }

  // ------------------------------------------------------------------ écriture

  /** Discussion créée ou mise à jour ; les champs absents (null, undefined) sont conservés. */
  upsertChat(c: ChatPatch): void {
    this.#db
      .prepare(
        `INSERT INTO chats (id, name, unread, timestamp, archived, muted_until, pinned, marked_unread)
         VALUES (:id, :name, coalesce(:unread, 0), coalesce(:timestamp, 0), coalesce(:archived, 0), coalesce(:muted, 0), coalesce(:pinned, 0), coalesce(:marked, 0))
         ON CONFLICT (id) DO UPDATE SET
           name = coalesce(excluded.name, chats.name),
           unread = coalesce(:unread, chats.unread),
           timestamp = max(chats.timestamp, excluded.timestamp),
           archived = coalesce(:archived, chats.archived),
           muted_until = coalesce(:muted, chats.muted_until),
           pinned = coalesce(:pinned, chats.pinned),
           marked_unread = coalesce(:marked, chats.marked_unread)`,
      )
      .run({
        id: c.id,
        name: c.name ?? null,
        unread: c.unread ?? null,
        timestamp: c.timestamp ?? null,
        archived: flag(c.archived),
        muted: c.mutedUntil ?? null,
        pinned: c.pinned ?? null,
        marked: flag(c.markedUnread),
      });
  }

  // ------------------------------------------------------------------ listes

  /** Liste créée ou modifiée ; champs absents inchangés. */
  upsertLabel(l: { id: string; name?: string | null; color?: number | null; listType?: number | null; orderIndex?: number | null; deleted?: boolean | null }): void {
    this.#db
      .prepare(
        `INSERT INTO labels (id, name, color, list_type, order_index, deleted)
         VALUES (:id, coalesce(:name, ''), coalesce(:color, 0), coalesce(:type, 0), coalesce(:ord, 0), coalesce(:deleted, 0))
         ON CONFLICT (id) DO UPDATE SET
           name = coalesce(:name, labels.name), color = coalesce(:color, labels.color),
           list_type = coalesce(:type, labels.list_type), order_index = coalesce(:ord, labels.order_index),
           deleted = coalesce(:deleted, labels.deleted)`,
      )
      .run({ id: l.id, name: l.name ?? null, color: l.color ?? null, type: l.listType ?? null, ord: l.orderIndex ?? null, deleted: flag(l.deleted) });
  }

  setChatLabel(chatId: string, labelId: string, on: boolean): void {
    if (on) this.#db.prepare('INSERT OR IGNORE INTO chat_labels (chat_id, label_id) VALUES (?, ?)').run(chatId, labelId);
    else this.#db.prepare('DELETE FROM chat_labels WHERE chat_id = ? AND label_id = ?').run(chatId, labelId);
  }

  /** Favoris remplacés (liste complète, dans l'ordre). */
  setFavorites(ids: readonly string[]): void {
    this.transaction(() => {
      this.#db.exec('DELETE FROM favorites');
      const ins = this.#db.prepare('INSERT OR IGNORE INTO favorites (chat_id, position) VALUES (?, ?)');
      for (const [i, id] of ids.entries()) ins.run(id, i);
    });
  }

  favorites(): string[] {
    return this.#db
      .prepare('SELECT chat_id FROM favorites ORDER BY position')
      .all()
      .flatMap((r) => (typeof r['chat_id'] === 'string' ? [r['chat_id']] : []));
  }

  /** Listes non supprimées, dans l'ordre de WhatsApp. */
  lists(): ChatList[] {
    return this.#db
      .prepare('SELECT id, name, color, list_type, order_index FROM labels WHERE deleted = 0 ORDER BY order_index, name')
      .all()
      .map((r) => z.parse(LabelRow, r))
      .map((r) => ({ id: r.id, name: r.name, color: r.color, kind: listKind(r.list_type) }));
  }

  /** Messages d'une discussion effacés (la discussion reste). */
  clearMessages(chatId: string): void {
    this.#db.prepare('DELETE FROM messages WHERE chat_id = ?').run(chatId);
  }

  /** Nombre de discussions épinglées. */
  pinnedCount(): number {
    return Number(this.#db.prepare('SELECT count(*) AS n FROM chats WHERE pinned > 0').get()?.['n'] ?? 0);
  }

  /** Plus ancien message (brut) d'une discussion : point de départ d'une demande d'historique. */
  oldestRaw(chatId: string): string | null {
    const row = this.#db.prepare('SELECT raw FROM messages WHERE chat_id = ? ORDER BY timestamp ASC LIMIT 1').get(chatId);
    return typeof row?.['raw'] === 'string' ? row['raw'] : null;
  }

  /** Dernier message (brut) d'une discussion : clé et date pour les modifications d'état WhatsApp. */
  lastRaw(chatId: string): string | null {
    const row = this.#db.prepare('SELECT raw FROM messages WHERE chat_id = ? ORDER BY timestamp DESC LIMIT 1').get(chatId);
    return typeof row?.['raw'] === 'string' ? row['raw'] : null;
  }

  deleteChats(ids: readonly string[]): void {
    const del = this.#db.prepare('DELETE FROM chats WHERE id = ?');
    const msgs = this.#db.prepare('DELETE FROM messages WHERE chat_id = ?');
    for (const id of ids) {
      del.run(id);
      msgs.run(id);
    }
  }

  /** Contact créé ou mis à jour ; un nom absent (null, vide) ne remplace pas le nom connu. */
  upsertContact(id: string, names: { name?: string | null; notify?: string | null }): void {
    const name = names.name === '' ? null : (names.name ?? null);
    const notify = names.notify === '' ? null : (names.notify ?? null);
    if (name === null && notify === null) return;
    this.#db
      .prepare(
        `INSERT INTO contacts (id, name, notify) VALUES (?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET name = coalesce(excluded.name, contacts.name), notify = coalesce(excluded.notify, contacts.notify)`,
      )
      .run(id, name, notify);
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
    this.#db.prepare('UPDATE chats SET unread = 0, marked_unread = 0 WHERE id = ?').run(chatId);
  }

  /** Tout effacer (déconnexion du compte). */
  clear(): void {
    this.#db.exec('DELETE FROM messages; DELETE FROM chats; DELETE FROM contacts; DELETE FROM lid_map; DELETE FROM labels; DELETE FROM chat_labels; DELETE FROM favorites;');
    this.#pn.clear();
  }

  /** Plusieurs écritures dans une transaction (synchronisation de l'historique). */
  transaction(fn: () => void): void {
    // imbrication : seule la transaction extérieure valide ou annule
    if (this.#depth > 0) {
      fn();
      return;
    }
    this.#db.exec('BEGIN');
    this.#depth += 1;
    try {
      fn();
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    } finally {
      this.#depth -= 1;
    }
  }

  // ------------------------------------------------------------------ lecture

  #chats(where: string, params: SQLInputValue[]): Chat[] {
    const rows = this.#db
      .prepare(
        `SELECT c.id, c.name, c.unread, c.timestamp, c.archived, c.muted_until, c.pinned, c.marked_unread,
                (SELECT group_concat(label_id, ',') FROM chat_labels cl WHERE cl.chat_id = c.id) AS labels,
                EXISTS (SELECT 1 FROM favorites f WHERE f.chat_id = c.id) AS favorite,
                ct.name AS contact, ct.notify,
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
      name: r.name ?? r.contact ?? (r.notify === null ? userPart(r.id) : publicName(r.notify)),
      group: r.id.endsWith('@g.us'),
      unread: r.unread,
      timestamp: r.timestamp,
      preview: r.last_kind === null ? '' : previewOf({ kind: asKind(r.last_kind), text: r.last_text ?? '' }),
      archived: r.archived !== 0,
      mutedUntil: r.muted_until,
      pinned: r.pinned,
      markedUnread: r.marked_unread !== 0,
      labels: r.labels === null ? [] : r.labels.split(','),
      favorite: r.favorite !== 0,
    }));
  }

  chats(): Chat[] {
    // discussions sans message ni date (contacts du carnet synchronisés) : masquées
    // statuts (« stories ») : hors périmètre
    return this.#chats("WHERE c.timestamp > 0 AND c.id <> 'status@broadcast'", []);
  }

  chat(id: string): Chat | null {
    return this.#chats('WHERE c.id = ?', [id])[0] ?? null;
  }

  /** Derniers messages d'une discussion avant `before` (secondes), ordre chronologique. */
  messages(chatId: string, limit: number, before?: number): Message[] {
    return this.#messages('m.chat_id = ? AND m.timestamp < ? ORDER BY m.timestamp DESC LIMIT ?', [chatId, before ?? Number.MAX_SAFE_INTEGER, limit]).toReversed();
  }

  /** Un message, tel que l'API le renvoie (noms résolus). */
  message(chatId: string, id: string): Message | null {
    return this.#messages('m.chat_id = ? AND m.id = ?', [chatId, id])[0] ?? null;
  }

  #messages(where: string, params: SQLInputValue[]): Message[] {
    const rows = this.#db
      .prepare(
        `SELECT m.*, ct.name AS contact, coalesce(m.sender_name, ct.notify) AS notify FROM messages m
         LEFT JOIN contacts ct ON ct.id = m.sender
         WHERE ${where}`,
      )
      .all(...params)
      .map((r) => z.parse(MessageRow, r));
    return rows.map((r) => ({
      id: r.id,
      chatId: r.chat_id,
      fromMe: r.from_me === 1,
      sender: r.sender,
      // carnet, sinon nom public (« ~ nom »), sinon numéro
      senderName: r.sender === null ? null : (r.contact ?? (r.notify === null ? userPart(r.sender) : publicName(r.notify))),
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
