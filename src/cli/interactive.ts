// Mode interactif (`wa` sans commande, dans un terminal) : menus Clack au-dessus des mêmes appels.
/* oxlint-disable no-await-in-loop -- menus : une question après l'autre */
import * as p from '@clack/prompts';
import { type Chat, DEFAULT_ACCOUNT, isMuted } from '../shared/api.ts';
import { Client, endpoint } from './client.ts';
import { filterChats } from './commands.ts';
import { chatLines, hitLines, messageLines } from './format.ts';
import { answered, chooseChat, resolveList, type Session } from './prompt.ts';

/** Actions sur une discussion, jusqu'au retour au menu principal. */
async function chatMenu(s: Session, first: Chat): Promise<void> {
  let chat = first;
  for (;;) {
    const action = answered(
      await p.select({
        message: chat.name,
        options: [
          { value: 'read', label: 'Lire les derniers messages' },
          { value: 'send', label: 'Envoyer un message' },
          { value: 'mark', label: 'Marquer comme lue' },
          { value: 'archive', label: chat.archived ? 'Désarchiver' : 'Archiver' },
          { value: 'pin', label: chat.pinned > 0 ? 'Désépingler' : 'Épingler' },
          { value: 'mute', label: isMuted(chat) ? 'Réactiver les notifications' : 'Mode silencieux (8 h)' },
          { value: 'list', label: 'Ajouter à une liste' },
          { value: 'back', label: 'Retour' },
        ],
      }),
    );
    const c = s.client;
    switch (action) {
      case 'read': {
        const list = await c.messages(chat.id, 20);
        p.note(messageLines(list).join('\n') || '(aucun message)', chat.name);
        break;
      }
      case 'send': {
        const text = answered(
          await p.text({ message: `Message pour ${chat.name}`, validate: (v) => (v === undefined || v.trim() === '' ? 'Message vide' : undefined) }),
        );
        await c.send(chat.id, { text });
        p.log.success('Envoyé');
        break;
      }
      case 'mark':
        await c.read(chat.id);
        p.log.success('Lue');
        break;
      case 'archive':
        await c.chatAction(chat.id, { action: 'archive', value: !chat.archived });
        p.log.success(chat.archived ? 'Désarchivée' : 'Archivée');
        break;
      case 'pin':
        await c.chatAction(chat.id, { action: 'pin', value: chat.pinned === 0 });
        p.log.success(chat.pinned > 0 ? 'Désépinglée' : 'Épinglée');
        break;
      case 'mute':
        await c.chatAction(chat.id, { action: 'mute', until: isMuted(chat) ? null : Date.now() + 8 * 3_600_000 });
        p.log.success(isMuted(chat) ? 'Notifications réactivées' : 'Silencieuse pendant 8 h');
        break;
      case 'list': {
        const list = await resolveList(s);
        await c.chatAction(chat.id, { action: 'label', labelId: list.id, value: true });
        p.log.success(`Ajoutée à « ${list.name} »`);
        break;
      }
      default:
        return;
    }
    const id = chat.id;
    chat = (await c.chats()).find((x) => x.id === id) ?? chat;
  }
}

/** Menu principal, jusqu'à « Quitter ». */
export async function interactive(account = DEFAULT_ACCOUNT): Promise<void> {
  const s: Session = { interactive: true, client: new Client(endpoint(), account), prompted: true };
  p.intro('WhatsApp');
  const st = await s.client.status();
  if (st.state !== 'open') p.log.warn(`Connexion : ${st.state}${st.state === 'qr' ? ' (appareil à appairer depuis l’application)' : ''}`);
  for (;;) {
    const choice = answered(
      await p.select({
        message: 'Que faire ?',
        options: [
          { value: 'chats', label: 'Ouvrir une discussion' },
          { value: 'unread', label: 'Discussions non lues' },
          { value: 'search', label: 'Rechercher dans les messages' },
          { value: 'lists', label: 'Listes' },
          { value: 'quit', label: 'Quitter' },
        ],
      }),
    );
    if (choice === 'quit') break;
    const all = await s.client.chats();
    if (choice === 'chats' || choice === 'unread') {
      const shown = filterChats(all, { unread: choice === 'unread', archived: false, groups: false });
      if (shown.length === 0) p.log.info('Aucune discussion');
      else await chatMenu(s, await chooseChat(s, shown));
    } else if (choice === 'search') {
      const q = answered(await p.text({ message: 'Texte cherché' }));
      p.note(hitLines(await s.client.search(q, 20)).join('\n') || '(aucun résultat)', `« ${q} »`);
    } else {
      const list = await resolveList(s);
      const members = filterChats(all, { unread: false, archived: false, groups: false, list });
      p.note(chatLines(members).join('\n') || '(vide)', list.name);
      if (members.length > 0) await chatMenu(s, await chooseChat(s, members));
    }
  }
  p.outro('À bientôt');
}
