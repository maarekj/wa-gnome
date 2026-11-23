// CLI `wa` : désignation des discussions, durées, et chaque commande en mode non interactif
// (comme un agent : --json, --no-input) sur le faux démon.
import assert from 'node:assert/strict';
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import * as z from 'zod/mini';
import type { Chat } from '../shared/api.ts';
import { match, parseDuration, parseWhen, phoneOf } from './resolve.ts';

const root = path.resolve(import.meta.dirname, '..', '..');

const chat = (id: string, name: string): Chat => ({
  id,
  name,
  group: false,
  unread: 0,
  timestamp: 0,
  preview: '',
  archived: false,
  mutedUntil: 0,
  pinned: 0,
  markedUnread: false,
  labels: [],
  favorite: false,
  ephemeral: 0,
  readOnly: null,
});

void describe('désignation', () => {
  const chats = [chat('1@s', 'Élodie Bernard'), chat('2@s', 'Élodie'), chat('3@s', 'Marc Dubois'), chat('4@s', 'Marcel')];
  const m = (q: string) =>
    match(
      chats,
      q,
      (c) => c.id,
      (c) => c.name,
    );
  void it('identifiant, nom exact (accents ignorés), début, contenu', () => {
    assert.deepEqual(m('3@s'), { kind: 'one', item: chats[2] });
    assert.deepEqual(m('elodie'), { kind: 'one', item: chats[1] });
    assert.deepEqual(m('bern'), { kind: 'one', item: chats[0] });
    assert.equal(m('marc').kind, 'many');
    assert.equal(m('zzz').kind, 'none');
  });
  void it('numéros', () => {
    assert.equal(phoneOf('+33 6 12 34 56 78'), '33612345678');
    assert.equal(phoneOf('Alice'), null);
  });
  void it('durées et heures', () => {
    assert.equal(parseDuration('8h'), 8 * 3_600_000);
    assert.equal(parseDuration('2j'), 2 * 86_400_000);
    assert.equal(parseDuration('toujours'), -1);
    assert.throws(() => parseDuration('bientôt'));
    const now = new Date(2026, 0, 10, 20, 0);
    assert.equal(parseWhen('+30m', now), Math.floor(now.getTime() / 1000) + 1800);
    // heure passée : demain
    assert.equal(parseWhen('18:30', now), Math.floor(new Date(2026, 0, 11, 18, 30).getTime() / 1000));
  });
});

const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => {
      const a = srv.address();
      srv.close(() => resolve(typeof a === 'object' && a !== null ? a.port : 4793));
    });
  });

void describe('commandes sur le faux démon', () => {
  let fake: ChildProcess;
  let port = 0;
  let control = 0;
  const dir = `/tmp/wa-gnome-cli-test-${process.pid}`;
  /** CLI lancée comme par un agent : pas de terminal */
  const wa = (...args: string[]): { code: number | null; out: string; err: string } => {
    const r = spawnSync(process.execPath, [path.join(root, 'src', 'cli', 'main.ts'), ...args], {
      env: { ...process.env, WA_GNOME_DATA_DIR: dir, WA_GNOME_PORT: String(port), NO_COLOR: '1' },
      encoding: 'utf8',
      input: '',
    });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const json = (...args: string[]): unknown => {
    const r = wa(...args, '--json');
    assert.equal(r.code, 0, r.err);
    return JSON.parse(r.out);
  };
  const Calls = z.array(z.object({ method: z.string(), args: z.array(z.unknown()) }));
  const lastCall = async (): Promise<{ method: string; args: unknown[] } | undefined> =>
    z.parse(Calls, await (await fetch(`http://127.0.0.1:${control}/calls`)).json()).at(-1);

  before(async () => {
    port = await freePort();
    control = await freePort();
    fake = spawn(
      process.execPath,
      [path.join(root, 'scripts', 'fake-daemon.ts'), '--port', String(port), '--dir', dir, '--control', String(control), '--no-replies'],
      { stdio: 'ignore' },
    );
    // démarrage du faux démon : jusqu'à 20 s (machine chargée)
    for (let i = 0; i < 200; i += 1) {
      try {
        await fetch(`http://127.0.0.1:${port}/status`); // oxlint-disable-line no-await-in-loop -- attente du démarrage
        return;
      } catch {
        // oxlint-disable-next-line no-await-in-loop -- attente du démarrage
        await new Promise((r) => {
          setTimeout(r, 100);
        });
      }
    }
  });
  after(() => {
    fake.kill();
  });

  void it('status, chats (filtres), lists', () => {
    assert.equal(z.parse(z.object({ state: z.string() }), json('status')).state, 'open');
    const chats = z.parse(z.array(z.object({ name: z.string(), group: z.boolean(), unread: z.number() })), json('chats', '-n', '50'));
    assert.ok(chats.some((c) => c.name === 'Famille'));
    assert.ok(z.parse(z.array(z.object({ group: z.boolean() })), json('chats', '--groups')).every((c) => c.group));
    const voisinage = z.parse(z.array(z.object({ name: z.string() })), json('chats', '--list', 'voisinage'));
    assert.deepEqual(voisinage.map((c) => c.name).toSorted(), ['Voisins', '~ Bob'].toSorted());
    const lists = z.parse(z.array(z.object({ name: z.string(), chats: z.number() })), json('lists'));
    assert.equal(lists.find((l) => l.name === 'Voisinage')?.chats, 2);
  });

  void it('messages : nom approché, nombre, ordre chronologique', () => {
    const msgs = z.parse(z.array(z.object({ timestamp: z.number(), chatId: z.string() })), json('messages', 'claire', '-n', '5'));
    assert.equal(msgs.length, 5);
    assert.ok(msgs.every((m, i) => i === 0 || (msgs[i - 1]?.timestamp ?? 0) <= m.timestamp));
  });

  void it('send : texte en arguments, par un tube, réponse', async () => {
    assert.deepEqual(json('send', 'alice', 'Bonjour', 'Alice'), { ok: true, chatId: '33600000001@s.whatsapp.net' });
    assert.deepEqual(await lastCall(), { method: 'send', args: ['33600000001@s.whatsapp.net', 'Bonjour Alice', null, null] });
    const piped = spawnSync(process.execPath, [path.join(root, 'src', 'cli', 'main.ts'), 'send', 'Famille', '--json'], {
      env: { ...process.env, WA_GNOME_DATA_DIR: dir, WA_GNOME_PORT: String(port) },
      input: 'Texte\nsur deux lignes\n',
      encoding: 'utf8',
    });
    assert.equal(piped.status, 0, piped.stderr);
    assert.equal((await lastCall())?.args[1], 'Texte\nsur deux lignes');
  });

  void it('actions sur une discussion et listes', async () => {
    json('chat', 'mute', 'voisins', '--for', 'toujours');
    assert.deepEqual((await lastCall())?.args[1], { action: 'mute', until: -1 });
    json('chat', 'archive', 'famille');
    assert.deepEqual((await lastCall())?.args[1], { action: 'archive', value: true });
    json('lists', 'add', 'Voisinage', 'Alice');
    assert.deepEqual((await lastCall())?.args, ['33600000001@s.whatsapp.net', { action: 'label', labelId: '4', value: true }]);
  });

  void it('groupe réservé aux administrateurs : envoi refusé par le démon', async () => {
    const r = wa('send', 'Voisins', 'Bonjour', '--json');
    assert.equal(r.code, 1);
    assert.match(r.err, /Seuls les administrateurs/u);
    assert.notEqual((await lastCall())?.args[1], 'Bonjour');
  });

  void it('agent : entrée standard ouverte jamais fermée, pas de blocage', async () => {
    const child = spawn(process.execPath, [path.join(root, 'src', 'cli', 'main.ts'), 'send', 'Alice', '--no-input', '--json'], {
      env: { ...process.env, WA_GNOME_DATA_DIR: dir, WA_GNOME_PORT: String(port) },
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    const code = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => {
        child.kill();
        resolve(null);
      }, 5000);
      child.on('exit', (c) => {
        clearTimeout(timer);
        resolve(c);
      });
    });
    assert.equal(code, 2);
  });

  void it('agent : jamais de question, erreurs claires et codes de sortie', () => {
    const missing = wa('send', '--no-input');
    assert.equal(missing.code, 2);
    assert.match(missing.err, /discussion manquante/u);
    const ambiguous = wa('messages', 'a');
    assert.equal(ambiguous.code, 2);
    assert.match(ambiguous.err, /plusieurs discussions/u);
    assert.equal(wa('messages', 'personne-xyz').code, 2);
    const down = spawnSync(process.execPath, [path.join(root, 'src', 'cli', 'main.ts'), 'status'], {
      env: { ...process.env, WA_GNOME_DATA_DIR: dir, WA_GNOME_PORT: '9' },
      encoding: 'utf8',
    });
    assert.equal(down.status, 3);
    assert.match(down.stderr, /injoignable/u);
  });
});
