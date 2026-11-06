// « Infos du message » (clic sur les coches d'un message envoyé, comme WhatsApp Web) : aperçu du
// message, puis dates de lecture et de distribution, par participant dans un groupe.
import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';
import { previewOf, type Message, type Receipt, statusRank } from '../shared/api.ts';
import { errorMessage } from '../shared/errors.ts';
import { fmtDay, fmtTime } from '../shared/format.ts';
import type { Store } from '../shared/store.ts';
import { avatarText } from './ChatList.tsx';
import { bindAvatar, type Pictures } from './pictures.ts';

/** « Aujourd'hui à 13:19 », « Hier à 08:02 », « lundi 3 novembre 2026 à 21:10 » ; « — » sans date. */
export function fmtWhen(seconds: number | null): string {
  if (seconds === null) return '—';
  return `${fmtDay(seconds)} à ${fmtTime(seconds)}`;
}

/** Groupe : lus d'abord (le plus récent en tête), puis distribués seulement. */
export function splitReceipts(receipts: readonly Receipt[]): { read: Receipt[]; delivered: Receipt[] } {
  const read = receipts.filter((r) => r.read !== null).toSorted((a, b) => (b.read ?? 0) - (a.read ?? 0));
  const delivered = receipts.filter((r) => r.read === null && r.delivered !== null).toSorted((a, b) => (b.delivered ?? 0) - (a.delivered ?? 0));
  return { read, delivered };
}

/**
 * Date d'une étape : connue, inconnue (étape atteinte mais accusé reçu avant l'enregistrement des
 * dates : WhatsApp ne permet pas de le redemander), ou pas encore atteinte.
 */
export function stepText(when: number | null, reached: boolean): string {
  if (when !== null) return fmtWhen(when);
  return reached ? 'Date inconnue (accusé reçu avant le suivi des dates)' : '—';
}

/** Ligne « ✓✓ Lu / date ». */
function stateRow(mark: string, cls: string, title: string, when: number | null, reached: boolean): Gtk.Widget {
  const row = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2, marginTop: 6, marginBottom: 6 });
  const head = new Gtk.Box({ spacing: 8 });
  head.append(new Gtk.Label({ label: mark, cssClasses: ['ticks', 'info-ticks', cls] }));
  head.append(new Gtk.Label({ label: title, xalign: 0, cssClasses: ['heading'] }));
  row.append(head);
  row.append(new Gtk.Label({ label: stepText(when, reached), xalign: 0, wrap: true, cssClasses: ['dim-label'] }));
  return row;
}

/** Section d'un groupe : titre puis personnes (photo, nom, date). */
function peopleSection(title: string, mark: string, cls: string, people: readonly Receipt[], when: (r: Receipt) => number | null, pictures: Pictures): Gtk.Widget {
  const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4 });
  const head = new Gtk.Box({ spacing: 8, marginTop: 6 });
  head.append(new Gtk.Label({ label: mark, cssClasses: ['ticks', 'info-ticks', cls] }));
  head.append(new Gtk.Label({ label: title, xalign: 0, cssClasses: ['heading'] }));
  box.append(head);
  for (const r of people) {
    const row = new Gtk.Box({ spacing: 12, marginTop: 4, marginBottom: 4 });
    const avatar = new Adw.Avatar({ size: 36, text: avatarText(r.name), showInitials: /\p{L}/u.test(r.name) });
    bindAvatar(avatar, pictures.texture(r.id));
    row.append(avatar);
    const text = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, valign: Gtk.Align.CENTER, hexpand: true });
    text.append(new Gtk.Label({ label: r.name, xalign: 0, ellipsize: Pango.EllipsizeMode.END }));
    text.append(new Gtk.Label({ label: fmtWhen(when(r)), xalign: 0, cssClasses: ['caption', 'dim-label'] }));
    row.append(text);
    box.append(row);
  }
  return box;
}

export function openMessageInfo(parent: Gtk.Widget, store: Store, pictures: Pictures, m: Message, toast: (t: string) => void): void {
  const content = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 12, marginTop: 12, marginBottom: 18, marginStart: 18, marginEnd: 18 });
  // aperçu du message
  const preview = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2, halign: Gtk.Align.END, cssClasses: ['bubble', 'outgoing'] });
  preview.append(new Gtk.Label({ label: m.kind === 'text' ? m.text : previewOf(m), wrap: true, wrapMode: Pango.WrapMode.WORD_CHAR, maxWidthChars: 40, xalign: 0, lines: 6, ellipsize: Pango.EllipsizeMode.END }));
  preview.append(new Gtk.Label({ label: fmtTime(m.timestamp), halign: Gtk.Align.END, cssClasses: ['caption', 'dim-label'] }));
  const frame = new Gtk.Box({ cssClasses: ['info-preview'] });
  frame.append(new Gtk.Box({ hexpand: true }));
  frame.append(preview);
  content.append(frame);
  const details = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6 });
  details.append(new Adw.Spinner({ halign: Gtk.Align.CENTER }));
  content.append(details);

  const scroll = new Gtk.ScrolledWindow({ child: content, hscrollbarPolicy: Gtk.PolicyType.NEVER, propagateNaturalHeight: true });
  const view = new Adw.ToolbarView({ content: scroll });
  view.add_top_bar(new Adw.HeaderBar());
  const dialog = new Adw.Dialog({ title: 'Infos du message', child: view, contentWidth: 420, contentHeight: 520 });
  dialog.present(parent);

  const group = m.chatId.endsWith('@g.us');
  const listened = m.kind === 'audio' || m.kind === 'video';
  const show = async (): Promise<void> => {
    let info: Awaited<ReturnType<typeof store.client.messageInfo>>;
    try {
      info = await store.client.messageInfo(m.chatId, m.id);
    } catch (error) {
      dialog.close();
      toast(`Infos indisponibles : ${errorMessage(error)}`);
      return;
    }
    {
      for (let c = details.get_first_child(); c !== null; c = details.get_first_child()) details.remove(c);
      if (!group) {
        const r = info.receipts[0] ?? null;
        // étapes atteintes d'après l'état du message (connu même sans date)
        const rank = statusRank(m.status ?? 'sent');
        if (listened) details.append(stateRow('✓✓', 'played', 'Écouté', r?.played ?? null, m.status === 'played'));
        details.append(stateRow('✓✓', 'read', 'Lu', r?.read ?? null, m.status !== 'error' && rank >= statusRank('read')));
        details.append(stateRow('✓✓', 'delivered', 'Distribué', r?.delivered ?? null, m.status !== 'error' && rank >= statusRank('delivered')));
        return;
      }
      const { read, delivered } = splitReceipts(info.receipts);
      if (read.length === 0 && delivered.length === 0) {
        details.append(new Gtk.Label({ label: 'Aucun accusé connu pour ce message : accusés reçus avant le suivi des dates, ou pas encore arrivés.', wrap: true, xalign: 0, cssClasses: ['dim-label'] }));
        return;
      }
      if (read.length > 0) details.append(peopleSection('Lu par', '✓✓', 'read', read, (r) => r.read, pictures));
      if (delivered.length > 0) details.append(peopleSection('Distribué à', '✓✓', 'delivered', delivered, (r) => r.delivered, pictures));
    }
  };
  void show();
}
