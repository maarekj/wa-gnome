// État de l'application : application des événements du démon, ordre des messages.
import GLib from 'gi://GLib';
import type { Chat, Message } from '../src/shared/api.ts';
import { editability, effectiveStatus, formatPhone, isMuted, previewOf, statusOf, uploadKind } from '../src/shared/api.ts';
import { dispatch, WaClient } from '../src/shared/client.ts';
import { mergeMessage, prependPage, sortChats, Store, typingText } from '../src/shared/store.ts';
import { itemsOf, myReaction, presenceLine, senderColor } from '../src/app/ConversationPage.tsx';
import { fold, inList, neighbourChat, visibleChats } from '../src/app/ChatList.tsx';
import { chatMenu } from '../src/app/ChatMenu.ts';
import { screenOf } from '../src/app/MainWindow.tsx';
import { reactionCount, reactionPeople } from '../src/app/Reactions.ts';
import { splitReceipts, stepText } from '../src/app/MessageInfo.ts';
import { displaySize } from '../src/app/media.ts';
import { canRevokeAll, copyText } from '../src/app/Selection.ts';
import { accentCss, parseSettings } from '../src/app/Preferences.ts';
import { matchContacts } from '../src/app/NewChat.ts';
import { phoneDigits } from '../src/shared/api.ts';
import { snippetMarkup } from '../src/shared/format.ts';
import { byMonth } from '../src/app/Gallery.ts';
import { rangeSelection, rowAt } from '../src/app/DragSelect.ts';

const msg = (id: string, timestamp: number, extra: Partial<Message> = {}): Message => ({ id, chatId: 'a@s.whatsapp.net', fromMe: false, sender: null, senderName: null, timestamp, kind: 'text', text: id, media: null, quoted: null, reactions: [], status: null, edited: false, deleted: false, forwarded: 0, ...extra });
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

describe('myReaction', () => {
  it('ma réaction parmi celles du message', () => {
    expect(myReaction({ reactions: [] })).toBeNull();
    expect(myReaction({ reactions: [{ emoji: '😂', count: 1, mine: false, people: [{ id: 'a', name: 'A' }] }, { emoji: '❤️', count: 2, mine: true, people: [{ id: 'b', name: 'B' }, { id: null, name: 'Vous' }] }] })).toBe('❤️');
  });
});

describe('fenêtre des réactions', () => {
  const reactions = [
    { emoji: '😂', count: 2, mine: true, people: [{ id: 'a', name: 'A' }, { id: null, name: 'Vous' }] },
    { emoji: '❤️', count: 1, mine: false, people: [{ id: 'b', name: 'B' }] },
  ];
  it('personnes par filtre, total', () => {
    expect(reactionPeople(reactions, null).map((p) => `${p.name}${p.emoji}`)).toEqual(['A😂', 'Vous😂', 'B❤️']);
    expect(reactionPeople(reactions, '❤️').map((p) => p.name)).toEqual(['B']);
    expect(reactionCount(reactions)).toBe('3 réactions');
    expect(reactionCount([{ emoji: '👍', count: 1, mine: false, people: [] }])).toBe('1 réaction');
  });
});

/** Accusé de test. */
const receipt = (id: string, delivered: number | null, read: number | null) => ({ id, name: id, delivered, read, played: null });

describe('infos du message', () => {
  it('groupe : lus d’abord (le plus récent en tête), puis distribués', () => {
    const { read, delivered } = splitReceipts([receipt('a', 1, 5), receipt('b', 2, null), receipt('c', 1, 9), receipt('d', null, null)]);
    expect(read.map((x) => x.id)).toEqual(['c', 'a']);
    expect(delivered.map((x) => x.id)).toEqual(['b']);
  });

  it('étape atteinte sans date connue', () => {
    expect(stepText(null, false)).toBe('—');
    expect(stepText(null, true)).toContain('Date inconnue');
  });
});

/** Présence de test. */
const p = (extra: Partial<{ online: boolean; lastSeen: number | null; typing: { name: string; recording: boolean }[] }> = {}) => ({ online: false, lastSeen: null, typing: [], ...extra });

describe('présence', () => {
  it('écrit…, en ligne, vu', () => {
    expect(presenceLine(null, false)).toBe('');
    expect(presenceLine(p({ online: true }), false)).toBe('en ligne');
    expect(presenceLine(p({ online: true, typing: [{ name: 'A', recording: false }] }), false)).toBe('en train d’écrire…');
    expect(presenceLine(p({ lastSeen: 1000 }), false, 1000 + 60)).toContain('vu aujourd');
    expect(presenceLine(p({ online: true }), true)).toBe('');
  });
  it('groupes', () => {
    expect(typingText(p({ typing: [{ name: 'Bob', recording: true }] }), true)).toBe('Bob enregistre un audio…');
    expect(typingText(p({ typing: [{ name: 'A', recording: false }, { name: 'B', recording: false }] }), true)).toBe('2 personnes écrivent…');
    expect(typingText(p(), true)).toBeNull();
  });
});

describe('prependPage', () => {
  it('ajoute la page en tête sans doublons', () => {
    expect(prependPage([msg('c', 3), msg('d', 4)], [msg('a', 1), msg('b', 2), msg('c', 3)]).map((m) => m.id)).toEqual(['a', 'b', 'c', 'd']);
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
    expect(visibleChats(all, '', 'main').map((c) => c.id)).toEqual(['a']);
    expect(visibleChats(all, '', 'archived').map((c) => c.id)).toEqual(['b']);
    expect(visibleChats(all, 'boul', 'main').map((c) => c.id)).toEqual(['b']);
  });

  it('filtres par liste (vue principale seulement)', () => {
    const lists = [
      { id: '1', name: 'Non lues', color: 0, kind: 'unread' },
      { id: '2', name: 'Favoris', color: 0, kind: 'favorites' },
      { id: '3', name: 'Groupes', color: 0, kind: 'groups' },
      { id: '4', name: 'École', color: 0, kind: 'custom' },
    ] as const;
    const chats = [chat('a', 1, 'A', { unread: 2 }), chat('b', 2, 'B', { favorite: true, labels: ['4'] }), chat('g', 3, 'G', { group: true, markedUnread: true }), chat('z', 4, 'Z', { archived: true, favorite: true })];
    const ids = (filter: string): string[] => visibleChats(chats, '', 'main', filter, lists).map((c) => c.id);
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
  it('message supprimé : clé différente (bulle reconstruite)', () => {
    const [, item] = itemsOf([msg('1', 100, { deleted: true })], false);
    expect(item?.key).toBe('m:1:x');
  });

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

  it('état d’un message envoyé (nombre ou nom)', () => {
    expect(statusOf(4)).toBe('read');
    expect(statusOf('DELIVERY_ACK')).toBe('delivered');
    expect(statusOf('SERVER_ACK')).toBe('sent');
    expect(statusOf(null)).toBeNull();
    // « en attente » ancien (historique) : envoyé
    expect(effectiveStatus('pending', 1000, 1100)).toBe('pending');
    expect(effectiveStatus('pending', 1000, 5000)).toBe('sent');
    expect(effectiveStatus('read', 1000, 5000)).toBe('read');
  });

  it('modification possible, impossible ou trop tard', () => {
    const now = 10_000;
    expect(editability({ fromMe: true, kind: 'text', deleted: false, timestamp: now - 60 }, now)).toBe('yes');
    expect(editability({ fromMe: true, kind: 'image', deleted: false, timestamp: now - 60 }, now)).toBe('yes');
    expect(editability({ fromMe: true, kind: 'text', deleted: false, timestamp: now - 3600 }, now)).toBe('late');
    expect(editability({ fromMe: false, kind: 'text', deleted: false, timestamp: now }, now)).toBe('no');
    expect(editability({ fromMe: true, kind: 'sticker', deleted: false, timestamp: now }, now)).toBe('no');
    expect(editability({ fromMe: true, kind: 'text', deleted: true, timestamp: now }, now)).toBe('no');
  });

  it('genre d’envoi d’un fichier', () => {
    expect(uploadKind('image/jpeg')).toBe('image');
    expect(uploadKind('image/gif')).toBe('document');
    expect(uploadKind('video/mp4')).toBe('video');
    expect(uploadKind('audio/ogg')).toBe('audio');
    expect(uploadKind('application/pdf')).toBe('document');
    expect(uploadKind('image/png', true)).toBe('document');
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

describe('sélection de messages', () => {
  it('copie : texte seul pour un message, lignes datées sinon', () => {
    const t = GLib.DateTime.new_local(2026, 11, 6, 14, 5, 0)?.to_unix() ?? 0;
    expect(copyText([msg('salut', t)], 'Alice')).toBe('salut');
    expect(copyText([msg('salut', t), msg('oui', t, { fromMe: true }), msg('x', t, { kind: 'image', text: '', senderName: 'Bob' })], 'Alice')).toBe('[06/11/2026 14:05] Alice : salut\n[06/11/2026 14:05] Moi : oui\n[06/11/2026 14:05] Bob : Photo');
  });
  it('« pour tous » seulement si tous sont à moi et récents', () => {
    const now = 1_000_000;
    expect(canRevokeAll([msg('a', now - 10, { fromMe: true }), msg('b', now - 20, { fromMe: true })], now)).toBeTrue();
    expect(canRevokeAll([msg('a', now - 10, { fromMe: true }), msg('b', now - 20)], now)).toBeFalse();
    expect(canRevokeAll([msg('a', now - 3 * 86_400, { fromMe: true })], now)).toBeFalse();
    expect(canRevokeAll([], now)).toBeFalse();
  });
});

describe('senderColor', () => {
  it('stable et différente selon le participant', () => {
    expect(senderColor('33600000001@s.whatsapp.net')).toBe(senderColor('33600000001@s.whatsapp.net'));
    const colors = new Set(['1', '2', '3', '4', '5', '6'].map((n) => senderColor(`3360000000${n}@s.whatsapp.net`)));
    expect(colors.size).toBeGreaterThan(3);
  });
});

describe('préférences', () => {
  it('réglages lus, valeurs par défaut si absents ou invalides', () => {
    expect(parseSettings(null).accent).toBe('system');
    expect(parseSettings('{"accent":"purple"}').accent).toBe('purple');
    expect(parseSettings('{"accent":"fuchsia"}').accent).toBe('system');
    expect(parseSettings('pas du json').accent).toBe('system');
    expect(parseSettings(null).notify).toBeTrue();
    expect(parseSettings('{"accent":"red","preview":false}')).toEqual({ accent: 'red', notify: true, preview: false });
  });
  it('CSS de l’accent', () => {
    expect(accentCss('system')).toBe('');
    expect(accentCss('whatsapp')).toBe(':root { --accent-bg-color: #00a884; }');
    expect(accentCss('purple')).toMatch(/^:root \{ --accent-bg-color: rgb\(/u);
  });
});

describe('chaînes', () => {
  it('à part de la liste principale, archivées comprises', () => {
    const all = [chat('a@s.whatsapp.net', 3), chat('1@newsletter', 2, 'Hadashot'), chat('2@newsletter', 1, 'Cuisine', { archived: true })];
    expect(visibleChats(all, '', 'main').map((c) => c.id)).toEqual(['a@s.whatsapp.net']);
    expect(visibleChats(all, '', 'channels').map((c) => c.id)).toEqual(['1@newsletter', '2@newsletter']);
    expect(visibleChats(all, '', 'archived').map((c) => c.id)).toEqual([]);
    expect(visibleChats(all, 'hada', 'main').map((c) => c.id)).toEqual(['1@newsletter']);
  });
});

describe('nouvelle discussion', () => {
  it('numéro saisi', () => {
    expect(phoneDigits('+33 6 12 34 56 78')).toBe('33612345678');
    expect(phoneDigits('(972) 54-655-8985')).toBe('972546558985');
    expect(phoneDigits('1234')).toBeNull();
    expect(phoneDigits('Alice')).toBeNull();
  });
  it('contacts par nom (sans accents) ou numéro', () => {
    const contacts = [{ id: '33611111111@s.whatsapp.net', name: 'Élodie' }, { id: '972522222222@s.whatsapp.net', name: 'Bob' }];
    expect(matchContacts(contacts, 'elo').map((c) => c.name)).toEqual(['Élodie']);
    expect(matchContacts(contacts, '5222').map((c) => c.name)).toEqual(['Bob']);
    expect(matchContacts(contacts, '').length).toBe(2);
  });
});

describe('snippetMarkup', () => {
  it('mots trouvés en gras, texte échappé', () => {
    expect(snippetMarkup('au \u0001café\u0002 <ici>\nfin')).toBe('au <b>café</b> &lt;ici&gt; fin');
  });
});

describe('discussion voisine', () => {
  it('suivante, précédente, bords', () => {
    const list = [chat('a', 3), chat('b', 2), chat('c', 1)];
    expect(neighbourChat(list, 'a', 1)).toBe('b');
    expect(neighbourChat(list, 'b', -1)).toBe('a');
    expect(neighbourChat(list, 'c', 1)).toBeNull();
    expect(neighbourChat(list, null, 1)).toBe('a');
    expect(neighbourChat(list, 'x', -1)).toBe('c');
    expect(neighbourChat([], null, 1)).toBeNull();
  });
});

const localTime = (y: number, mo: number, d: number): number => GLib.DateTime.new_local(y, mo, d, 12, 0, 0)?.to_unix() ?? 0;

describe('galerie', () => {
  it('groupée par mois, dans l’ordre reçu', () => {
    const t = localTime;
    const groups = byMonth([{ timestamp: t(2026, 11, 5) }, { timestamp: t(2026, 11, 1) }, { timestamp: t(2026, 10, 20) }]);
    expect(groups.map((g) => g.items.length)).toEqual([2, 1]);
    expect(groups[0]?.label).toMatch(/2026$/u);
  });
});

describe('sélection en glissant', () => {
  it('plage dans les deux sens, en plus de la sélection de départ', () => {
    const ids = ['a', 'b', 'c', 'd'];
    expect([...rangeSelection(ids, new Set(), 1, 3)]).toEqual(['b', 'c', 'd']);
    expect([...rangeSelection(ids, new Set(), 2, 0)].toSorted()).toEqual(['a', 'b', 'c']);
    expect([...rangeSelection(ids, new Set(['d']), 0, 1)].toSorted()).toEqual(['a', 'b', 'd']);
  });
  it('ligne sous le pointeur, entre deux lignes : celle du dessus', () => {
    const list = [{ top: 0, bottom: 40 }, { top: 44, bottom: 80 }, { top: 90, bottom: 120 }];
    expect(rowAt(list, 10)).toBe(0);
    expect(rowAt(list, 42)).toBe(0);
    expect(rowAt(list, 100)).toBe(2);
    expect(rowAt(list, -5)).toBe(-1);
  });
});
