// Stockage local des discussions, contacts et messages (SQLite intégré à Node : node:sqlite).
// Baileys ne garde rien en mémoire : l'historique reçu à l'appairage et les nouveaux messages
// sont écrits ici, l'app ne lit que cette base (via l'API HTTP).
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import * as z from 'zod/mini';
import type { Converted, RawQuoted, RawReaction } from './convert.ts';
import { type Chat, type ChatList, DELETED_TEXT, formatPhone, listKind, Media, type Message, MessageKind, MessageStatus, previewOf, type Quoted, type Reaction, type Receipt, effectiveStatus, statusOf, statusRank } from '../shared/api.ts';

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
  -- message cité (RawQuoted, JSON), null si ce n'est pas une réponse
  quoted TEXT,
  -- état d'un message envoyé (MessageStatus), null pour les messages reçus
  status TEXT,
  edited INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0,
  -- nombre de transferts (contextInfo.forwardingScore), 0 : non transféré
  forwarded INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (chat_id, id)
);
CREATE INDEX IF NOT EXISTS messages_by_time ON messages (chat_id, timestamp);
CREATE INDEX IF NOT EXISTS messages_by_sender ON messages (sender);
-- identifiant anonyme (…@lid) → numéro (…@s.whatsapp.net) : une personne, une discussion
-- réactions : une par personne et par message (« me » : les miennes)
CREATE TABLE IF NOT EXISTS reactions (
  chat_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  sender TEXT NOT NULL,
  emoji TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  PRIMARY KEY (chat_id, message_id, sender)
);
-- accusés des messages envoyés, par destinataire (secondes ; null : pas encore)
CREATE TABLE IF NOT EXISTS receipts (
  chat_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  user TEXT NOT NULL,
  delivered INTEGER,
  read INTEGER,
  played INTEGER,
  PRIMARY KEY (chat_id, message_id, user)
);
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
  last_deleted: z.nullable(z.number()),
});

/** JSON lu sans échec (null si invalide). */
function parseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** Nombre de transferts trouvé dans un message brut (premier `contextInfo` transféré), 0 sinon. */
export function forwardScoreIn(value: unknown, depth = 0): number {
  if (typeof value !== 'object' || value === null || depth > 8) return 0;
  if ('isForwarded' in value && value.isForwarded === true) {
    const score = 'forwardingScore' in value && typeof value.forwardingScore === 'number' ? value.forwardingScore : 1;
    return Math.max(1, score);
  }
  for (const v of Object.values(value)) {
    const found = forwardScoreIn(v, depth + 1);
    if (found > 0) return found;
  }
  return 0;
}

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
  quoted: z.nullable(z.string()),
  status: z.nullable(z.string()),
  edited: z.number(),
  deleted: z.number(),
  forwarded: z.number(),
  contact: z.nullable(z.string()),
  notify: z.nullable(z.string()),
});

const LabelRow = z.object({ id: z.string(), name: z.string(), color: z.number(), list_type: z.number(), order_index: z.number() });

const RawQuotedRow = z.object({ id: z.string(), sender: z.nullable(z.string()), kind: MessageKind, text: z.string() });

/** Citation JSON de la base, ignorée si elle est invalide. */
const parseQuoted = (json: string | null): RawQuoted | null => {
  if (json === null) return null;
  try {
    const parsed = RawQuotedRow.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

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
const VERSION = 10;

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

/** Date d'accusé : absente ou nulle (0) → null. */
const dateOrNull = (v: number | null | undefined): number | null => (v === null || v === undefined || v <= 0 ? null : v);
const numberOrNull = (v: unknown): number | null => (typeof v === 'number' ? v : null);

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
    if (!fresh && version < 10) {
      this.#db.exec('ALTER TABLE messages ADD COLUMN forwarded INTEGER NOT NULL DEFAULT 0');
      // messages transférés déjà reçus : relus dans le message brut
      const rows = this.#db.prepare(`SELECT chat_id, id, raw FROM messages WHERE raw LIKE '%"isForwarded":true%'`).all();
      const upd = this.#db.prepare('UPDATE messages SET forwarded = ? WHERE chat_id = ? AND id = ?');
      this.transaction(() => {
        for (const r of rows) {
          const score = forwardScoreIn(parseJson(String(r['raw'])));
          if (score > 0) upd.run(score, String(r['chat_id']), String(r['id']));
        }
      });
    }
    if (!fresh && version < 9) {
      this.#db.exec('ALTER TABLE messages ADD COLUMN edited INTEGER NOT NULL DEFAULT 0; ALTER TABLE messages ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0;');
    }
    if (!fresh && version < 8) {
      // accusés par destinataire des messages déjà envoyés : relus dans les messages bruts
      this.setFlag('backfill-receipts', true);
    }
    if (!fresh && version < 7) {
      this.#db.exec('ALTER TABLE messages ADD COLUMN status TEXT');
      // état des messages envoyés : relu dans le message brut (nombre ou nom selon la source)
      const rows = this.#db.prepare("SELECT chat_id, id, json_extract(raw, '$.status') AS s FROM messages WHERE from_me = 1").all();
      const upd = this.#db.prepare('UPDATE messages SET status = ? WHERE chat_id = ? AND id = ?');
      this.transaction(() => {
        for (const r of rows) upd.run(statusOf(r['s']) ?? 'sent', String(r['chat_id']), String(r['id']));
      });
    }
    if (!fresh && version < 6) {
      // réactions jusqu'ici enregistrées comme messages, ou seulement dans `raw` : relues au démarrage
      this.setFlag('backfill-reactions', true);
    }
    if (!fresh && version < 5) {
      this.#db.exec('ALTER TABLE messages ADD COLUMN quoted TEXT');
      // citations des messages déjà reçus : recalculées depuis `raw` au démarrage
      this.setFlag('backfill-quoted', true);
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
    db.prepare('UPDATE OR IGNORE receipts SET chat_id = ? WHERE chat_id = ?').run(pn, lid);
    db.prepare('DELETE FROM receipts WHERE chat_id = ?').run(lid);
    db.prepare('UPDATE OR IGNORE receipts SET user = ? WHERE user = ?').run(pn, lid);
    db.prepare('DELETE FROM receipts WHERE user = ?').run(lid);
    db.prepare('UPDATE OR IGNORE reactions SET chat_id = ? WHERE chat_id = ?').run(pn, lid);
    db.prepare('DELETE FROM reactions WHERE chat_id = ?').run(lid);
    db.prepare('UPDATE OR IGNORE reactions SET sender = ? WHERE sender = ?').run(pn, lid);
    db.prepare('DELETE FROM reactions WHERE sender = ?').run(lid);
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
    this.#db.prepare('DELETE FROM reactions WHERE chat_id = ?').run(chatId);
    this.#db.prepare('DELETE FROM receipts WHERE chat_id = ?').run(chatId);
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
    const reacts = this.#db.prepare('DELETE FROM reactions WHERE chat_id = ?');
    for (const id of ids) {
      del.run(id);
      msgs.run(id);
      reacts.run(id);
      this.#db.prepare('DELETE FROM receipts WHERE chat_id = ?').run(id);
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
  upsertMessage(m: Converted, raw: string): void {
    this.#db
      .prepare(
        `INSERT OR REPLACE INTO messages (chat_id, id, from_me, sender, sender_name, timestamp, kind, text, raw, media, quoted, forwarded, edited, deleted, status)
         VALUES (:chat_id, :id, :from_me, :sender, :sender_name, :timestamp, :kind, :text, :raw, :media, :quoted, :forwarded,
           -- modification et suppression déjà appliquées (message rejoué par l'historique) : conservées
           coalesce((SELECT edited FROM messages WHERE chat_id = :chat_id AND id = :id), 0),
           max(:deleted, coalesce((SELECT deleted FROM messages WHERE chat_id = :chat_id AND id = :id), 0)),
           -- état déjà plus avancé (accusé arrivé avant le message lui-même) : conservé
           (SELECT CASE WHEN :status IS NULL THEN NULL ELSE coalesce((SELECT status FROM messages WHERE chat_id = :chat_id AND id = :id), :status) END))`,
      )
      .run({
        chat_id: m.chatId,
        id: m.id,
        from_me: m.fromMe ? 1 : 0,
        sender: m.sender,
        sender_name: m.senderName,
        timestamp: m.timestamp,
        kind: m.kind,
        text: m.text,
        raw,
        media: m.media === null ? null : JSON.stringify(m.media),
        quoted: m.quoted === null ? null : JSON.stringify(m.quoted),
        status: m.status,
        deleted: m.deleted === true ? 1 : 0,
        forwarded: m.forwarded ?? 0,
      });
    // modification ou suppression arrivée avant (ou rejouée après) le message d'origine : appliquée
    const edit = this.meta(`edit:${m.chatId}/${m.id}`);
    if (edit !== null) {
      const text = z.object({ text: z.string() }).safeParse(JSON.parse(edit));
      if (text.success) this.#db.prepare('UPDATE messages SET text = ?, edited = 1 WHERE chat_id = ? AND id = ? AND deleted = 0').run(text.data.text, m.chatId, m.id);
    }
    if (this.flag(`revoke:${m.chatId}/${m.id}`)) this.applyRevoke(m.chatId, m.id);
    if (m.status !== null) this.setStatus(m.chatId, m.id, m.status);
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
    this.#db.exec('DELETE FROM messages; DELETE FROM chats; DELETE FROM contacts; DELETE FROM lid_map; DELETE FROM labels; DELETE FROM chat_labels; DELETE FROM favorites; DELETE FROM reactions; DELETE FROM receipts;');
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
                m.kind AS last_kind, m.text AS last_text, m.deleted AS last_deleted
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
      preview: r.last_kind === null ? '' : r.last_deleted === 1 ? DELETED_TEXT : previewOf({ kind: asKind(r.last_kind), text: r.last_text ?? '' }),
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
    const reactions = this.#reactions(rows[0]?.chat_id ?? '', rows.map((r) => r.id));
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
      media: r.deleted === 0 ? parseMedia(r.media) : null,
      quoted: r.deleted === 0 ? this.#resolveQuoted(parseQuoted(r.quoted), r.chat_id) : null,
      reactions: reactions.get(r.id) ?? [],
      edited: r.edited !== 0,
      deleted: r.deleted !== 0,
      forwarded: r.deleted === 0 ? r.forwarded : 0,
      status: r.from_me === 1 ? effectiveStatus(MessageStatus.safeParse(r.status).data ?? 'sent', r.timestamp) : null,
    }));
  }

  /** État d'un message envoyé, s'il est plus avancé que celui connu ; true s'il a changé. */
  setStatus(chatId: string, id: string, status: MessageStatus): boolean {
    const row = this.#db.prepare('SELECT status FROM messages WHERE chat_id = ? AND id = ? AND from_me = 1').get(chatId, id);
    if (row === undefined) return false;
    const current = typeof row['status'] === 'string' ? MessageStatus.safeParse(row['status']) : null;
    if (current?.success === true && (current.data === status || (statusRank(current.data) > statusRank(status) && status !== 'error'))) return false;
    this.#db.prepare('UPDATE messages SET status = ? WHERE chat_id = ? AND id = ?').run(status, chatId, id);
    return true;
  }

  // ------------------------------------------------------------------ modifications, suppressions

  /**
   * Message modifié : nouveau texte (ou légende), gardé aussi à part pour survivre à un nouvel
   * enregistrement du message d'origine (historique rejoué). false si le message est inconnu.
   */
  /**
   * Le changement vient-il de l'auteur du message ? `by` : `me` ou JID rattaché au numéro.
   * Message pas encore reçu : accepté (vérifié à son arrivée impossible ; cas de l'historique).
   */
  isAuthor(chatId: string, id: string, by: string): boolean {
    const row = this.#db.prepare('SELECT from_me, sender FROM messages WHERE chat_id = ? AND id = ?').get(chatId, id);
    if (row === undefined) return true;
    if (row['from_me'] === 1) return by === 'me';
    if (by === 'me') return false;
    // discussion directe : l'auteur est l'autre personne ; groupe : l'expéditeur enregistré
    return typeof row['sender'] === 'string' ? row['sender'] === by : by === chatId;
  }

  applyEdit(chatId: string, id: string, text: string): boolean {
    const changed = this.#db.prepare('UPDATE messages SET text = ?, edited = 1 WHERE chat_id = ? AND id = ? AND deleted = 0').run(text, chatId, id).changes > 0;
    this.setMeta(`edit:${chatId}/${id}`, JSON.stringify({ text }));
    return changed;
  }

  /** Message supprimé pour tous : contenu effacé, réactions retirées. false si le message est inconnu. */
  applyRevoke(chatId: string, id: string): boolean {
    this.setFlag(`revoke:${chatId}/${id}`, true);
    const changed = this.#db.prepare("UPDATE messages SET deleted = 1, text = '', media = NULL, quoted = NULL WHERE chat_id = ? AND id = ?").run(chatId, id).changes > 0;
    this.#db.prepare('DELETE FROM reactions WHERE chat_id = ? AND message_id = ?').run(chatId, id);
    return changed;
  }

  /** Accusé d'un destinataire : chaque date n'est renseignée qu'une fois (la première connue). */
  setReceipt(r: { chatId: string; messageId: string; user: string; delivered?: number | null; read?: number | null; played?: number | null }): void {
    this.#db
      .prepare(
        `INSERT INTO receipts (chat_id, message_id, user, delivered, read, played) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (chat_id, message_id, user) DO UPDATE SET
           delivered = coalesce(receipts.delivered, excluded.delivered),
           read = coalesce(receipts.read, excluded.read),
           played = coalesce(receipts.played, excluded.played)`,
      )
      .run(r.chatId, r.messageId, r.user, dateOrNull(r.delivered), dateOrNull(r.read), dateOrNull(r.played));
  }

  /** Accusés d'un message, noms résolus ; lu (ou écouté) implique distribué. */
  receipts(chatId: string, messageId: string): Receipt[] {
    return this.#db
      .prepare('SELECT user, delivered, read, played FROM receipts WHERE chat_id = ? AND message_id = ? ORDER BY coalesce(read, delivered, played) DESC')
      .all(chatId, messageId)
      .flatMap((r) => {
        if (typeof r['user'] !== 'string') return [];
        const read = numberOrNull(r['read']) ?? numberOrNull(r['played']);
        return [{ id: r['user'], name: this.displayName(r['user']), delivered: numberOrNull(r['delivered']) ?? read, read, played: numberOrNull(r['played']) }];
      });
  }

  /** Messages envoyés dont la forme brute porte des accusés (historique). */
  messagesWithReceipts(): { chatId: string; id: string; raw: string }[] {
    return this.#rawRows(`from_me = 1 AND raw LIKE '%"userReceipt":[{%'`);
  }

  /** État d'un envoi de l'app, imposé tant qu'aucun accusé n'est arrivé (état « envoyé » par défaut). */
  forceStatus(chatId: string, id: string, status: MessageStatus): boolean {
    return this.#db.prepare("UPDATE messages SET status = ? WHERE chat_id = ? AND id = ? AND from_me = 1 AND status = 'sent'").run(status, chatId, id).changes > 0;
  }

  // ------------------------------------------------------------------ réactions

  /**
   * Réaction ajoutée, changée ou retirée (émoji vide) ; une plus ancienne que celle connue est
   * ignorée (historique rejoué). L'auteur doit être déjà rattaché au numéro (ou « me »).
   */
  setReaction(r: RawReaction): void {
    if (r.emoji === '') {
      this.#db.prepare('DELETE FROM reactions WHERE chat_id = ? AND message_id = ? AND sender = ? AND timestamp <= ?').run(r.chatId, r.targetId, r.sender, r.timestamp);
      return;
    }
    this.#db
      .prepare(
        `INSERT INTO reactions (chat_id, message_id, sender, emoji, timestamp) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (chat_id, message_id, sender) DO UPDATE SET emoji = excluded.emoji, timestamp = excluded.timestamp
         WHERE excluded.timestamp >= reactions.timestamp`,
      )
      .run(r.chatId, r.targetId, r.sender, r.emoji, r.timestamp);
  }

  /** Réactions de messages, groupées par émoji (ordre d'arrivée du premier). */
  #reactions(chatId: string, ids: readonly string[]): Map<string, Reaction[]> {
    const out = new Map<string, Reaction[]>();
    if (ids.length === 0) return out;
    const rows = this.#db
      .prepare(`SELECT message_id, sender, emoji FROM reactions WHERE chat_id = ? AND message_id IN (${ids.map(() => '?').join(',')}) ORDER BY timestamp`)
      .all(chatId, ...ids);
    for (const r of rows) {
      if (typeof r['message_id'] !== 'string' || typeof r['sender'] !== 'string' || typeof r['emoji'] !== 'string') continue;
      const list = out.get(r['message_id']) ?? [];
      const mine = r['sender'] === 'me';
      const person = mine ? { id: null, name: 'Vous' } : { id: r['sender'], name: this.displayName(r['sender']) };
      const found = list.find((x) => x.emoji === r['emoji']);
      if (found === undefined) list.push({ emoji: r['emoji'], count: 1, mine, people: [person] });
      else {
        found.count += 1;
        found.mine ||= mine;
        found.people.push(person);
      }
      out.set(r['message_id'], list);
    }
    return out;
  }

  /** Anciennes réactions enregistrées comme messages : retirées de la liste des messages. */
  reactionMessagesToBackfill(): { chatId: string; id: string; raw: string }[] {
    return this.#rawRows("kind = 'reaction'");
  }

  /** Messages dont la forme brute porte des réactions (historique). */
  messagesWithReactions(): { chatId: string; id: string; raw: string }[] {
    return this.#rawRows(`raw LIKE '%"reactions":[%'`);
  }

  #rawRows(where: string): { chatId: string; id: string; raw: string }[] {
    return this.#db
      .prepare(`SELECT chat_id, id, raw FROM messages WHERE ${where}`)
      .all()
      .flatMap((r) => (typeof r['chat_id'] === 'string' && typeof r['id'] === 'string' && typeof r['raw'] === 'string' ? [{ chatId: r['chat_id'], id: r['id'], raw: r['raw'] }] : []));
  }

  deleteMessage(chatId: string, id: string): void {
    this.#db.prepare('DELETE FROM messages WHERE chat_id = ? AND id = ?').run(chatId, id);
  }

  /** Mes identifiants (numéro, lid) : citations de mes propres messages reconnues. */
  setMe(ids: readonly string[]): void {
    this.setMeta('me', JSON.stringify(ids));
    this.#me = new Set(ids);
  }

  #me: Set<string> | null = null;

  #myIds(): Set<string> {
    if (this.#me === null) {
      const parsed = z.array(z.string()).safeParse(JSON.parse(this.meta('me') ?? '[]'));
      this.#me = new Set(parsed.success ? parsed.data : []);
    }
    return this.#me;
  }

  /** Nom affiché d'une personne : carnet, sinon nom public, sinon numéro. */
  displayName(jid: string): string {
    const row = this.#db.prepare('SELECT name, notify FROM contacts WHERE id = ?').get(jid);
    if (typeof row?.['name'] === 'string') return row['name'];
    return typeof row?.['notify'] === 'string' ? publicName(row['notify']) : userPart(jid);
  }

  /** Citation : auteur rattaché au numéro, « moi » et nom résolus. Sans auteur (discussion directe) : l'autre personne. */
  #resolveQuoted(q: RawQuoted | null, chatId: string): Quoted | null {
    if (q === null) return null;
    const sender = q.sender === null ? null : this.canonical(q.sender);
    const me = this.#myIds();
    const fromMe = sender !== null && (me.has(sender) || me.has(q.sender ?? ''));
    const who = sender ?? (chatId.endsWith('@g.us') ? null : chatId);
    return { ...q, sender, fromMe, senderName: fromMe ? 'Vous' : who === null ? null : this.displayName(who) };
  }

  /** Messages répondant à un autre sans citation enregistrée (base antérieure) : à reconvertir. */
  quotedToBackfill(): { chatId: string; id: string; raw: string }[] {
    return this.#db
      .prepare(`SELECT chat_id, id, raw FROM messages WHERE quoted IS NULL AND raw LIKE '%"stanzaId"%'`)
      .all()
      .flatMap((r) => (typeof r['chat_id'] === 'string' && typeof r['id'] === 'string' && typeof r['raw'] === 'string' ? [{ chatId: r['chat_id'], id: r['id'], raw: r['raw'] }] : []));
  }

  setQuoted(chatId: string, id: string, quoted: RawQuoted | null): void {
    this.#db.prepare('UPDATE messages SET quoted = ? WHERE chat_id = ? AND id = ?').run(quoted === null ? null : JSON.stringify(quoted), chatId, id);
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
