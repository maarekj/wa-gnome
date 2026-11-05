// Store du démon (node --test) : fusion des identifiants lid / numéro.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import type { Message } from '../shared/api.ts';
import { Store } from './store.ts';

const LID = '111@lid';
const PN = '33600000001@s.whatsapp.net';
const GROUP = '1203@g.us';

const msg = (chatId: string, id: string, timestamp: number, sender: string | null = null): Message => ({ id, chatId, fromMe: false, sender, senderName: null, timestamp, kind: 'text', text: id, media: null });

void describe('Store : lid → numéro', () => {
  void it('fusionne la discussion lid dans celle du numéro', () => {
    const store = new Store(':memory:');
    store.upsertContact(PN, 'Alice');
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
