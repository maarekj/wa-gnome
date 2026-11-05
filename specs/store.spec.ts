// État de l'application : application des événements du démon, ordre des messages.
import type { Chat, Message } from '../src/shared/api.ts';
import { previewOf } from '../src/shared/api.ts';
import { dispatch, WaClient } from '../src/shared/client.ts';
import { mergeMessage, sortChats, Store } from '../src/shared/store.ts';
import { itemsOf } from '../src/app/ConversationPage.tsx';
import { fold } from '../src/app/ChatList.tsx';
import { screenOf } from '../src/app/MainWindow.tsx';
import { displaySize } from '../src/app/media.ts';

const msg = (id: string, timestamp: number, extra: Partial<Message> = {}): Message => ({ id, chatId: 'a@s.whatsapp.net', fromMe: false, sender: null, senderName: null, timestamp, kind: 'text', text: id, media: null, ...extra });
const chat = (id: string, timestamp: number, name = id): Chat => ({ id, name, group: false, unread: 0, timestamp, preview: '' });

describe('mergeMessage', () => {
  it('insère à sa place chronologique', () => {
    const list = [msg('a', 1), msg('c', 3)];
    expect(mergeMessage(list, msg('b', 2)).map((m) => m.id)).toEqual(['a', 'b', 'c']);
    expect(mergeMessage(list, msg('d', 9)).map((m) => m.id)).toEqual(['a', 'c', 'd']);
  });

  it('remplace un message déjà présent', () => {
    const merged = mergeMessage([msg('a', 1), msg('b', 2)], msg('a', 1, { text: 'modifié' }));
    expect(merged.map((m) => m.text)).toEqual(['modifié', 'b']);
  });
});

describe('sortChats', () => {
  it('plus récente d’abord, puis par nom', () => {
    expect(sortChats([chat('x', 1), chat('y', 5), chat('b', 1, 'B'), chat('a', 1, 'A')]).map((c) => c.id)).toEqual(['y', 'a', 'b', 'x']);
  });
});

describe('Store.apply', () => {
  it('met à jour la liste et notifie les messages reçus', () => {
    const store = new Store(new WaClient('http://127.0.0.1:1', () => ''));
    const incoming: string[] = [];
    store.onIncoming = (m) => {
      incoming.push(m.id);
    };
    store.apply({ type: 'chats', chats: [chat('a@s.whatsapp.net', 1), chat('b@s.whatsapp.net', 2)] });
    store.apply({ type: 'chats', chats: [chat('a@s.whatsapp.net', 3)] });
    expect(store.chats.peek().map((c) => c.id)).toEqual(['a@s.whatsapp.net', 'b@s.whatsapp.net']);
    store.apply({ type: 'message', message: msg('m1', 4) });
    store.apply({ type: 'message', message: msg('m2', 5, { fromMe: true }) });
    expect(incoming).toEqual(['m1']);
    store.apply({ type: 'chats.delete', ids: ['a@s.whatsapp.net'] });
    expect(store.chats.peek().map((c) => c.id)).toEqual(['b@s.whatsapp.net']);
  });
});

describe('itemsOf', () => {
  it('sépare les jours et n’affiche l’auteur qu’au début d’une suite', () => {
    const day = 86_400;
    const items = itemsOf(
      [msg('1', 10 * day + 100, { sender: 'x' }), msg('2', 10 * day + 200, { sender: 'x' }), msg('3', 10 * day + 300, { sender: 'y' }), msg('4', 12 * day, { sender: 'y' })],
      true,
    );
    expect(items.map((i) => (i.kind === 'day' ? 'J' : `${i.message.id}${i.showSender ? '*' : ''}`))).toEqual(['J', '1*', '2', '3*', 'J', '4*']);
  });
});

describe('divers', () => {
  it('aperçu des médias', () => {
    expect(previewOf({ kind: 'image', text: '' })).toBe('Photo');
    expect(previewOf({ kind: 'image', text: 'vacances' })).toBe('Photo · vacances');
    expect(previewOf({ kind: 'text', text: 'salut' })).toBe('salut');
  });

  it('recherche sans accents ni casse', () => {
    expect(fold('Élodie')).toBe('elodie');
  });

  it('écran selon la liaison et l’état', () => {
    const status = { state: 'qr', qr: 'x', me: null, error: null } as const;
    expect(screenOf({ state: 'connecting' }, status)).toBe('daemon');
    expect(screenOf({ state: 'connected' }, status)).toBe('pair');
    expect(screenOf({ state: 'connected' }, { ...status, state: 'closed', me: { id: 'me', name: null } })).toBe('main');
  });

  it('ignore les événements invalides', () => {
    const seen: string[] = [];
    const push = (e: { type: string }): void => {
      seen.push(e.type);
    };
    dispatch('{"type":"inconnu"}', push);
    dispatch('pas du json', push);
    dispatch('{"type":"chats.delete","ids":["a"]}', push);
    expect(seen).toEqual(['chats.delete']);
  });
});

describe('displaySize', () => {
  it('réduit sans déformer, sans agrandir', () => {
    expect(displaySize(1200, 600, 300)).toEqual([300, 150]);
    expect(displaySize(600, 1200, 300)).toEqual([150, 300]);
    expect(displaySize(100, 50, 300)).toEqual([100, 80]);
    expect(displaySize(null, null, 300)).toEqual([300, 225]);
  });
});
