// État de l'application : application des événements du démon, ordre des messages.
import type { Chat, Message } from '../src/shared/api.ts';
import { formatPhone, isMuted, previewOf } from '../src/shared/api.ts';
import { dispatch, WaClient } from '../src/shared/client.ts';
import { mergeMessage, sortChats, Store } from '../src/shared/store.ts';
import { itemsOf } from '../src/app/ConversationPage.tsx';
import { fold, inList, visibleChats } from '../src/app/ChatList.tsx';
import { chatMenu } from '../src/app/ChatMenu.ts';
import { screenOf } from '../src/app/MainWindow.tsx';
import { displaySize } from '../src/app/media.ts';

const msg = (id: string, timestamp: number, extra: Partial<Message> = {}): Message => ({ id, chatId: 'a@s.whatsapp.net', fromMe: false, sender: null, senderName: null, timestamp, kind: 'text', text: id, media: null, ...extra });
const chat = (id: string, timestamp: number, name = id, extra: Partial<Chat> = {}): Chat => ({ id, name, group: false, unread: 0, timestamp, preview: '', archived: false, mutedUntil: 0, pinned: 0, markedUnread: false, labels: [], favorite: false, ...extra });

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

  it('épinglées en tête, la dernière épinglée d’abord', () => {
    expect(sortChats([chat('x', 9), chat('p1', 1, 'p1', { pinned: 100 }), chat('p2', 2, 'p2', { pinned: 200 })]).map((c) => c.id)).toEqual(['p2', 'p1', 'x']);
  });
});

/** Libellés des entrées du menu d'une discussion (sections à plat). */
const labels = (c: Chat, pinned = 0): string[] => {
  const menu = chatMenu(c, pinned, [], 1000);
  const out: string[] = [];
  for (let s = 0; s < menu.get_n_items(); s += 1) {
    const section = menu.get_item_link(s, 'section');
    if (section === null) continue;
    for (let i = 0; i < section.get_n_items(); i += 1) out.push(String(section.get_item_attribute_value(i, 'label', null)?.unpack()));
  }
  return out;
};

describe('archivées, silencieux, menu', () => {
  const all = [chat('a', 1, 'Alice'), chat('b', 2, 'Boulangerie', { archived: true })];

  it('archivées à part, mais trouvées par la recherche', () => {
    expect(visibleChats(all, '', false).map((c) => c.id)).toEqual(['a']);
    expect(visibleChats(all, '', true).map((c) => c.id)).toEqual(['b']);
    expect(visibleChats(all, 'boul', false).map((c) => c.id)).toEqual(['b']);
  });

  it('filtres par liste (vue principale seulement)', () => {
    const lists = [
      { id: '1', name: 'Non lues', color: 0, kind: 'unread' },
      { id: '2', name: 'Favoris', color: 0, kind: 'favorites' },
      { id: '3', name: 'Groupes', color: 0, kind: 'groups' },
      { id: '4', name: 'École', color: 0, kind: 'custom' },
    ] as const;
    const chats = [chat('a', 1, 'A', { unread: 2 }), chat('b', 2, 'B', { favorite: true, labels: ['4'] }), chat('g', 3, 'G', { group: true, markedUnread: true }), chat('z', 4, 'Z', { archived: true, favorite: true })];
    const ids = (filter: string): string[] => visibleChats(chats, '', false, filter, lists).map((c) => c.id);
    expect(ids('all')).toEqual(['a', 'b', 'g']);
    expect(ids('1')).toEqual(['a', 'g']);
    expect(ids('2')).toEqual(['b']);
    expect(ids('3')).toEqual(['g']);
    expect(ids('4')).toEqual(['b']);
    expect(inList(chats[3] ?? chat('x', 0), lists[1])).toBeTrue();
  });

  it('mode silencieux', () => {
    expect(isMuted({ mutedUntil: 0 }, 1000)).toBeFalse();
    expect(isMuted({ mutedUntil: -1 }, 1000)).toBeTrue();
    expect(isMuted({ mutedUntil: 2000 }, 1000)).toBeTrue();
    expect(isMuted({ mutedUntil: 500 }, 1000)).toBeFalse();
  });

  it('entrées du menu selon l’état', () => {
    expect(labels(chat('a', 1))).toEqual(['Archiver la discussion', 'Mode silencieux', 'Épingler la discussion', 'Marquer comme non lue', 'Ajouter aux favoris', 'Effacer la discussion…', 'Supprimer la discussion…']);
    expect(labels(chat('g', 1, 'G', { group: true, archived: true, mutedUntil: -1, pinned: 5, unread: 2, favorite: true }))).toEqual([
      'Désarchiver la discussion',
      'Réactiver les notifications',
      'Désépingler la discussion',
      'Marquer comme lue',
      'Retirer des favoris',
      'Effacer la discussion…',
      'Quitter le groupe…',
    ]);
    // 3 épinglées : plus d'entrée « Épingler »
    expect(labels(chat('a', 1), 3)).not.toContain('Épingler la discussion');
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

  it('numéros lisibles', () => {
    expect(formatPhone('33612345678')).toBe('+33 6 12 34 56 78');
    expect(formatPhone('972541234567')).toBe('+972 54 123 4567');
    expect(formatPhone('4915112345678')).toBe('+4915112345678');
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
