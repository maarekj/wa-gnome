// Store du démon (node --test) : fusion des identifiants lid / numéro.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import type { Converted } from './convert.ts';
import { decryptPollVote, proto } from 'baileys';
import { encryptPollVote, forwardedOf, mediaOf, optionHash, pinOf, quotedOf, toMessage } from './convert.ts';
import { isNoPicture } from './pictures.ts';
import { forwardScoreIn, mentionsIn, Store } from './store.ts';
import { STATUS_TTL } from '../shared/api.ts';

const LID = '111@lid';
const PN = '33600000001@s.whatsapp.net';
const GROUP = '1203@g.us';

const msg = (chatId: string, id: string, timestamp: number, sender: string | null = null): Converted => ({ id, chatId, fromMe: false, sender, senderName: null, timestamp, kind: 'text', text: id, media: null, quoted: null, status: null });

const statusMsg = (id: string, ts: number, sender: string | null, fromMe = false): Converted => ({ ...msg('status@broadcast', id, ts, sender), fromMe });

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

void describe('supprimé pour moi', () => {
  void it('retiré, puis ignoré s’il revient par l’historique', () => {
    const store = new Store(':memory:');
    store.upsertMessage(msg(PN, 'x', 10), '{}');
    assert.equal(store.deleteForMe(PN, 'x'), true);
    assert.equal(store.message(PN, 'x'), null);
    store.upsertMessage(msg(PN, 'x', 10), '{}');
    assert.equal(store.message(PN, 'x'), null);
    // inconnu ici (supprimé ailleurs avant d'arriver) : ignoré aussi à son arrivée
    assert.equal(store.deleteForMe(PN, 'y'), false);
    store.upsertMessage(msg(PN, 'y', 11), '{}');
    assert.equal(store.message(PN, 'y'), null);
  });
});

void describe('statuts et diffusions', () => {
  void it('statuts : jamais une discussion', () => {
    const store = new Store(':memory:');
    store.upsertChat({ id: 'status@broadcast', timestamp: 10 });
    assert.equal(store.chat('status@broadcast'), null);
    assert.equal(store.chats().length, 0);
  });
  void it('diffusion reçue déplacée chez l’expéditeur', () => {
    const store = new Store(':memory:');
    store.upsertMessage({ ...msg('123@broadcast', 'b', 10), sender: PN }, '{}');
    store.moveMessage('123@broadcast', 'b', PN, 10);
    store.dropEmptyBroadcasts();
    assert.equal(store.message(PN, 'b')?.sender, null);
    assert.equal(store.message('123@broadcast', 'b'), null);
    assert.deepEqual(store.chats().map((c) => c.id), [PN]);
  });
  void it('conversion : diffusion reçue rangée chez l’expéditeur', () => {
    const wa = { key: { remoteJid: '123@broadcast', id: 'x', fromMe: false, participant: PN }, message: { conversation: 'bonjour' }, messageTimestamp: 10 };
    assert.equal(toMessage(wa)?.chatId, PN);
    assert.equal(toMessage({ ...wa, key: { ...wa.key, fromMe: true } })?.chatId, '123@broadcast');
  });
  void it('sondages : définition, votes (dernier par personne), chiffrement des votes', () => {
    const wa = { key: { remoteJid: '1@g.us', id: 'p1', fromMe: false, participant: PN }, message: { pollCreationMessageV3: { name: 'Pizza ?', options: [{ optionName: 'Oui' }, { optionName: 'Non' }], selectableOptionsCount: 1 } }, messageTimestamp: 10 };
    // V3 avec 0 : plusieurs réponses (sondage créé sur le téléphone)
    assert.equal(toMessage({ ...wa, message: { pollCreationMessageV3: { name: 'x', options: [{ optionName: 'a' }], selectableOptionsCount: 0 } } })?.poll?.multiple, true);
    const m = toMessage(wa);
    assert.deepEqual([m?.kind, m?.text, m?.poll], ['poll', 'Pizza ?', { options: ['Oui', 'Non'], multiple: false }]);
    const store = new Store(':memory:');
    store.setMe(['me@s.whatsapp.net']);
    if (m !== null) store.upsertMessage(m, '{}');
    store.setVote('1@g.us', 'p1', PN, [optionHash('Oui')], 100);
    store.setVote('1@g.us', 'p1', 'me', [optionHash('Non')], 100);
    // vote plus ancien : ignoré ; plus récent : remplace
    assert.equal(store.setVote('1@g.us', 'p1', PN, [optionHash('Non')], 50), false);
    store.setVote('1@g.us', 'p1', 'me', [optionHash('Oui')], 200);
    const poll = store.message('1@g.us', 'p1')?.poll;
    assert.deepEqual(poll?.options.map((o) => [o.name, o.count, o.mine]), [['Oui', 2, true], ['Non', 0, false]]);
    assert.equal(poll?.voters, 2);
    // même personne connue ensuite par son lid : un seul vote (le plus récent)
    store.addMappings([{ lid: '9@lid', pn: PN }]);
    store.setVote('1@g.us', 'p1', '9@lid', [optionHash('Non')], 300);
    assert.deepEqual(store.message('1@g.us', 'p1')?.poll?.options.map((o) => o.count), [1, 1]);
    assert.equal(store.chats()[0]?.preview, 'Sondage · Pizza ?');
    // chiffré puis déchiffré par Baileys : mêmes options
    const secret = new Uint8Array(32).fill(7);
    const ctx = { pollEncKey: secret, pollCreatorJid: 'a@lid', pollMsgId: 'p1', voterJid: 'b@lid' };
    const enc = encryptPollVote(proto.Message.PollVoteMessage.encode({ selectedOptions: [Buffer.from(optionHash('Oui'), 'base64')] }).finish(), ctx);
    const dec = decryptPollVote(enc, ctx);
    assert.equal(Buffer.from(dec.selectedOptions?.[0] ?? []).toString('base64'), optionHash('Oui'));
  });
  void it('messages programmés : ordre, erreur, retrait', () => {
    const store = new Store(':memory:');
    store.addScheduled({ id: 'b', chatId: PN, text: 'deux', at: 200, replyTo: null, mentions: [] });
    store.addScheduled({ id: 'a', chatId: PN, text: 'un', at: 100, replyTo: 'm1', mentions: ['x@s.whatsapp.net'] });
    store.addScheduled({ id: 'c', chatId: 'autre@s.whatsapp.net', text: 'trois', at: 50, replyTo: null, mentions: [] });
    assert.deepEqual(store.scheduled(PN).map((s) => s.id), ['a', 'b']);
    assert.deepEqual(store.scheduled()[1]?.mentions, ['x@s.whatsapp.net']);
    assert.deepEqual(store.dueScheduled(150).map((s) => s.id), ['c', 'a']);
    store.setScheduledError('a', 'hors ligne', 150);
    assert.equal(store.scheduled(PN)[0]?.error, 'hors ligne');
    // nouvel essai une minute plus tard seulement
    assert.deepEqual(store.dueScheduled(160).map((s) => s.id), ['c']);
    assert.deepEqual(store.dueScheduled(211).map((s) => s.id), ['c', 'a', 'b']);
    assert.equal(store.removeScheduled('a'), PN);
    assert.equal(store.removeScheduled('a'), null);
    assert.deepEqual(store.scheduled().map((s) => s.id), ['c', 'b']);
  });
  void it('statuts : par personne, 24 h, vus, fond des statuts texte', () => {
    const store = new Store(':memory:');
    store.upsertMessage(statusMsg('a', 1000, PN), JSON.stringify({ message: { extendedTextMessage: { text: 'a', backgroundArgb: -14_913_064 } } }));
    store.upsertMessage(statusMsg('b', 2000, PN), '{}');
    store.upsertMessage(statusMsg('c', 1500, '2@s.whatsapp.net'), '{}');
    store.upsertMessage(statusMsg('vieux', 10, PN), '{}');
    store.upsertMessage(statusMsg('moi', 1200, null, true), '{}');
    // pas une discussion
    assert.deepEqual(store.chats(), []);
    store.setStatusSeen('c');
    const groups = store.statuses(10 + STATUS_TTL + 1);
    assert.deepEqual(groups.map((g) => [g.sender, g.items.map((i) => i.message.id)]), [['me', ['moi']], [PN, ['a', 'b']], ['2@s.whatsapp.net', ['c']]]);
    assert.equal(groups[1]?.items[0]?.background, '#1c71d8');
    assert.equal(groups[2]?.items[0]?.seen, true);
    // expirés : retirés
    assert.deepEqual(store.purgeExpired(1000 + STATUS_TTL + 1).map((r) => r.id).toSorted(), ['a', 'vieux']);
  });
  void it('mentions : relues du message, noms et moi ; citées ignorées', () => {
    const wa = { key: { remoteJid: '1@g.us', id: 'mm', fromMe: false, participant: PN }, message: { extendedTextMessage: { text: '@33611 et @99', contextInfo: { mentionedJid: ['33611@s.whatsapp.net', '99@lid'], quotedMessage: { extendedTextMessage: { text: 'x', contextInfo: { mentionedJid: ['autre@s.whatsapp.net'] } } } } } }, messageTimestamp: 10 };
    const m = toMessage(wa);
    assert.deepEqual(m?.mentions, ['33611@s.whatsapp.net', '99@lid']);
    assert.deepEqual(mentionsIn({ message: { a: { contextInfo: { quotedMessage: { contextInfo: { mentionedJid: ['q'] } } } } } }), []);
    const store = new Store(':memory:');
    store.setMe(['33611@s.whatsapp.net']);
    store.upsertContact('99@lid', { name: 'Zoé' });
    if (m !== null) store.upsertMessage(m, '{}');
    assert.deepEqual(store.message('1@g.us', 'mm')?.mentions, [{ token: '33611', name: 'Vous', me: true }, { token: '99', name: 'Zoé', me: false }]);
    assert.equal(store.chats()[0]?.preview, '@Vous et @Zoé');
  });
  void it('épinglage : message technique, état de l’historique, ordre et expiration', () => {
    const action = { key: { remoteJid: PN, id: 'p1', fromMe: true }, message: { pinInChatMessage: { key: { id: 'cible' }, type: proto.Message.PinInChatMessage.Type.PIN_FOR_ALL, senderTimestampMs: 50_000 }, messageContextInfo: { messageAddOnDurationInSecs: 86_400 } }, messageTimestamp: 50 };
    assert.deepEqual(pinOf(action), { targetId: 'cible', pinned: true, at: 50, duration: 86_400, action: true });
    const state = { key: { remoteJid: PN, id: 'm1', fromMe: false }, message: { conversation: 'à lire' }, pinInChat: { type: proto.PinInChat.Type.PIN_FOR_ALL, key: { id: 'autre' }, serverTimestampMs: 70_000 }, messageTimestamp: 60 };
    assert.deepEqual(pinOf(state), { targetId: 'm1', pinned: true, at: 70, duration: 0, action: false });
    const store = new Store(':memory:');
    store.upsertMessage(msg(PN, 'a', 10), '{}');
    store.upsertMessage(msg(PN, 'b', 20), '{}');
    store.setPin(PN, 'a', true, 100, 1000);
    store.setPin(PN, 'b', true, 200, 1000);
    assert.deepEqual(store.pins(PN, 150, 3).map((m) => m.id), ['b', 'a']);
    // retrait plus ancien que l'épinglage (historique rejoué) : ignoré
    assert.equal(store.setPin(PN, 'b', false, 150, 1000), false);
    store.setPin(PN, 'a', false, 300, 1000);
    assert.deepEqual(store.pins(PN, 150, 3).map((m) => m.id), ['b']);
    assert.deepEqual(store.pins(PN, 1001, 3), []);
  });
  void it('conversion : vue unique et durée éphémère', () => {
    const once = { key: { remoteJid: PN, id: 'v1', fromMe: false }, message: { imageMessage: { mimetype: 'image/jpeg', viewOnce: true, contextInfo: { expiration: 604_800 } } }, messageTimestamp: 10 };
    assert.deepEqual([toMessage(once)?.viewOnce, toMessage(once)?.expiration], [true, 604_800]);
    const kept = { ...once, keepInChat: { keepType: proto.KeepType.KEEP_FOR_ALL } };
    assert.equal(toMessage(kept)?.expiration, 0);
    const wrapped = { key: { remoteJid: PN, id: 'v2', fromMe: false }, message: { viewOnceMessageV2: { message: { videoMessage: { mimetype: 'video/mp4' } } } }, messageTimestamp: 10 };
    assert.deepEqual([toMessage(wrapped)?.kind, toMessage(wrapped)?.viewOnce], ['video', true]);
  });
  void it('messages éphémères : réglage de la discussion et expiration', () => {
    const store = new Store(':memory:');
    store.upsertMessage({ ...msg(PN, 'a', 100), expiration: 3600 }, '{}');
    assert.equal(store.ephemeralOf(PN), 3600);
    // message plus ancien (historique) : réglage inchangé
    store.upsertMessage({ ...msg(PN, 'b', 50), expiration: 0 }, '{}');
    assert.equal(store.ephemeralOf(PN), 3600);
    store.upsertMessage({ ...msg(PN, 'c', 200), kind: 'image', text: '', viewOnce: true }, '{}');
    assert.equal(store.chats()[0]?.preview, 'Photo à vue unique');
    // message gardé : n'expire plus
    store.upsertMessage({ ...msg(PN, 'k', 90), expiration: 3600 }, '{}');
    store.setExpiration(PN, 'k', 0);
    assert.deepEqual(store.purgeExpired(3600 + 101), [{ chatId: PN, id: 'a' }]);
    assert.equal(store.message(PN, 'a'), null);
    assert.notEqual(store.message(PN, 'b'), null);
  });
  void it('conversion : appels manqués et journal d’appels', () => {
    const stub = { key: { remoteJid: PN, id: 'c1', fromMe: false }, messageStubType: proto.WebMessageInfo.StubType.CALL_MISSED_VIDEO, messageTimestamp: 10 };
    assert.deepEqual([toMessage(stub)?.kind, toMessage(stub)?.text], ['call', 'Appel vidéo manqué']);
    const log = { key: { remoteJid: PN, id: 'c2', fromMe: false }, message: { callLogMesssage: { isVideo: false, callOutcome: proto.Message.CallLogMessage.CallOutcome.REJECTED } }, messageTimestamp: 10 };
    assert.equal(toMessage(log)?.text, 'Appel vocal refusé');
    const store = new Store(':memory:');
    const m = toMessage(stub);
    if (m !== null) store.upsertMessage(m, '{}');
    assert.equal(store.message(PN, 'c1')?.kind, 'call');
  });
});

void describe('lu sur un autre appareil', () => {
  void it('remis à zéro seulement jusqu’au dernier message reçu', () => {
    const store = new Store(':memory:');
    store.upsertMessage(msg(PN, 'a', 10), '{}');
    store.upsertMessage(msg(PN, 'b', 20), '{}');
    store.incrementUnread(PN);
    store.incrementUnread(PN);
    assert.equal(store.readUpTo(PN, 'a'), false);
    assert.equal(store.chat(PN)?.unread, 2);
    assert.equal(store.readUpTo(PN, 'b'), true);
    assert.equal(store.chat(PN)?.unread, 0);
    assert.equal(store.readUpTo(PN, 'b'), false);
  });
});

void describe('recherche', () => {
  void it('mots sans accents, début de mot ; suivie des modifications et suppressions', () => {
    const store = new Store(':memory:');
    store.upsertMessage({ ...msg(PN, 'a', 10), text: 'Rendez-vous au café à 14 h' }, '{}');
    store.upsertMessage({ ...msg(PN, 'b', 20), text: 'autre chose' }, '{}');
    assert.deepEqual(store.search('cafe').map((h) => h.id), ['a']);
    assert.deepEqual(store.search('rendez caf').map((h) => h.id), ['a']);
    assert.equal(store.search('cafe')[0]?.snippet.includes('\u0001café\u0002'), true);
    // rejoué (INSERT OR REPLACE) : pas de doublon
    store.upsertMessage({ ...msg(PN, 'a', 10), text: 'Rendez-vous au café à 14 h' }, '{}');
    assert.equal(store.search('cafe').length, 1);
    store.applyEdit(PN, 'a', 'plutôt le thé');
    assert.deepEqual(store.search('cafe'), []);
    assert.deepEqual(store.search('the').map((h) => h.id), ['a']);
    store.deleteForMe(PN, 'a');
    assert.deepEqual(store.search('the'), []);
    assert.deepEqual(store.search('"'), []);
    store.upsertMessage({ ...msg(GROUP, 'g', 30), text: 'autre café' }, '{}');
    assert.deepEqual(store.search('autre', 50, GROUP).map((h) => h.id), ['g']);
  });
  void it('ouverture sur un message : avant et après', () => {
    const store = new Store(':memory:');
    for (let i = 0; i < 30; i++) store.upsertMessage(msg(PN, `m${i}`, i), '{}');
    const list = store.messagesFrom(PN, 25, 3);
    assert.deepEqual(list.map((m) => m.id), ['m22', 'm23', 'm24', 'm25', 'm26', 'm27', 'm28', 'm29']);
  });
});

void describe('galerie', () => {
  void it('médias par genre, plus récents d’abord, par pages ; supprimés exclus', () => {
    const store = new Store(':memory:');
    const media = { mimetype: 'image/jpeg', width: 10, height: 10, thumbnail: null, fileName: null, size: 1, seconds: null };
    store.upsertMessage({ ...msg(PN, 'i1', 10), kind: 'image', media }, '{}');
    store.upsertMessage({ ...msg(PN, 'v1', 20), kind: 'video', media }, '{}');
    store.upsertMessage({ ...msg(PN, 'd1', 30), kind: 'document', media }, '{}');
    store.upsertMessage({ ...msg(PN, 'i2', 40), kind: 'image', media }, '{}');
    store.upsertMessage(msg(PN, 't', 50), '{}');
    assert.deepEqual(store.mediaMessages(PN, ['image', 'video'], 10).map((m) => m.id), ['i2', 'v1', 'i1']);
    assert.deepEqual(store.mediaMessages(PN, ['image', 'video'], 2, { timestamp: 40, id: 'i2' }).map((m) => m.id), ['v1', 'i1']);
    // album : même seconde coupée entre deux pages, rien de sauté
    store.upsertMessage({ ...msg(PN, 'a1', 60), kind: 'image', media }, '{}');
    store.upsertMessage({ ...msg(PN, 'a2', 60), kind: 'image', media }, '{}');
    store.upsertMessage({ ...msg(PN, 'a3', 60), kind: 'image', media }, '{}');
    const first = store.mediaMessages(PN, ['image'], 2);
    assert.deepEqual(first.map((m) => m.id), ['a3', 'a2']);
    const last = first.at(-1);
    assert.deepEqual(store.mediaMessages(PN, ['image'], 10, last === undefined ? undefined : { timestamp: last.timestamp, id: last.id }).map((m) => m.id), ['a1', 'i2', 'i1']);
    assert.deepEqual(store.mediaMessages(PN, ['document'], 10).map((m) => m.id), ['d1']);
    store.applyRevoke(PN, 'i2');
    assert.deepEqual(store.mediaMessages(PN, ['image'], 10).map((m) => m.id), ['a3', 'a2', 'a1', 'i1']);
  });
});

void describe('forme d’onde', () => {
  void it('lue dans un vocal', () => {
    const media = mediaOf({ audioMessage: { mimetype: 'audio/ogg; codecs=opus', seconds: 3, ptt: true, waveform: new Uint8Array([0, 50, 100, 120]) } });
    assert.deepEqual(media?.waveform, [0, 50, 100, 100]);
    assert.equal(mediaOf({ imageMessage: { mimetype: 'image/jpeg' } })?.waveform, undefined);
  });
});

const tmp = (name: string): string => `/tmp/wa-gnome-store-${name}-${process.pid}.db`;
const remove = (file: string): void => {
  for (const f of [file, `${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true });
};

/** base de la toute première version (v0) : trois tables, sans les colonnes ajoutées depuis */
const v0 = (file: string): void => {
  remove(file);
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE chats (id TEXT PRIMARY KEY, name TEXT, unread INTEGER NOT NULL DEFAULT 0, timestamp INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE contacts (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE messages (chat_id TEXT NOT NULL, id TEXT NOT NULL, from_me INTEGER NOT NULL, sender TEXT, sender_name TEXT, timestamp INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, raw TEXT NOT NULL, PRIMARY KEY (chat_id, id));
    INSERT INTO chats (id, name, timestamp) VALUES ('${PN}', 'Alice', 10);
    INSERT INTO messages VALUES ('${PN}', 'm1', 0, NULL, NULL, 10, 'text', 'bonjour café', '{"key":{"id":"m1"},"pushName":"Alice"}');
    INSERT INTO messages VALUES ('${PN}', 'm2', 0, NULL, NULL, 11, 'text', 'illisible', '{pas du json');`);
  db.close();
};

void describe('Store : migrations et déconnexion', () => {

  void it('migre une base v0 jusqu’à la version courante', () => {
    const file = tmp('v0');
    v0(file);
    const store = new Store(file);
    assert.deepEqual(
      store.messages(PN, 10).map((m) => m.id),
      ['m1', 'm2'],
    );
    // index de recherche reconstruit pour les messages existants
    assert.equal(store.search('cafe', 10, null).length, 1);
    assert.equal(store.needsMediaBackfill, true);
    store.close();
    const db = new DatabaseSync(file);
    assert.equal(db.prepare('PRAGMA user_version').get()?.['user_version'], 19);
    db.close();
    // réouverture : aucune migration rejouée
    new Store(file).close();
    remove(file);
  });

  void it('reprend après une migration interrompue', () => {
    const file = tmp('reprise');
    v0(file);
    new Store(file).close();
    // arrêt juste avant la dernière migration : seule celle-ci est rejouée au démarrage suivant
    const db = new DatabaseSync(file);
    db.exec('PRAGMA user_version = 18');
    db.close();
    const store = new Store(file);
    assert.equal(store.messages(PN, 10).length, 2);
    store.close();
    remove(file);
  });

  void it('déconnexion : tout est effacé, messages programmés compris', () => {
    const file = tmp('clear');
    remove(file);
    const store = new Store(file);
    store.upsertMessage(msg(PN, 'a', 1), '{}');
    store.addScheduled({ id: 's1', chatId: PN, text: 'plus tard', at: 9_999_999_999, replyTo: null, mentions: [] });
    store.setFlag('backfill-polls', true);
    store.clear();
    assert.equal(store.messages(PN, 10).length, 0);
    assert.equal(store.scheduled(PN).length, 0);
    assert.equal(store.meta('backfill-polls'), null);
    store.close();
    remove(file);
  });
});
