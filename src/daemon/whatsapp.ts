// Connexion WhatsApp (Baileys, protocole multi-appareils) : appairage, reconnexion, et
// recopie des discussions et messages reçus dans le Store.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  BufferJSON,
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  makeWASocket,
  normalizeMessageContent,
  useMultiFileAuthState,
  proto,
  ALL_WA_PATCH_NAMES,
  type ChatUpdate,
  type Contact,
  type SignalKeyStore,
  type WAMessage,
  type WAMessageKey,
  type WASocket,
} from 'baileys';
import pino from 'pino';
import * as z from 'zod/mini';
import { type ChatAction, type Event, MAX_PINNED, type Message, type Status, uploadKind } from '../shared/api.ts';
import type { Upload } from './server.ts';
import { mediaOf, quotedOf, type RawReaction, reactionOf, reactionsOf, seconds, toMessage } from './convert.ts';
import { Pictures } from './pictures.ts';
import type { ChatPatch, Store } from './store.ts';

const logger = pino({ level: process.env['WA_GNOME_LOG'] ?? 'warn' });

/** Délai avant reconnexion après une coupure (ms). */
const RECONNECT_MS = 3000;
/** Délai de réponse de WhatsApp pour une photo de profil (une requête bloquée retient la file). */
const PICTURE_TIMEOUT_MS = 10_000;

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
/** Code HTTP d'une erreur Boom de Baileys (sans dépendre de @hapi/boom). */
const statusCode = (e: unknown): number | undefined => {
  if (typeof e !== 'object' || e === null || !('output' in e)) return undefined;
  const { output } = e;
  if (typeof output !== 'object' || output === null || !('statusCode' in output)) return undefined;
  return typeof output.statusCode === 'number' ? output.statusCode : undefined;
};

export class WhatsApp {
  readonly #store: Store;
  readonly #authDir: string;
  readonly #mediaDir: string;
  readonly #pictures: Pictures;
  readonly #emit: (e: Event) => void;
  #sock: WASocket | null = null;
  #keys: SignalKeyStore | null = null;
  #status: Status = { state: 'starting', qr: null, me: null, error: null };
  #stopped = false;

  constructor(store: Store, dataDir: string, emit: (e: Event) => void) {
    this.#store = store;
    this.#authDir = path.join(dataDir, 'auth');
    this.#mediaDir = path.join(dataDir, 'media');
    this.#pictures = new Pictures(path.join(dataDir, 'pictures'), (jid) => this.#open().profilePictureUrl(jid, 'preview', PICTURE_TIMEOUT_MS));
    this.#emit = emit;
  }

  get status(): Status {
    return this.#status;
  }

  #setStatus(patch: Partial<Status>): void {
    this.#status = { ...this.#status, ...patch };
    this.#emit({ type: 'status', status: this.#status });
  }

  async start(): Promise<void> {
    this.#stopped = false;
    fs.mkdirSync(this.#authDir, { recursive: true, mode: 0o700 });
    const { state, saveCreds } = await useMultiFileAuthState(this.#authDir);
    this.#keys = state.keys;
    // version du client web annoncée : la plus récente connue, sinon celle de Baileys
    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));
    const sock = makeWASocket({
      ...(version === undefined ? {} : { version }),
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
      logger,
      browser: Browsers.ubuntu('wa-gnome'),
      // le téléphone reste la source des notifications tant que l'app n'est pas ouverte
      markOnlineOnConnect: false,
      syncFullHistory: false,
      getMessage: (key) => Promise.resolve(this.#rawMessage(key.remoteJid, key.id)),
    });
    this.#sock = sock;
    this.#setStatus({ state: 'connecting', qr: null, error: null });

    sock.ev.on('creds.update', () => {
      saveCreds().catch((error: unknown) => logger.error({ error }, 'creds.update'));
    });

    sock.ev.on('connection.update', (u) => {
      if (u.qr !== undefined) this.#setStatus({ state: 'qr', qr: u.qr });
      if (u.connection === 'open') {
        const me = sock.user;
        // mes identifiants : citations de mes propres messages reconnues
        if (me !== undefined) this.#store.setMe([jidNormalizedUser(me.id), ...(me.lid === undefined || me.lid === null ? [] : [jidNormalizedUser(me.lid)])]);
        this.#setStatus({ state: 'open', qr: null, error: null, me: me === undefined ? null : { id: jidNormalizedUser(me.id), name: me.name ?? me.notify ?? null } });
        void this.#resolveLids(sock);
        void this.#fetchGroups(sock);
        void this.#resyncChatState(sock);
      }
      if (u.connection === 'close') {
        const code = statusCode(u.lastDisconnect?.error);
        this.#sock = null;
        if (code === DisconnectReason.loggedOut) {
          this.#forget();
          this.#setStatus({ state: 'logged-out', qr: null, me: null, error: null });
          // nouvel appairage : QR code suivant
          if (!this.#stopped) this.#restart(0);
          return;
        }
        this.#setStatus({ state: 'closed', error: u.lastDisconnect?.error === undefined ? null : errorText(u.lastDisconnect.error) });
        // 515 (restartRequired) : normal juste après l'appairage
        if (!this.#stopped) this.#restart(code === DisconnectReason.restartRequired ? 0 : RECONNECT_MS);
      }
    });

    sock.ev.on('lid-mapping.update', (mapping) => {
      this.#learn([mapping]);
    });

    sock.ev.on('messaging-history.set', ({ chats, contacts, messages, lidPnMappings, syncType }) => {
      this.#store.transaction(() => {
        // correspondances d'abord : les données suivantes sont rangées directement sous le numéro
        this.#learn(lidPnMappings ?? [], false);
        for (const m of messages) this.#learnFromKey(m.key);
        for (const c of contacts) this.#saveContact(c);
        for (const c of chats) {
          if (c.id === null || c.id === undefined) continue;
          this.#store.upsertChat(this.#chatPatch(c, c.id));
        }
        for (const m of messages) {
          const reaction = reactionOf(m);
          if (reaction === null) this.#saveMessage(m);
          else this.#react(reaction, false);
        }
      });
      this.#emit({ type: 'chats', chats: this.#store.chats() });
      // réponse à une demande d'historique : discussions concernées rechargées par l'app
      if (syncType === proto.HistorySync.HistorySyncType.ON_DEMAND) {
        const ids = [...new Set(messages.map((m) => this.#jid(m.key.remoteJid)))];
        this.#emit({ type: 'history', ids });
      }
    });

    sock.ev.on('chats.upsert', (chats) => {
      for (const c of chats) {
        if (c.id === null || c.id === undefined) continue;
        this.#store.upsertChat(this.#chatPatch(c, c.id));
      }
      this.#emitChats(chats.map((c) => c.id));
    });

    sock.ev.on('chats.update', (updates) => {
      for (const c of updates) {
        if (c.id === null || c.id === undefined) continue;
        this.#store.upsertChat(this.#chatPatch(c, c.id));
      }
      this.#emitChats(updates.map((c) => c.id));
    });

    sock.ev.on('chats.delete', (deleted) => {
      const ids = deleted.map((id) => this.#jid(id));
      this.#store.deleteChats(ids);
      this.#emit({ type: 'chats.delete', ids });
    });

    sock.ev.on('contacts.upsert', (contacts) => {
      for (const c of contacts) this.#saveContact(c);
    });

    sock.ev.on('contacts.update', (contacts) => {
      for (const c of contacts) {
        if (c.id === undefined) continue;
        this.#saveContact({ ...c, id: c.id });
        // photo changée ou retirée (personne ou groupe)
        if (c.imgUrl !== undefined) {
          const id = this.#jid(c.id);
          this.#pictures.invalidate(id);
          this.#emit({ type: 'picture', id });
        }
      }
    });

    sock.ev.on('messages.upsert', ({ messages, type }) => {
      for (const wa of messages) {
        this.#learnFromKey(wa.key);
        // réaction : rattachée au message visé, pas de bulle ni de notification
        const reaction = reactionOf(wa);
        if (reaction !== null) {
          this.#react(reaction);
          continue;
        }
        const m = this.#saveMessage(wa);
        if (m === null) continue;
        if (type === 'notify' && !m.fromMe) this.#store.incrementUnread(m.chatId);
        this.#emit({ type: 'message', message: m });
        this.#emitChats([m.chatId]);
      }
    });

    // listes (étiquettes) : favoris, listes personnalisées
    sock.ev.on('labels.edit', (l) => {
      this.#store.upsertLabel({ id: l.id, name: l.name, color: l.color, listType: l.listType ?? null, orderIndex: l.orderIndex ?? null, deleted: l.deleted });
      this.#emit({ type: 'lists', lists: this.#store.lists() });
    });
    sock.ev.on('labels.association', ({ type, association }) => {
      // associations à un message : non gérées
      if ('messageId' in association) return;
      const id = this.#jid(association.chatId);
      this.#store.setChatLabel(id, association.labelId, type === 'add');
      this.#emitChats([id]);
    });
    sock.ev.on('favorites.set', ({ ids, index, collection, version: apiVersion }) => {
      this.#store.setFavorites(ids.map((id) => this.#jid(id)));
      // forme de l'action telle que WhatsApp l'écrit : reprise pour modifier les favoris
      this.#store.setMeta('favorites-patch', JSON.stringify({ index, collection: collection ?? null, version: apiVersion ?? null, ids }));
      this.#emit({ type: 'chats', chats: this.#store.chats() });
    });

    // groupe renommé
    sock.ev.on('groups.update', (groups) => {
      const named = groups.filter((g): g is typeof g & { id: string; subject: string } => g.id !== undefined && g.subject !== undefined);
      for (const g of named) this.#store.upsertChat({ id: g.id, name: g.subject });
      this.#emitChats(named.map((g) => g.id));
    });

    // noms de groupes : pas toujours présents dans l'historique
    sock.ev.on('groups.upsert', (groups) => {
      for (const g of groups) this.#store.upsertChat({ id: this.#jid(g.id), name: g.subject });
      this.#emitChats(groups.map((g) => g.id));
    });
  }

  /** Réaction enregistrée (auteur rattaché au numéro) ; message visé renvoyé à l'app s'il existe. */
  #react(r: RawReaction, notify = true): void {
    const chatId = this.#jid(r.chatId);
    this.#store.setReaction({ ...r, chatId, sender: r.sender === 'me' ? 'me' : this.#jid(r.sender) });
    if (!notify) return;
    const target = this.#store.message(chatId, r.targetId);
    if (target !== null) this.#emit({ type: 'message.update', message: target });
  }

  #saveMessage(wa: WAMessage): Message | null {
    const converted = toMessage(wa);
    // réactions de l'historique portées par le message lui-même
    for (const r of reactionsOf(wa)) this.#react(r, false);
    if (converted === null) return null;
    // discussion et auteurs (message, citation) rangés sous le numéro quand il est connu
    const q = converted.quoted;
    const m = {
      ...converted,
      chatId: this.#jid(converted.chatId),
      sender: converted.sender === null ? null : this.#jid(converted.sender),
      quoted: q === null ? null : { ...q, sender: q.sender === null ? null : this.#jid(q.sender) },
    };
    // nom public de l'auteur : nom de repli d'un contact absent du carnet
    if (!m.fromMe) this.#store.upsertContact(m.sender ?? m.chatId, { notify: wa.pushName ?? null });
    this.#store.upsertMessage(m, JSON.stringify(wa, BufferJSON.replacer));
    // relu : noms résolus comme dans les réponses de l'API
    return this.#store.message(m.chatId, m.id);
  }

  // ------------------------------------------------------------------ identifiants lid / numéro

  /** Identifiant retenu pour une discussion ou une personne (numéro si connu). */
  #jid(jid: string | null | undefined): string {
    return this.#store.canonical(jidNormalizedUser(jid ?? ''));
  }

  #saveContact(c: Partial<Contact> & { id: string }): void {
    // un contact peut porter ses deux identifiants
    const lid = [c.id, c.lid].find((j) => j?.endsWith('@lid') === true);
    const pn = [c.id, c.phoneNumber].find((j) => j?.endsWith('@s.whatsapp.net') === true);
    if (lid !== undefined && pn !== undefined) this.#learn([{ lid, pn }]);
    this.#store.upsertContact(this.#jid(c.id), { name: c.name ?? c.verifiedName ?? null, notify: c.notify ?? null });
  }

  /** Correspondances portées par la clé d'un message (identifiant « alternatif » de l'auteur). */
  #learnFromKey(key: WAMessageKey): void {
    const pairs = [
      [key.remoteJid, key.remoteJidAlt],
      [key.participant, key.participantAlt],
    ].flatMap(([a, b]) => {
      const lid = [a, b].find((j) => j?.endsWith('@lid') === true);
      const pn = [a, b].find((j) => j?.endsWith('@s.whatsapp.net') === true);
      return lid === undefined || lid === null || pn === undefined || pn === null ? [] : [{ lid, pn }];
    });
    if (pairs.length > 0) this.#learn(pairs);
  }

  /**
   * Nouvelles correspondances : fusion des discussions en double, signalée à l'app
   * (`notify` faux pendant la synchronisation de l'historique : liste complète envoyée ensuite).
   */
  #learn(pairs: readonly { lid: string; pn: string }[], notify = true): void {
    const normalized = pairs.flatMap((p) => {
      const lid = jidNormalizedUser(p.lid.includes('@') ? p.lid : `${p.lid}@lid`);
      const pn = jidNormalizedUser(p.pn.includes('@') ? p.pn : `${p.pn}@s.whatsapp.net`);
      return lid.endsWith('@lid') && pn.endsWith('@s.whatsapp.net') ? [{ lid, pn }] : [];
    });
    const { removed, updated } = this.#store.addMappings(normalized);
    if (!notify || removed.length === 0) return;
    logger.info(`lid : ${removed.length} discussion(s) fusionnée(s)`);
    this.#emit({ type: 'chats.delete', ids: removed });
    this.#emitChats(updated);
  }

  /**
   * État des discussions (archivée, silencieux, épinglée, non lue) relu depuis WhatsApp : base
   * antérieure à son enregistrement. Les versions locales de l'« app state » sont oubliées pour
   * recevoir un instantané complet, rejoué comme des mises à jour (`chats.update`).
   */
  async #resyncChatState(sock: WASocket): Promise<void> {
    if (!this.#store.flag('resync-chat-state') || this.#keys === null) return;
    try {
      await this.#keys.set({ 'app-state-sync-version': Object.fromEntries(ALL_WA_PATCH_NAMES.map((n) => [n, null])) });
      await sock.resyncAppState(ALL_WA_PATCH_NAMES, false);
      this.#store.setFlag('resync-chat-state', false);
      this.#emit({ type: 'chats', chats: this.#store.chats() });
      logger.info('état des discussions resynchronisé');
    } catch (error) {
      logger.warn({ error }, 'resynchronisation de l’état des discussions');
    }
  }

  /** Discussion Baileys (historique ou mise à jour) → champs du Store ; champs absents inchangés. */
  #chatPatch(c: Partial<ChatUpdate>, id: string): ChatPatch {
    const patch: ChatPatch = { id: this.#jid(id), name: c.name ?? null, timestamp: seconds(c.conversationTimestamp) || null };
    // -1 : « marquée comme non lue » (synchronisation), 0 : lue
    if (c.unreadCount === -1) patch.markedUnread = true;
    else if (c.unreadCount !== null && c.unreadCount !== undefined) {
      patch.unread = c.unreadCount;
      if (c.unreadCount === 0) patch.markedUnread = false;
    }
    if (typeof c.markedAsUnread === 'boolean') patch.markedUnread = c.markedAsUnread;
    if (typeof c.archived === 'boolean') patch.archived = c.archived;
    if ('muteEndTime' in c) patch.mutedUntil = muteEnd(c.muteEndTime);
    if ('pinned' in c) patch.pinned = c.pinned === null || c.pinned === undefined ? 0 : seconds(c.pinned);
    return patch;
  }

  /** Noms des groupes (absents de l'historique pour les groupes sans message récent). */
  async #fetchGroups(sock: WASocket): Promise<void> {
    try {
      const groups = Object.values(await sock.groupFetchAllParticipating());
      this.#store.transaction(() => {
        for (const g of groups) {
          this.#store.upsertChat({ id: g.id, name: g.subject });
          // participants : correspondances lid / numéro et noms publics éventuels
          for (const p of g.participants) this.#saveContact(p);
        }
      });
      this.#emitChats(groups.map((g) => g.id));
    } catch (error) {
      logger.warn({ error }, 'groupes');
    }
  }

  /** Identifiants anonymes de la base sans numéro connu : demandés à Baileys (table locale). */
  async #resolveLids(sock: WASocket): Promise<void> {
    const lids = this.#store.unresolvedLids();
    const CHUNK = 500;
    try {
      for (let i = 0; i < lids.length; i += CHUNK) {
        // oxlint-disable-next-line no-await-in-loop -- lots successifs, sans saturer le magasin de clés
        const found = await sock.signalRepository.lidMapping.getPNsForLIDs(lids.slice(i, i + CHUNK));
        if (found !== null) this.#learn(found);
      }
    } catch (error) {
      logger.warn({ error }, 'résolution des lid');
    }
  }

  #parseRaw(raw: string): WAMessage | null {
    const wa: unknown = JSON.parse(raw, BufferJSON.reviver);
    if (typeof wa !== 'object' || wa === null || !('key' in wa)) return null;
    const msg = proto.WebMessageInfo.fromObject(wa);
    const { key } = msg;
    if (key === null || key === undefined) return null;
    return Object.assign(msg, { key });
  }

  /**
   * Réactions des bases antérieures : messages de réaction convertis puis retirés de la liste,
   * réactions portées par les messages bruts (historique) enregistrées.
   */
  backfillReactions(): void {
    if (!this.#store.flag('backfill-reactions')) return;
    const asMessages = this.#store.reactionMessagesToBackfill();
    const carried = this.#store.messagesWithReactions();
    this.#store.transaction(() => {
      for (const row of carried) {
        const wa = this.#parseRaw(row.raw);
        if (wa !== null) for (const r of reactionsOf(wa)) this.#react(r, false);
      }
      for (const row of asMessages) {
        const wa = this.#parseRaw(row.raw);
        const r = wa === null ? null : reactionOf(wa);
        if (r !== null) this.#react(r, false);
        this.#store.deleteMessage(row.chatId, row.id);
      }
    });
    this.#store.setFlag('backfill-reactions', false);
    logger.info(`réactions : ${carried.length} message(s) de l'historique, ${asMessages.length} ancienne(s) bulle(s) de réaction`);
  }

  /** Réagit à un message (émoji vide : réaction retirée). */
  async react(chatId: string, messageId: string, emoji: string): Promise<void> {
    const raw = this.#store.raw(chatId, messageId);
    const target = raw === null ? null : this.#parseRaw(raw);
    if (target === null) throw new Error('message introuvable');
    await this.#open().sendMessage(target.key.remoteJid ?? chatId, { react: { text: emoji, key: target.key } });
    // la réaction revient aussi par messages.upsert ; appliquée ici sans attendre
    this.#react({ chatId, targetId: messageId, sender: 'me', emoji, timestamp: Date.now() });
  }

  /**
   * Citations manquantes recalculées depuis les messages bruts (base antérieure, ou messages
   * envoyés avant le correctif du format de leur citation). Peu de lignes après le premier passage.
   */
  backfillQuoted(): void {
    const rows = this.#store.quotedToBackfill();
    this.#store.transaction(() => {
      for (const r of rows) {
        const content = normalizeContent(this.#parseRaw(r.raw));
        const q = content === undefined ? null : quotedOf(content);
        if (q !== null) this.#store.setQuoted(r.chatId, r.id, { ...q, sender: q.sender === null ? null : this.#jid(q.sender) });
      }
    });
    this.#store.setFlag('backfill-quoted', false);
    if (rows.length > 0) logger.info(`citations : ${rows.length} message(s) reconverti(s)`);
  }

  /** Base antérieure aux médias : `media` recalculé depuis les messages bruts. */
  backfillMedia(): void {
    const rows = this.#store.mediaToBackfill();
    this.#store.transaction(() => {
      for (const r of rows) {
        const content = normalizeContent(this.#parseRaw(r.raw));
        if (content !== undefined) this.#store.setMedia(r.chatId, r.id, mediaOf(content));
      }
    });
    if (rows.length > 0) logger.info(`médias : ${rows.length} message(s) reconverti(s)`);
  }

  /**
   * Contenu d'un média, téléchargé depuis WhatsApp (déchiffré) puis gardé en cache sur disque.
   * Média expiré sur les serveurs : renvoi demandé au téléphone (connexion ouverte nécessaire).
   */
  async media(chatId: string, id: string): Promise<{ mimetype: string; data: Buffer }> {
    const info = this.#store.media(chatId, id);
    const raw = this.#store.raw(chatId, id);
    if (info === null || raw === null) throw new Error('média introuvable');
    const file = path.join(this.#mediaDir, createHash('sha256').update(`${chatId}/${id}`).digest('hex'));
    try {
      return { mimetype: info.mimetype, data: await fs.promises.readFile(file) };
    } catch {
      // absent du cache : téléchargé ci-dessous
    }
    const wa = this.#parseRaw(raw);
    if (wa === null) throw new Error('message illisible');
    const sock = this.#sock;
    const data = await downloadMediaMessage(wa, 'buffer', {}, sock === null ? undefined : { logger, reuploadRequest: (m) => sock.updateMediaMessage(m) });
    await fs.promises.mkdir(this.#mediaDir, { recursive: true, mode: 0o700 });
    await fs.promises.writeFile(file, data, { mode: 0o600 });
    return { mimetype: info.mimetype, data };
  }

  #rawMessage(jid: string | null | undefined, id: string | null | undefined): proto.IMessage | undefined {
    if (jid === null || jid === undefined || id === null || id === undefined) return undefined;
    const raw = this.#store.raw(this.#jid(jid), id);
    return raw === null ? undefined : (this.#parseRaw(raw)?.message ?? undefined);
  }

  #emitChats(ids: readonly (string | null | undefined)[]): void {
    const chats = ids.flatMap((id) => {
      if (id === null || id === undefined) return [];
      const c = this.#store.chat(this.#jid(id));
      return c === null || c.timestamp === 0 ? [] : [c];
    });
    if (chats.length > 0) this.#emit({ type: 'chats', chats });
  }

  #restart(delay: number): void {
    setTimeout(() => {
      this.start().catch((error: unknown) => {
        this.#setStatus({ state: 'closed', error: errorText(error) });
        this.#restart(RECONNECT_MS);
      });
    }, delay);
  }

  /** Session et données locales effacées. */
  #forget(): void {
    fs.rmSync(this.#authDir, { recursive: true, force: true });
    fs.rmSync(this.#mediaDir, { recursive: true, force: true });
    this.#pictures.clear();
    this.#store.clear();
  }

  #open(): WASocket {
    if (this.#sock === null || this.#status.state !== 'open') throw new Error('WhatsApp non connecté');
    return this.#sock;
  }

  async send(chatId: string, text: string, replyTo?: string): Promise<void> {
    this.#sent(await this.#open().sendMessage(chatId, { text }, this.#quoteOptions(chatId, replyTo)));
  }

  /** Option d'envoi « en réponse à » : message cité tel qu'il est stocké (brut). */
  #quoteOptions(chatId: string, replyTo: string | undefined): { quoted: WAMessage } | undefined {
    if (replyTo === undefined || replyTo === '') return undefined;
    const raw = this.#store.raw(chatId, replyTo);
    const quoted = raw === null ? null : this.#parseRaw(raw);
    if (quoted === null) throw new Error('message cité introuvable');
    return { quoted };
  }

  /**
   * Messages antérieurs au plus ancien connu, demandés au téléphone (qui doit être en ligne) ;
   * ils arrivent plus tard par `messaging-history.set` (type ON_DEMAND).
   */
  async requestHistory(chatId: string): Promise<boolean> {
    const raw = this.#store.oldestRaw(chatId);
    const oldest = raw === null ? null : this.#parseRaw(raw);
    if (oldest === null) return false;
    await this.#open().fetchMessageHistory(50, oldest.key, seconds(oldest.messageTimestamp) * 1000);
    return true;
  }

  /** Fichier envoyé : photo, vidéo, audio ou document selon son type (légende sauf pour l'audio). */
  async sendMedia(chatId: string, f: Upload): Promise<void> {
    const caption = f.caption === '' ? {} : { caption: f.caption };
    const kind = uploadKind(f.mimetype, f.asDocument);
    const content =
      kind === 'image'
        ? { image: f.data, mimetype: f.mimetype, ...caption }
        : kind === 'video'
          ? { video: f.data, mimetype: f.mimetype, ...caption }
          : kind === 'audio'
            ? { audio: f.data, mimetype: f.mimetype }
            : { document: f.data, mimetype: f.mimetype, fileName: f.fileName, ...caption };
    this.#sent(await this.#open().sendMessage(chatId, content, this.#quoteOptions(chatId, f.replyTo)));
  }

  #sent(sent: WAMessage | undefined): void {
    // le message envoyé revient aussi par messages.upsert ; enregistré ici sans attendre
    if (sent !== undefined) {
      const m = this.#saveMessage(sent);
      if (m !== null) {
        this.#emit({ type: 'message', message: m });
        this.#emitChats([m.chatId]);
      }
    }
  }

  /** Discussion lue : accusés de lecture des derniers messages reçus, compteur remis à zéro. */
  /** Identifiant d'une discussion tel que WhatsApp le connaît (lid ou numéro) et ses derniers messages. */
  #target(chatId: string): { jid: string; lastMessages: { key: WAMessageKey; messageTimestamp: number }[] } {
    const raw = this.#store.lastRaw(chatId);
    const last = raw === null ? null : this.#parseRaw(raw);
    if (last === null) return { jid: chatId, lastMessages: [] };
    return { jid: last.key.remoteJid ?? chatId, lastMessages: [{ key: last.key, messageTimestamp: seconds(last.messageTimestamp) }] };
  }

  /** Identifiant d'une discussion dans les listes de WhatsApp : lid si connu (forme actuelle), sinon tel quel. */
  #listJid(chatId: string, fallback: string): string {
    return chatId.endsWith('@s.whatsapp.net') ? (this.#store.lidOf(chatId) ?? fallback) : fallback;
  }

  /**
   * Favoris : WhatsApp garde une seule action (`favoritesAction`, liste complète et ordonnée) ;
   * réécrite avec la discussion ajoutée ou retirée, sous la forme reçue (index, collection, version).
   */
  async #setFavorite(sock: WASocket, chatId: string, on: boolean): Promise<void> {
    const saved = FavoritesPatch.safeParse(JSON.parse(this.#store.meta('favorites-patch') ?? 'null'));
    const shape = saved.success ? saved.data : { index: ['favorites'], collection: 'regular_high' as const, version: 7, ids: [] };
    const kept = shape.ids.filter((id) => this.#jid(id) !== chatId);
    const ids = on ? [...kept, this.#listJid(chatId, this.#target(chatId).jid)] : kept;
    await sock.appPatch({
      syncAction: { favoritesAction: { favorites: ids.map((id) => ({ id })) }, timestamp: Date.now() },
      index: shape.index,
      type: shape.collection,
      apiVersion: shape.version,
      operation: proto.SyncdMutation.SyncdOperation.SET,
    });
    this.#store.setMeta('favorites-patch', JSON.stringify({ ...shape, ids }));
    this.#store.setFavorites(ids.map((id) => this.#jid(id)));
  }

  /** Photo de profil d'une discussion (personne ou groupe), null sans photo. */
  picture(chatId: string): Promise<Buffer | null> {
    return this.#pictures.get(chatId);
  }

  /** Action du menu d'une discussion : appliquée sur WhatsApp, puis localement. */
  async chatAction(chatId: string, a: ChatAction): Promise<void> {
    const sock = this.#open();
    const { jid, lastMessages } = this.#target(chatId);
    switch (a.action) {
      case 'archive':
        await sock.chatModify({ archive: a.value, lastMessages }, jid);
        this.#store.upsertChat({ id: chatId, archived: a.value });
        break;
      case 'mute':
        // WhatsApp : fin du silence en ms, -1 pour toujours ; null réactive
        await sock.chatModify({ mute: a.until }, jid);
        this.#store.upsertChat({ id: chatId, mutedUntil: a.until ?? 0 });
        break;
      case 'pin':
        if (a.value && this.#store.pinnedCount() >= MAX_PINNED) throw new Error(`${MAX_PINNED} discussions épinglées au plus`);
        await sock.chatModify({ pin: a.value }, jid);
        this.#store.upsertChat({ id: chatId, pinned: a.value ? Date.now() : 0 });
        break;
      case 'unread':
        await sock.chatModify({ markRead: !a.value, lastMessages }, jid);
        if (a.value) this.#store.upsertChat({ id: chatId, markedUnread: true });
        else this.#store.markRead(chatId);
        break;
      case 'clear':
        await sock.chatModify({ clear: true, lastMessages }, jid);
        this.#store.clearMessages(chatId);
        this.#emit({ type: 'chat.cleared', id: chatId });
        break;
      case 'delete':
        await sock.chatModify({ delete: true, lastMessages }, jid);
        this.#store.deleteChats([chatId]);
        this.#emit({ type: 'chats.delete', ids: [chatId] });
        return;
      case 'leave':
        await sock.groupLeave(chatId);
        break;
      case 'favorite':
        await this.#setFavorite(sock, chatId, a.value);
        break;
      case 'label':
        await sock.chatModify(a.value ? { addChatLabel: { labelId: a.labelId } } : { removeChatLabel: { labelId: a.labelId } }, this.#listJid(chatId, jid));
        this.#store.setChatLabel(chatId, a.labelId, a.value);
        break;
      default:
        a satisfies never;
    }
    this.#emitChats([chatId]);
  }

  async markRead(chatId: string): Promise<void> {
    const marked = this.#store.chat(chatId)?.markedUnread === true;
    this.#store.markRead(chatId);
    this.#emitChats([chatId]);
    const sock = this.#sock;
    if (sock === null || this.#status.state !== 'open') return;
    // clés d'origine des messages (identifiants tels que reçus : lid ou numéro)
    const keys = this.#store
      .messages(chatId, 20)
      .filter((m) => !m.fromMe)
      .flatMap((m) => {
        const raw = this.#store.raw(chatId, m.id);
        const key = raw === null ? null : (this.#parseRaw(raw)?.key ?? null);
        return key === null ? [] : [key];
      });
    if (keys.length > 0) await sock.readMessages(keys);
    // « marquée comme non lue » sur un appareil : levée partout
    if (marked) {
      const { jid, lastMessages } = this.#target(chatId);
      await sock.chatModify({ markRead: true, lastMessages }, jid);
    }
  }

  /** Déconnexion du compte (l'appareil disparaît de la liste du téléphone). */
  async logout(): Promise<void> {
    await this.#open().logout();
  }

  stop(): void {
    this.#stopped = true;
    // oxlint-disable-next-line unicorn/no-useless-undefined -- paramètre obligatoire (erreur de fermeture)
    void this.#sock?.end(undefined);
    this.#sock = null;
  }
}

/** Forme de l'action des favoris reçue de WhatsApp (voir le patch de Baileys). */
const FavoritesPatch = z.object({
  index: z.array(z.string()),
  collection: z.enum(ALL_WA_PATCH_NAMES),
  version: z.number(),
  ids: z.array(z.string()),
});

/** Fin du mode silencieux en ms (-1 : toujours, 0 : non) ; certaines sources la donnent en secondes. */
const muteEnd = (t: number | { toNumber: () => number } | null | undefined): number => {
  const v = seconds(t);
  if (v === -1 || v <= 0) return v === -1 ? -1 : 0;
  return v < 1e12 ? v * 1000 : v;
};

const normalizeContent = (wa: WAMessage | null): proto.IMessage | undefined => (wa === null ? undefined : normalizeMessageContent(wa.message));
