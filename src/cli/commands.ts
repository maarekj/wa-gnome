// Commandes de la CLI (Stricli). Chaque commande : options communes (--json, --account,
// --no-input), paramètres manquants demandés dans un terminal, erreur d'usage sinon.
import fs from 'node:fs';
import path from 'node:path';
import { buildCommand, buildRouteMap, type CommandContext, numberParser } from '@stricli/core';
import { type Chat, type ChatAction, type ChatList, DEFAULT_ACCOUNT } from '../shared/api.ts';
import { CliError, Client, endpoint } from './client.ts';
import { chatLines, hitLines, jidLabel, messageLines, paint, when } from './format.ts';
import { ask, confirmed, resolveChat, resolveList, type Session, USAGE } from './prompt.ts';
import { inList, parseDuration, parseWhen } from './resolve.ts';

export type Ctx = CommandContext;

/** Options présentes sur toutes les commandes. */
interface Common {
  readonly json: boolean;
  readonly account: string | undefined;
  readonly input: boolean;
}

const common = {
  json: { kind: 'boolean', brief: 'Sortie JSON (pour les scripts et les agents)', default: false },
  account: { kind: 'parsed', parse: String, brief: 'Compte (identifiant, voir `wa accounts`)', optional: true },
  input: { kind: 'boolean', brief: 'Demander ce qui manque dans un terminal ; --no-input : jamais (erreur, code 2)', default: true },
} as const;

/** Session d'une commande. */
export function session(flags: Common, proc: NodeJS.Process = process): Session {
  return {
    // interaction seulement dans un terminal (entrée et sortie), jamais en JSON ni avec --no-input
    interactive: flags.input && !flags.json && proc.stdin.isTTY && proc.stdout.isTTY && proc.env['CI'] === undefined,
    client: new Client(endpoint(proc.env), flags.account ?? DEFAULT_ACCOUNT),
    prompted: false,
  };
}

/** Résultat : JSON (`--json`) ou lignes lisibles. */
function print(flags: Common, data: unknown, human: () => readonly string[]): void {
  if (flags.json) process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
  else {
    const lines = human();
    process.stdout.write(lines.length === 0 ? `${paint('dim', '(rien)')}\n` : `${lines.join('\n')}\n`);
  }
}

/** Action faite : `{ ok: true, … }` en JSON, phrase sinon. */
function done(flags: Common, text: string, data: Record<string, unknown> = {}): void {
  print(flags, { ok: true, ...data }, () => [`${paint('green', '✓')} ${text}`]);
}

const chatArg = { brief: 'Discussion : identifiant, nom (approché) ou numéro', parse: String, optional: true, placeholder: 'discussion' } as const;
const required = (brief: string, placeholder: string) => ({ brief, parse: String, placeholder }) as const;

/** Lecture de l'entrée standard (texte passé par un tube : `echo … | wa send Alice`). */
function stdinText(): string | null {
  if (process.stdin.isTTY) return null;
  try {
    const t = fs.readFileSync(0, 'utf8').trimEnd();
    return t === '' ? null : t;
  } catch {
    return null;
  }
}

/** Type d'un fichier d'après son extension (le démon en déduit photo, vidéo, audio ou document). */
const MIME: Readonly<Record<string, string>> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.zip': 'application/zip',
};
export const mimeOf = (file: string): string => MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';

// ---------------------------------------------------------------- consultation

const status = buildCommand({
  docs: { brief: 'État de la connexion WhatsApp' },
  parameters: { flags: common },
  async func(this: Ctx, flags: Common) {
    const st = await session(flags).client.status();
    print(flags, st, () => [
      `État : ${paint('bold', st.state)}${st.me === null ? '' : ` — ${st.me.name ?? ''} ${jidLabel(st.me.id)}`}`,
      ...(st.error === null ? [] : [paint('red', `Erreur : ${st.error}`)]),
      ...(st.state === 'qr' ? ['Appareil à appairer : ouvrir l’application pour scanner le QR code'] : []),
    ]);
  },
});

const accounts = buildCommand({
  docs: { brief: 'Comptes du démon' },
  parameters: { flags: common },
  async func(this: Ctx, flags: Common) {
    const list = await session(flags).client.accounts();
    print(flags, list, () =>
      list.map((a) => `${paint('bold', a.id)}  ${a.status.state}${a.status.me === null ? '' : `  ${a.status.me.name ?? ''} ${jidLabel(a.status.me.id)}`}`),
    );
  },
});

interface ChatsFlags extends Common {
  readonly unread: boolean;
  readonly archived: boolean;
  readonly groups: boolean;
  readonly list: string | undefined;
  readonly limit: number;
}

/** Discussions retenues par les filtres (ordre du démon : épinglées puis plus récentes). */
export function filterChats(chats: readonly Chat[], f: { unread: boolean; archived: boolean; groups: boolean; list?: ChatList }): Chat[] {
  return chats.filter(
    (c) =>
      !c.id.endsWith('@broadcast') &&
      !c.id.endsWith('@newsletter') &&
      c.archived === f.archived &&
      (!f.unread || c.unread > 0 || c.markedUnread) &&
      (!f.groups || c.group) &&
      (f.list === undefined || inList(c, f.list)),
  );
}

const chats = buildCommand({
  docs: { brief: 'Liste des discussions (épinglées, puis les plus récentes)' },
  parameters: {
    flags: {
      ...common,
      unread: { kind: 'boolean', brief: 'Non lues seulement', default: false },
      archived: { kind: 'boolean', brief: 'Archivées (à la place des autres)', default: false },
      groups: { kind: 'boolean', brief: 'Groupes seulement', default: false },
      list: { kind: 'parsed', parse: String, brief: 'Discussions de cette liste (nom)', optional: true },
      limit: { kind: 'parsed', parse: numberParser, brief: 'Nombre au plus', default: '30' },
    },
    aliases: { n: 'limit', u: 'unread', l: 'list' },
  },
  async func(this: Ctx, flags: ChatsFlags) {
    const s = session(flags);
    const [all, lists] = await Promise.all([s.client.chats(), s.client.lists()]);
    const list = flags.list === undefined ? undefined : await resolveList(s, flags.list);
    const shown = filterChats(all, {
      unread: flags.unread,
      archived: flags.archived,
      groups: flags.groups,
      ...(list === undefined ? {} : { list }),
    }).slice(0, flags.limit);
    print(flags, shown, () => chatLines(shown, lists));
  },
});

interface MessagesFlags extends Common {
  readonly limit: number;
  readonly before: number | undefined;
  readonly markRead: boolean;
}

const messages = buildCommand({
  docs: { brief: 'Derniers messages d’une discussion (du plus ancien au plus récent)' },
  parameters: {
    flags: {
      ...common,
      limit: { kind: 'parsed', parse: numberParser, brief: 'Nombre de messages', default: '20' },
      before: { kind: 'parsed', parse: numberParser, brief: 'Messages antérieurs à cet horodatage (secondes ; pagination)', optional: true },
      markRead: { kind: 'boolean', brief: 'Marquer la discussion comme lue', default: false },
    },
    positional: { kind: 'tuple', parameters: [chatArg] },
    aliases: { n: 'limit' },
  },
  async func(this: Ctx, flags: MessagesFlags, query?: string) {
    const s = session(flags);
    const chat = await resolveChat(s, query);
    const list = await s.client.messages(chat.id, Math.max(1, Math.min(flags.limit, 500)), flags.before);
    if (flags.markRead) await s.client.read(chat.id);
    print(flags, list, () => [paint(['bold', 'underline'], chat.name), ...messageLines(list)]);
  },
});

interface SearchFlags extends Common {
  readonly chat: string | undefined;
  readonly limit: number;
}

const search = buildCommand({
  docs: { brief: 'Recherche dans les messages (toutes les discussions, ou une seule)' },
  parameters: {
    flags: {
      ...common,
      chat: { kind: 'parsed', parse: String, brief: 'Dans cette discussion seulement', optional: true },
      limit: { kind: 'parsed', parse: numberParser, brief: 'Résultats au plus', default: '30' },
    },
    positional: { kind: 'tuple', parameters: [{ ...required('Texte cherché', 'texte'), optional: true }] },
    aliases: { n: 'limit', c: 'chat' },
  },
  async func(this: Ctx, flags: SearchFlags, query?: string) {
    const s = session(flags);
    const q = query ?? (await ask(s, 'Texte cherché'));
    const chat = flags.chat === undefined ? undefined : await resolveChat(s, flags.chat);
    const hits = await s.client.search(q, Math.max(1, Math.min(flags.limit, 200)), chat?.id);
    print(flags, hits, () => hitLines(hits));
  },
});

const contacts = buildCommand({
  docs: { brief: 'Contacts du carnet (filtrés par nom ou numéro)' },
  parameters: { flags: common, positional: { kind: 'tuple', parameters: [{ ...required('Nom ou numéro', 'filtre'), optional: true }] } },
  async func(this: Ctx, flags: Common, query?: string) {
    const all = await session(flags).client.contacts();
    const q = (query ?? '').toLowerCase();
    const shown = q === '' ? all : all.filter((c) => c.name.toLowerCase().includes(q) || c.id.includes(q.replaceAll(/\D/gu, '') || '\u0000'));
    print(flags, shown, () => shown.map((c) => `${paint('bold', c.name)}  ${paint('dim', `${jidLabel(c.id)}  ${c.id}`)}`));
  },
});

const info = buildCommand({
  docs: { brief: 'Fiche d’une discussion (contact ou groupe, membres)' },
  parameters: { flags: common, positional: { kind: 'tuple', parameters: [chatArg] } },
  async func(this: Ctx, flags: Common, query?: string) {
    const s = session(flags);
    const chat = await resolveChat(s, query);
    const data = await s.client.info(chat.id);
    print(flags, data, () => [`${paint('bold', chat.name)}  ${paint('dim', chat.id)}`, JSON.stringify(data, null, 2)]);
  },
});

// ---------------------------------------------------------------- envoi

interface SendFlags extends Common {
  readonly file: string | undefined;
  readonly replyTo: string | undefined;
  readonly document: boolean;
  readonly at: string | undefined;
}

const send = buildCommand({
  docs: {
    brief: 'Envoie un message (texte en arguments, par un tube, ou demandé), ou un fichier',
    fullDescription:
      'Texte : arguments après la discussion, ou entrée standard (`echo bonjour | wa send Alice -` ; « - » requis avec --no-input). Fichier : --file (le texte devient sa légende). --at : message programmé (18:30, +2h, 2026-12-24T09:00).',
  },
  parameters: {
    flags: {
      ...common,
      file: { kind: 'parsed', parse: String, brief: 'Fichier à envoyer (photo, vidéo, audio, document)', optional: true },
      replyTo: { kind: 'parsed', parse: String, brief: 'Réponse à ce message (identifiant, voir `wa messages`)', optional: true },
      document: { kind: 'boolean', brief: 'Fichier envoyé comme document (même une photo)', default: false },
      at: { kind: 'parsed', parse: String, brief: 'Programmer l’envoi (18:30, +2h, date ISO)', optional: true },
    },
    positional: { kind: 'array', parameter: { brief: 'Discussion, puis texte', parse: String, placeholder: 'discussion texte' } },
    aliases: { f: 'file', r: 'replyTo' },
  },
  async func(this: Ctx, flags: SendFlags, ...args: string[]) {
    const s = session(flags);
    const [query, ...words] = args;
    const chat = await resolveChat(s, query);
    let text: string | null = words.length > 0 ? words.join(' ') : null;
    // entrée standard : lue si demandée (« - »), ou d'office sans texte ni fichier hors --no-input
    // (un agent garde parfois l'entrée ouverte sans rien écrire : la lecture ne finirait jamais)
    if (text === '-' || (text === null && flags.file === undefined && flags.input)) text = stdinText();
    if (text === null && flags.file === undefined) text = await ask(s, `Message pour ${chat.name}`);
    if (flags.at !== undefined) {
      if (flags.file !== undefined) throw new CliError('--at : texte seulement (pas de fichier)', USAGE);
      if (text === null) throw new CliError('texte manquant', USAGE);
      const at = parseWhen(flags.at);
      if (!(await confirmed(s, `Programmer pour ${chat.name} (${when(at)}) ?`))) return;
      await s.client.schedule(chat.id, text, at, flags.replyTo);
      done(flags, `Programmé pour ${chat.name} à ${when(at)}`, { chatId: chat.id, at });
      return;
    }
    if (!(await confirmed(s, `Envoyer à ${chat.name} ?`))) return;
    if (flags.file !== undefined) {
      await s.client.sendFile(chat.id, flags.file, {
        mimetype: mimeOf(flags.file),
        asDocument: flags.document,
        ...(text === null ? {} : { caption: text }),
        ...(flags.replyTo === undefined ? {} : { replyTo: flags.replyTo }),
      });
      done(flags, `Fichier envoyé à ${chat.name}`, { chatId: chat.id });
      return;
    }
    if (text === null) throw new CliError('texte manquant', USAGE);
    await s.client.send(chat.id, { text, ...(flags.replyTo === undefined ? {} : { replyTo: flags.replyTo }) });
    done(flags, `Envoyé à ${chat.name}`, { chatId: chat.id });
  },
});

const scheduled = buildCommand({
  docs: { brief: 'Messages programmés d’une discussion' },
  parameters: { flags: common, positional: { kind: 'tuple', parameters: [chatArg] } },
  async func(this: Ctx, flags: Common, query?: string) {
    const s = session(flags);
    const chat = await resolveChat(s, query);
    const list = await s.client.scheduled(chat.id);
    print(flags, list, () =>
      list.map((m) => `${paint('bold', when(m.at))}  ${m.text}${m.error === null ? '' : paint('red', `  (${m.error})`)}\n  ${paint('dim', m.id)}`),
    );
  },
});

const unschedule = buildCommand({
  docs: { brief: 'Annule un message programmé' },
  parameters: { flags: common, positional: { kind: 'tuple', parameters: [required('Identifiant (voir `wa scheduled`)', 'id')] } },
  async func(this: Ctx, flags: Common, id: string) {
    await session(flags).client.unschedule(id);
    done(flags, 'Message programmé annulé', { id });
  },
});

// ---------------------------------------------------------------- messages

const messageArgs = [
  required('Discussion : identifiant, nom (approché) ou numéro', 'discussion'),
  required('Message (identifiant, voir `wa messages`)', 'message'),
] as const;

const react = buildCommand({
  docs: { brief: 'Réagit à un message (émoji ; vide : réaction retirée)' },
  parameters: { flags: common, positional: { kind: 'tuple', parameters: [...messageArgs, required('Émoji', 'émoji')] } },
  async func(this: Ctx, flags: Common, query: string, mid: string, emoji: string) {
    const s = session(flags);
    const chat = await resolveChat(s, query);
    await s.client.react(chat.id, mid, emoji);
    done(flags, emoji === '' ? 'Réaction retirée' : `Réaction ${emoji} envoyée`);
  },
});

const edit = buildCommand({
  docs: { brief: 'Modifie un de mes messages (15 min au plus après l’envoi)' },
  parameters: { flags: common, positional: { kind: 'tuple', parameters: [...messageArgs, required('Nouveau texte', 'texte')] } },
  async func(this: Ctx, flags: Common, query: string, mid: string, text: string) {
    const s = session(flags);
    const chat = await resolveChat(s, query);
    await s.client.messageAction(chat.id, mid, { action: 'edit', text });
    done(flags, 'Message modifié');
  },
});

interface DeleteFlags extends Common {
  readonly everyone: boolean;
}

const remove = buildCommand({
  docs: { brief: 'Supprime un message pour moi (--everyone : pour tous, mes messages)' },
  parameters: {
    flags: { ...common, everyone: { kind: 'boolean', brief: 'Supprimer pour tous', default: false } },
    positional: { kind: 'tuple', parameters: [...messageArgs] },
  },
  async func(this: Ctx, flags: DeleteFlags, query: string, mid: string) {
    const s = session(flags);
    const chat = await resolveChat(s, query);
    await s.client.messageAction(chat.id, mid, { action: flags.everyone ? 'revoke' : 'delete-for-me' });
    done(flags, flags.everyone ? 'Supprimé pour tous' : 'Supprimé pour moi');
  },
});

const forward = buildCommand({
  docs: { brief: 'Transfère un message vers d’autres discussions' },
  parameters: {
    flags: common,
    positional: {
      kind: 'array',
      parameter: { brief: 'Discussion source, message, puis destinations', parse: String, placeholder: 'discussion message destination' },
    },
  },
  async func(this: Ctx, flags: Common, ...args: string[]) {
    const [from, mid, ...to] = args;
    if (from === undefined || mid === undefined || to.length === 0) throw new CliError('usage : wa forward <discussion> <message> <destination>…', USAGE);
    const s = session(flags);
    const chat = await resolveChat(s, from);
    const targets: Chat[] = [];
    for (const t of to) targets.push(await resolveChat(s, t)); // oxlint-disable-line no-await-in-loop -- choix éventuel, un à la fois
    await s.client.messageAction(chat.id, mid, { action: 'forward', to: targets.map((t) => t.id) });
    done(flags, `Transféré à ${targets.map((t) => t.name).join(', ')}`);
  },
});

// ---------------------------------------------------------------- discussion

/** Commande d'action sur une discussion (archiver, épingler…). */
function chatCommand(brief: string, action: ChatAction, text: string) {
  return buildCommand({
    docs: { brief },
    parameters: { flags: common, positional: { kind: 'tuple', parameters: [chatArg] } },
    async func(this: Ctx, flags: Common, query?: string) {
      const s = session(flags);
      const chat = await resolveChat(s, query);
      await s.client.chatAction(chat.id, action);
      done(flags, `${chat.name} : ${text}`, { chatId: chat.id });
    },
  });
}

interface MuteFlags extends Common {
  readonly for: string;
}

const mute = buildCommand({
  docs: { brief: 'Mode silencieux (--for 8h, 1w, toujours)' },
  parameters: {
    flags: { ...common, for: { kind: 'parsed', parse: String, brief: 'Durée : 30m, 8h, 2j, 1w, toujours', default: '8h' } },
    positional: { kind: 'tuple', parameters: [chatArg] },
  },
  async func(this: Ctx, flags: MuteFlags, query?: string) {
    const s = session(flags);
    const d = parseDuration(flags.for);
    const chat = await resolveChat(s, query);
    await s.client.chatAction(chat.id, { action: 'mute', until: d === -1 ? -1 : Date.now() + d });
    done(flags, `${chat.name} : silencieuse ${d === -1 ? 'toujours' : `pendant ${flags.for}`}`, { chatId: chat.id });
  },
});

const read = buildCommand({
  docs: { brief: 'Marque une discussion comme lue' },
  parameters: { flags: common, positional: { kind: 'tuple', parameters: [chatArg] } },
  async func(this: Ctx, flags: Common, query?: string) {
    const s = session(flags);
    const chat = await resolveChat(s, query);
    await s.client.read(chat.id);
    done(flags, `${chat.name} : lue`, { chatId: chat.id });
  },
});

const chat = buildRouteMap({
  docs: { brief: 'Actions sur une discussion' },
  routes: {
    archive: chatCommand('Archive une discussion', { action: 'archive', value: true }, 'archivée'),
    unarchive: chatCommand('Désarchive une discussion', { action: 'archive', value: false }, 'désarchivée'),
    pin: chatCommand('Épingle une discussion (3 au plus)', { action: 'pin', value: true }, 'épinglée'),
    unpin: chatCommand('Désépingle une discussion', { action: 'pin', value: false }, 'désépinglée'),
    mute,
    unmute: chatCommand('Réactive les notifications', { action: 'mute', until: null }, 'notifications réactivées'),
    read,
    unread: chatCommand('Marque une discussion comme non lue', { action: 'unread', value: true }, 'non lue'),
    favorite: chatCommand('Ajoute aux favoris', { action: 'favorite', value: true }, 'ajoutée aux favoris'),
    unfavorite: chatCommand('Retire des favoris', { action: 'favorite', value: false }, 'retirée des favoris'),
  },
});

// ---------------------------------------------------------------- listes

const listsShow = buildCommand({
  docs: { brief: 'Listes de discussions (et nombre de discussions)' },
  parameters: { flags: common },
  async func(this: Ctx, flags: Common) {
    const s = session(flags);
    const [lists, all] = await Promise.all([s.client.lists(), s.client.chats()]);
    const data = lists.map((l) => ({ id: l.id, name: l.name, color: l.color, kind: l.kind, chats: all.filter((c) => inList(c, l)).length }));
    print(flags, data, () => data.map((l) => `${paint('bold', l.name)}  ${paint('dim', `${l.chats} discussion(s) · ${l.kind} · ${l.id}`)}`));
  },
});

/** Ajout à une liste, ou retrait. */
function listMember(value: boolean) {
  return buildCommand({
    docs: { brief: value ? 'Ajoute une discussion à une liste' : 'Retire une discussion d’une liste' },
    parameters: {
      flags: common,
      positional: { kind: 'tuple', parameters: [{ ...required('Liste (nom)', 'liste'), optional: true }, chatArg] },
    },
    async func(this: Ctx, flags: Common, listQuery?: string, chatQuery?: string) {
      const s = session(flags);
      const list = await resolveList(s, listQuery);
      const target = await resolveChat(s, chatQuery);
      await s.client.chatAction(target.id, { action: 'label', labelId: list.id, value });
      done(flags, value ? `${target.name} ajoutée à « ${list.name} »` : `${target.name} retirée de « ${list.name} »`, { chatId: target.id, listId: list.id });
    },
  });
}

const listsChats = buildCommand({
  docs: { brief: 'Discussions d’une liste' },
  parameters: { flags: common, positional: { kind: 'tuple', parameters: [{ ...required('Liste (nom)', 'liste'), optional: true }] } },
  async func(this: Ctx, flags: Common, query?: string) {
    const s = session(flags);
    const list = await resolveList(s, query);
    const [all, lists] = await Promise.all([s.client.chats(), s.client.lists()]);
    const shown = filterChats(all, { unread: false, archived: false, groups: false, list });
    print(flags, shown, () => chatLines(shown, lists));
  },
});

const lists = buildRouteMap({
  docs: { brief: 'Listes de discussions : voir, ajouter, retirer' },
  defaultCommand: 'ls',
  routes: { ls: listsShow, show: listsChats, add: listMember(true), remove: listMember(false) },
  aliases: { rm: 'remove' },
});

export const routes = buildRouteMap({
  docs: { brief: 'Client WhatsApp en ligne de commande (démon wa-gnome)' },
  routes: { status, accounts, chats, messages, send, search, contacts, info, chat, lists, react, edit, delete: remove, forward, scheduled, unschedule },
  aliases: { ls: 'chats', m: 'messages', s: 'send' },
});
