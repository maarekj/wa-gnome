// Store du démon (node --test) : fusion des identifiants lid / numéro.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import type { Converted } from './convert.ts';
import { proto } from 'baileys';
import { forwardedOf, quotedOf } from './convert.ts';
import { isNoPicture } from './pictures.ts';
import { forwardScoreIn, Store } from './store.ts';

const LID = '111@lid';
const PN = '33600000001@s.whatsapp.net';
const GROUP = '1203@g.us';

const msg = (chatId: string, id: string, timestamp: number, sender: string | null = null): Converted => ({ id, chatId, fromMe: false, sender, senderName: null, timestamp, kind: 'text', text: id, media: null, quoted: null, status: null });

void describe('Store : lid → numéro', () => {
  void it('fusionne la discussion lid dans celle du numéro', () => {
    const store = new Store(':memory:');
    store.upsertContact(PN, { name: 'Alice' });
    store.upsertMessage(msg(PN, 'a', 10), '{}');
    store.upsertMessage(msg(LID, 'b', 20), '{}');
    store.upsertMessage(msg(LID, 'a', 10), '{}');
    store.incrementUnread(LID);
    store.upsertMessage(msg(GROUP, 'g', 30, LID), '{}');
    assert.deepEqual(store.unresolvedLids(), [LID]);

    const { removed, updated } = store.addMappings([{ lid: LID, pn: PN }]);
    assert.deepEqual(removed, [LID]);
    assert.deepEqual(updated, [PN]);
    assert.deepEqual(
      store.chats().map((c) => [c.id, c.name, c.unread, c.timestamp]),
      [
        [GROUP, '1203', 0, 30],
        [PN, 'Alice', 1, 20],
      ],
    );
    assert.deepEqual(
      store.messages(PN, 10).map((m) => m.id),
      ['a', 'b'],
    );
    // auteur dans un groupe : rattaché au numéro, nom du carnet
    assert.deepEqual(
      store.messages(GROUP, 10).map((m) => [m.sender, m.senderName]),
      [[PN, 'Alice']],
    );
    assert.equal(store.canonical(LID), PN);
    assert.deepEqual(store.unresolvedLids(), []);
    // correspondance déjà connue : rien à refaire
    assert.deepEqual(store.addMappings([{ lid: LID, pn: PN }]), { removed: [], updated: [] });
  });

  void it('garde les correspondances après réouverture', () => {
    const file = `/tmp/wa-gnome-store-test-${process.pid}.db`;
    const a = new Store(file);
    a.addMappings([{ lid: LID, pn: PN }]);
    a.close();
    const b = new Store(file);
    assert.equal(b.canonical(LID), PN);
    b.clear();
    assert.equal(b.canonical(LID), LID);
    b.close();
    fs.rmSync(file, { force: true });
    fs.rmSync(`${file}-wal`, { force: true });
    fs.rmSync(`${file}-shm`, { force: true });
  });
});

void describe('Store : noms', () => {
  void it('carnet, sinon nom public, sinon numéro', () => {
    const store = new Store(':memory:');
    const BOB = '33600000002@s.whatsapp.net';
    const ANON = '33600000003@s.whatsapp.net';
    store.upsertContact(PN, { name: 'Alice', notify: 'Ali' });
    store.upsertContact(BOB, { notify: 'Bob' });
    // un nom public plus récent ne remplace pas le nom du carnet, un nom vide n'efface rien
    store.upsertContact(PN, { notify: 'Alice B.', name: '' });
    for (const [i, who] of [PN, BOB, ANON].entries()) {
      store.upsertMessage(msg(who, `d${i}`, 10 + i), '{}');
      store.upsertMessage(msg(GROUP, `g${i}`, 10 + i, who), '{}');
    }
    assert.deepEqual(
      store.chats().map((c) => c.name),
      ['1203', '+33 6 00 00 00 03', '~ Bob', 'Alice'],
    );
    assert.deepEqual(
      store.messages(GROUP, 10).map((m) => m.senderName),
      ['Alice', '~ Bob', '+33 6 00 00 00 03'],
    );
    assert.equal(store.message(GROUP, 'g1')?.senderName, '~ Bob');
  });
});

void describe('photos de profil', () => {
  void it('« pas de photo » distingué d’une vraie erreur', () => {
    assert.equal(isNoPicture(new Error('item-not-found')), true);
    assert.equal(isNoPicture(Object.assign(new Error('x'), { output: { statusCode: 401 } })), true);
    assert.equal(isNoPicture(new Error('Timed Out')), false);
  });
});

void describe('citations', () => {
  void it('auteur résolu : moi, carnet, ou l’autre personne en discussion directe', () => {
    const store = new Store(':memory:');
    const ME = '33600000000@s.whatsapp.net';
    store.setMe([ME, '999@lid']);
    store.upsertContact(PN, { name: 'Alice' });
    store.addMappings([{ lid: LID, pn: PN }]);
    const reply = (id: string, chatId: string, quoted: { id: string; sender: string | null }) => store.upsertMessage({ ...msg(chatId, id, 10), quoted: { ...quoted, kind: 'text', text: 'cité' } }, '{}');
    reply('r1', GROUP, { id: 'q1', sender: LID });
    reply('r2', GROUP, { id: 'q2', sender: '999@lid' });
    reply('r3', PN, { id: 'q3', sender: null });
    const q = (chatId: string, id: string) => store.message(chatId, id)?.quoted;
    assert.deepEqual([q(GROUP, 'r1')?.senderName, q(GROUP, 'r1')?.fromMe, q(GROUP, 'r1')?.sender], ['Alice', false, PN]);
    assert.deepEqual([q(GROUP, 'r2')?.senderName, q(GROUP, 'r2')?.fromMe], ['Vous', true]);
    assert.equal(q(PN, 'r3')?.senderName, 'Alice');
    assert.equal(store.message(GROUP, 'r1')?.quoted?.text, 'cité');
  });
});

void describe('quotedOf', () => {
  const ctx = { stanzaId: 'Q1', participant: '111@lid', quotedMessage: { conversation: 'bonjour' } };
  void it('citation d’un message reçu (décodé) et d’un message envoyé (objet simple)', () => {
    const received = proto.Message.fromObject({ extendedTextMessage: { text: 'réponse', contextInfo: ctx } });
    const sent = { extendedTextMessage: { text: 'réponse', contextInfo: ctx } };
    for (const content of [received, sent]) assert.deepEqual(quotedOf(content), { id: 'Q1', sender: '111@lid', kind: 'text', text: 'bonjour' });
  });
});

void describe('réactions', () => {
  void it('une par personne, groupées par émoji, retrait et ordre des événements', () => {
    const store = new Store(':memory:');
    store.upsertContact(PN, { name: 'Alice' });
    store.upsertMessage(msg(GROUP, 'm', 10), '{}');
    const set = (sender: string, emoji: string, timestamp: number) => store.setReaction({ chatId: GROUP, targetId: 'm', sender, emoji, timestamp });
    set(PN, '👍', 1);
    set('me', '👍', 2);
    set('222@s.whatsapp.net', '❤️', 3);
    assert.deepEqual(store.message(GROUP, 'm')?.reactions, [
      {
        emoji: '👍',
        count: 2,
        mine: true,
        people: [
          { id: PN, name: 'Alice' },
          { id: null, name: 'Vous' },
        ],
      },
      { emoji: '❤️', count: 1, mine: false, people: [{ id: '222@s.whatsapp.net', name: '+222' }] },
    ]);
    // changement puis réaction plus ancienne (historique rejoué) ignorée
    set(PN, '😂', 5);
    set(PN, '🙏', 4);
    set('me', '', 6);
    assert.deepEqual(store.message(GROUP, 'm')?.reactions.map((r) => [r.emoji, r.count, r.mine]), [
      ['❤️', 1, false],
      ['😂', 1, false],
    ]);
  });
});

void describe('état des messages envoyés', () => {
  void it('ne recule jamais (accusés dans le désordre), sauf erreur', () => {
    const store = new Store(':memory:');
    store.upsertMessage({ ...msg(PN, 'e', 10), fromMe: true, status: 'pending' }, '{}');
    const st = (): string | null | undefined => store.message(PN, 'e')?.status;
    assert.equal(store.setStatus(PN, 'e', 'delivered'), true);
    assert.equal(store.setStatus(PN, 'e', 'sent'), false);
    assert.equal(st(), 'delivered');
    store.setStatus(PN, 'e', 'read');
    // message renvoyé par WhatsApp (écho de l'envoi) avec un état moins avancé : conservé
    store.upsertMessage({ ...msg(PN, 'e', 10), fromMe: true, status: 'sent' }, '{}');
    assert.equal(st(), 'read');
    // message reçu : pas d'état
    store.upsertMessage(msg(PN, 'r', 11), '{}');
    assert.equal(store.message(PN, 'r')?.status, null);
    assert.equal(store.setStatus(PN, 'r', 'read'), false);
  });
});

void describe('accusés', () => {
  void it('première date gardée, lu implique distribué, lid rattaché au numéro', () => {
    const store = new Store(':memory:');
    store.upsertContact(PN, { name: 'Alice' });
    store.setReceipt({ chatId: GROUP, messageId: 'm', user: LID, delivered: 10 });
    store.setReceipt({ chatId: GROUP, messageId: 'm', user: LID, delivered: 99, read: 20 });
    store.setReceipt({ chatId: GROUP, messageId: 'm', user: '222@s.whatsapp.net', read: 30 });
    store.addMappings([{ lid: LID, pn: PN }]);
    assert.deepEqual(store.receipts(GROUP, 'm'), [
      { id: '222@s.whatsapp.net', name: '+222', delivered: 30, read: 30, played: null },
      { id: PN, name: 'Alice', delivered: 10, read: 20, played: null },
    ]);
  });
});

void describe('modifications et suppressions', () => {
  void it('appliquées même si elles arrivent avant le message, et gardées s’il est réenregistré', () => {
    const store = new Store(':memory:');
    store.upsertMessage(msg(PN, 'a', 10), '{}');
    assert.equal(store.applyEdit(PN, 'a', 'corrigé'), true);
    store.upsertMessage(msg(PN, 'a', 10), '{}');
    assert.deepEqual([store.message(PN, 'a')?.text, store.message(PN, 'a')?.edited], ['corrigé', true]);
    // suppression d'un message pas encore reçu (historique dans le désordre)
    assert.equal(store.applyRevoke(PN, 'b'), false);
    store.setReaction({ chatId: PN, targetId: 'b', sender: 'me', emoji: '👍', timestamp: 1 });
    store.upsertMessage(msg(PN, 'b', 11), '{}');
    const b = store.message(PN, 'b');
    assert.deepEqual([b?.deleted, b?.text, b?.reactions.length], [true, '', 0]);
    // un message supprimé ne peut plus être modifié
    store.applyEdit(PN, 'b', 'trop tard');
    assert.equal(store.message(PN, 'b')?.text, '');
  });
});

void describe('auteur des changements', () => {
  void it('modification acceptée de l’auteur seulement', () => {
    const store = new Store(':memory:');
    store.upsertMessage({ ...msg(GROUP, 'g', 10, PN) }, '{}');
    store.upsertMessage({ ...msg(PN, 'd', 10) }, '{}');
    store.upsertMessage({ ...msg(PN, 'mine', 10), fromMe: true, status: 'sent' }, '{}');
    assert.equal(store.isAuthor(GROUP, 'g', PN), true);
    assert.equal(store.isAuthor(GROUP, 'g', '222@s.whatsapp.net'), false);
    assert.equal(store.isAuthor(GROUP, 'g', 'me'), false);
    assert.equal(store.isAuthor(PN, 'd', PN), true);
    assert.equal(store.isAuthor(PN, 'mine', 'me'), true);
    assert.equal(store.isAuthor(PN, 'mine', PN), false);
    assert.equal(store.isAuthor(PN, 'inconnu', PN), true);
  });
});

void describe('transfert', () => {
  void it('nombre de transferts du contenu', () => {
    assert.equal(forwardedOf({ extendedTextMessage: { text: 'a', contextInfo: { isForwarded: true, forwardingScore: 3 } } }), 3);
    assert.equal(forwardedOf({ imageMessage: { contextInfo: { isForwarded: true } } }), 1);
    assert.equal(forwardedOf({ conversation: 'a' }), 0);
  });
  void it('relu dans un message brut (migration)', () => {
    assert.equal(forwardScoreIn({ message: { extendedTextMessage: { contextInfo: { isForwarded: true, forwardingScore: 6 } } } }), 6);
    assert.equal(forwardScoreIn({ message: { conversation: 'a' } }), 0);
  });
  void it('enregistré et relu', () => {
    const store = new Store(':memory:');
    store.upsertMessage({ ...msg(PN, 'f', 10), forwarded: 2 }, '{}');
    assert.equal(store.message(PN, 'f')?.forwarded, 2);
  });
});
