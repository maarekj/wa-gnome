// Fiche d'un contact ou d'un groupe (clic sur le nom dans l'en-tête de la discussion) : photo,
// nom, numéro, « À propos » ou description, participants ; médias, recherche, mode silencieux.
import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';
import { type ChatInfo, formatPhone, isMuted, type Participant } from '../shared/api.ts';
import { errorMessage } from '../shared/errors.ts';
import { esc, fmtDay } from '../shared/format.ts';
import type { Store } from '../shared/store.ts';
import { avatarText } from './ChatList.tsx';
import { bindAvatar, type Pictures } from './pictures.ts';

/** Actions proposées par la fiche (ouvertes dans la fenêtre principale). */
export interface InfoActions {
  readonly gallery: () => void;
  readonly search: () => void;
  readonly toast: (text: string) => void;
}

/** Sous-titre de la fiche : numéro (contact) ou nombre de participants (groupe). */
export function infoSubtitle(info: Pick<ChatInfo, 'group' | 'phone' | 'participants'>): string {
  if (info.group) return info.participants.length === 1 ? 'Groupe · 1 participant' : `Groupe · ${info.participants.length} participants`;
  return info.phone === null ? '' : formatPhone(info.phone);
}

/** Jour en minuscules, espaces simples (« jeudi 5 novembre 2026 »). */
const dayText = (t: number): string => fmtDay(t).toLowerCase().replaceAll(/\s+/gu, ' ');

/** Libellé du rôle d'un participant. */
export const roleOf = (p: Pick<Participant, 'admin'>): string => (p.admin === 'superadmin' ? 'Créateur du groupe' : p.admin === 'admin' ? 'Administrateur' : '');

function participantRow(p: Participant, pictures: Pictures, open: (p: Participant) => void): Adw.ActionRow {
  const row = new Adw.ActionRow({ title: esc(p.name), subtitle: p.me ? '' : formatPhone(p.id.split('@')[0] ?? ''), activatable: !p.me });
  const avatar = new Adw.Avatar({ size: 32, text: avatarText(p.name), showInitials: /\p{L}/u.test(p.name) });
  bindAvatar(avatar, pictures.texture(p.id));
  row.add_prefix(avatar);
  const role = roleOf(p);
  if (role !== '') row.add_suffix(new Gtk.Label({ label: role, cssClasses: ['caption', 'dim-label'] }));
  if (!p.me) {
    row.tooltipText = `Discuter avec ${p.name}`;
    row.connect('activated', () => open(p));
  }
  return row;
}

/** En-tête de la fiche : grande photo, nom, sous-titre. */
function header(info: ChatInfo, pictures: Pictures): Gtk.Widget {
  const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6, marginTop: 6, marginBottom: 12, halign: Gtk.Align.CENTER });
  const avatar = new Adw.Avatar({ size: 120, text: avatarText(info.name), showInitials: /\p{L}/u.test(info.name), halign: Gtk.Align.CENTER });
  bindAvatar(avatar, pictures.texture(info.id));
  box.append(avatar);
  box.append(new Gtk.Label({ label: info.name, wrap: true, justify: Gtk.Justification.CENTER, cssClasses: ['title-2'] }));
  const sub = infoSubtitle(info);
  if (sub !== '') box.append(new Gtk.Label({ label: sub, cssClasses: ['dim-label'] }));
  if (info.publicName !== null && info.publicName !== info.name) box.append(new Gtk.Label({ label: `~ ${info.publicName}`, cssClasses: ['caption', 'dim-label'] }));
  return box;
}

/** Ligne de texte long (« À propos », description) : texte sélectionnable sous un titre. */
function textRow(title: string, text: string, footnote: string | null): Adw.PreferencesRow {
  const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4, marginTop: 10, marginBottom: 10, marginStart: 12, marginEnd: 12 });
  box.append(new Gtk.Label({ label: title, xalign: 0, cssClasses: ['caption', 'dim-label'] }));
  box.append(new Gtk.Label({ label: text, xalign: 0, wrap: true, wrapMode: Pango.WrapMode.WORD_CHAR, selectable: true }));
  if (footnote !== null) box.append(new Gtk.Label({ label: footnote, xalign: 0, cssClasses: ['caption', 'dim-label'] }));
  return new Adw.PreferencesRow({ child: box, activatable: false });
}

/** Contenu de la fiche une fois chargée. */
function content(info: ChatInfo, store: Store, pictures: Pictures, actions: InfoActions, close: () => void): Adw.PreferencesPage {
  const page = new Adw.PreferencesPage();
  const top = new Adw.PreferencesGroup();
  top.add(header(info, pictures));
  page.add(top);

  const details = new Adw.PreferencesGroup();
  if (info.about !== null) details.add(textRow('À propos', info.about, info.aboutAt === null ? null : `Depuis ${dayText(info.aboutAt)}`));
  if (info.description !== null && info.description !== '') details.add(textRow('Description', info.description, null));
  if (info.group && info.created !== null) details.add(new Adw.ActionRow({ title: 'Créé', subtitle: dayText(info.created), activatable: false }));
  if (info.phone !== null) {
    const phone = new Adw.ActionRow({ title: 'Numéro', subtitle: formatPhone(info.phone), activatable: false });
    const copy = new Gtk.Button({ iconName: 'edit-copy-symbolic', tooltipText: 'Copier le numéro', valign: Gtk.Align.CENTER, cssClasses: ['flat'] });
    copy.connect('clicked', () => {
      copy.get_clipboard().set(`+${info.phone ?? ''}`);
      actions.toast('Numéro copié');
    });
    phone.add_suffix(copy);
    details.add(phone);
  }
  if (details.get_first_child() !== null) page.add(details);

  const tools = new Adw.PreferencesGroup();
  const action = (title: string, icon: string, run: () => void): void => {
    const row = new Adw.ActionRow({ title, activatable: true });
    row.add_prefix(new Gtk.Image({ iconName: icon }));
    row.add_suffix(new Gtk.Image({ iconName: 'go-next-symbolic', cssClasses: ['dim-label'] }));
    row.connect('activated', () => {
      close();
      run();
    });
    tools.add(row);
  };
  action('Médias, documents et audio', 'folder-pictures-symbolic', actions.gallery);
  action('Rechercher dans la discussion', 'system-search-symbolic', actions.search);
  const chat = store.chats.peek().find((c) => c.id === info.id);
  const mute = new Adw.SwitchRow({ title: 'Mode silencieux', subtitle: 'Ni notification ni son pour cette discussion', active: chat !== undefined && isMuted(chat) });
  mute.add_prefix(new Gtk.Image({ iconName: 'notifications-disabled-symbolic' }));
  mute.connect('notify::active', () => {
    store.chatAction(info.id, { action: 'mute', until: mute.active ? -1 : null }).catch((error: unknown) => actions.toast(`Impossible : ${errorMessage(error)}`));
  });
  mute.sensitive = chat !== undefined;
  tools.add(mute);
  page.add(tools);

  // groupes en commun (contact) : clic, le groupe s'ouvre
  if (!info.group && info.commonGroups.length > 0) {
    const common = new Adw.PreferencesGroup({ title: info.commonGroups.length === 1 ? '1 groupe en commun' : `${info.commonGroups.length} groupes en commun` });
    for (const g of info.commonGroups) {
      const row = new Adw.ActionRow({ title: esc(g.name), subtitle: g.size === 1 ? '1 participant' : `${g.size} participants`, activatable: true, tooltipText: `Ouvrir ${g.name}` });
      const avatar = new Adw.Avatar({ size: 32, text: avatarText(g.name), showInitials: /\p{L}/u.test(g.name) });
      bindAvatar(avatar, pictures.texture(g.id));
      row.add_prefix(avatar);
      row.connect('activated', () => {
        close();
        store.startChat(g.id, g.name);
      });
      common.add(row);
    }
    page.add(common);
  }
  if (info.group && info.participants.length > 0) {
    const members = new Adw.PreferencesGroup({ title: infoSubtitle(info).replace('Groupe · ', '') });
    for (const p of info.participants) {
      members.add(
        participantRow(p, pictures, (person) => {
          close();
          store.startChat(person.id, person.name);
        }),
      );
    }
    page.add(members);
  }
  return page;
}

/** Fenêtre de la fiche : chargée depuis le démon (spinner, puis contenu ou erreur). */
export function openChatInfo(parent: Gtk.Widget, store: Store, pictures: Pictures, chatId: string, name: string, actions: InfoActions): void {
  const stack = new Gtk.Stack({ transitionType: Gtk.StackTransitionType.CROSSFADE, vexpand: true });
  stack.add_named(new Adw.Spinner({ halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER, widthRequest: 32, heightRequest: 32 }), 'loading');
  const view = new Adw.ToolbarView({ content: stack });
  view.add_top_bar(new Adw.HeaderBar());
  const group = chatId.endsWith('@g.us');
  const dialog = new Adw.Dialog({ title: group ? 'Infos du groupe' : 'Infos du contact', child: view, contentWidth: 460, contentHeight: 680 });
  dialog.present(parent);
  void (async (): Promise<void> => {
    try {
      const info = await store.client.info(chatId);
      stack.add_named(
        content(info, store, pictures, actions, () => {
          dialog.close();
        }),
        'info',
      );
      stack.visibleChildName = 'info';
    } catch (error) {
      stack.add_named(new Adw.StatusPage({ iconName: 'dialog-warning-symbolic', title: name, description: `Infos indisponibles : ${errorMessage(error)}` }), 'error');
      stack.visibleChildName = 'error';
    }
  })();
}
