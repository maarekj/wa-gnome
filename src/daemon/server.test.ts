// Serveur HTTP du démon : jeton, routes, bornes des paramètres, comptes (faux Backend, vraie base).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import { after, before, describe, it } from 'node:test';
import type { Converted } from './convert.ts';
import { type Account, type Backend, type Server, startServer } from './server.ts';
import { Store } from './store.ts';
import * as z from 'zod/mini';

const Ids = z.array(z.object({ id: z.string() }));
const ids = async (r: Promise<Response>): Promise<string[]> => z.parse(Ids, await (await r).json()).map((m) => m.id);

const TOKEN = 'jeton-de-test';
const CHAT = '33600000001@s.whatsapp.net';
const DB = `/tmp/wa-gnome-server-test-${process.pid}.db`;

const msg = (id: string, timestamp: number): Converted => ({
  id,
  chatId: CHAT,
  fromMe: false,
  sender: null,
  senderName: null,
  timestamp,
  kind: 'text',
  text: `message ${id}`,
  media: null,
  quoted: null,
  status: null,
});

/** Appels reçus par le faux Backend : nom et arguments. */
const calls: { method: string; args: unknown[] }[] = [];

/** Faux Backend : chaque méthode est enregistrée et réussit (status et diagnostic : valeurs fixes). */
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- faux Backend : méthodes fournies par le Proxy
const backend = new Proxy({} as Backend, {
  get: (_t, prop: string) => {
    if (prop === 'status') return { state: 'open', qr: null, me: null, error: null };
    return (...args: unknown[]) => {
      calls.push({ method: prop, args });
      if (prop === 'diagnostics') return { id: args[0] };
      if (prop === 'schedule') return 'programmé-1';
      return Promise.resolve(prop === 'picture' ? null : prop === 'lookup' ? null : {});
    };
  },
});

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      srv.close(() => resolve(typeof addr === 'object' && addr !== null ? addr.port : 0));
    });
  });

let server: Server;
let store: Store;
let base = '';
const extras = new Map<string, Account>();

const request = (method: string, route: string, body?: unknown, token = TOKEN): Promise<Response> =>
  fetch(`${base}${route}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

void describe('serveur HTTP', () => {
  before(async () => {
    for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) fs.rmSync(f, { force: true });
    store = new Store(DB);
    for (let i = 1; i <= 5; i += 1) store.upsertMessage(msg(`m${i}`, i * 100), '{}');
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    server = await startServer({
      host: '127.0.0.1',
      port,
      token: TOKEN,
      accounts: {
        daemon: { version: 'test', baileys: 'test', node: process.versions.node, startedAt: 0, dataDir: '/tmp' },
        get: (id) => (id === 'default' ? { store, wa: backend } : extras.get(id)),
        ids: () => ['default', ...extras.keys()],
        add: () => {
          extras.set('second', { store, wa: backend });
          return Promise.resolve('second');
        },
        remove: (id) => {
          extras.delete(id);
          return Promise.resolve();
        },
      },
    });
  });

  after(async () => {
    await server.close();
    store.close();
    for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) fs.rmSync(f, { force: true });
  });

  void it('refuse un jeton absent ou faux', async () => {
    assert.equal((await request('GET', '/status', undefined, 'faux')).status, 401);
    assert.equal((await fetch(`${base}/status`)).status, 401);
    assert.equal((await request('GET', '/status')).status, 200);
  });

  void it('route inconnue : 404', async () => {
    assert.equal((await request('GET', '/nimporte/quoi')).status, 404);
  });

  void it('messages : limite bornée, curseur invalide refusé', async () => {
    const enc = encodeURIComponent(CHAT);
    // -1 ne supprime plus la limite : au moins 1, jamais toute la table sans borne
    assert.equal((await ids(request('GET', `/chats/${enc}/messages?limit=-1`))).length, 1);
    assert.deepEqual(await ids(request('GET', `/chats/${enc}/messages?limit=2`)), ['m4', 'm5']);
    assert.deepEqual(await ids(request('GET', `/chats/${enc}/messages?limit=10&before=300`)), ['m1', 'm2']);
    assert.equal((await request('GET', `/chats/${enc}/messages?before=abc`)).status, 400);
  });

  void it('envoi : corps validé, transmis au Backend', async () => {
    const enc = encodeURIComponent(CHAT);
    assert.equal((await request('POST', `/chats/${enc}/messages`, { pas: 'de texte' })).status, 400);
    calls.length = 0;
    assert.equal((await request('POST', `/chats/${enc}/messages`, { text: 'bonjour' })).status, 200);
    assert.equal(calls[0]?.method, 'send');
    assert.deepEqual(calls[0]?.args.slice(0, 2), [CHAT, 'bonjour']);
  });

  void it('comptes : ajout, routes préfixées, retrait (sauf le premier)', async () => {
    const { id } = z.parse(z.object({ id: z.string() }), await (await request('POST', '/accounts')).json());
    assert.equal(id, 'second');
    assert.equal((await request('GET', '/accounts/second/status')).status, 200);
    assert.equal((await request('GET', '/accounts/inconnu/status')).status, 404);
    assert.equal((await request('DELETE', '/accounts/default')).status, 400);
    assert.equal((await request('DELETE', '/accounts/second')).status, 200);
    assert.equal((await request('GET', '/accounts/second/status')).status, 404);
  });
});
