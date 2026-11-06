// Réactions sous une bulle : pastilles par émoji ; un clic ouvre la fenêtre des réactions (comme
// WhatsApp Web) : nombre, filtres par émoji, choix d'une réaction, personnes ayant réagi.
import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';
import { onCleanup } from 'gnim';
import { type Message, QUICK_REACTIONS, type Reaction } from '../shared/api.ts';
import { avatarText } from './ChatList.tsx';
import { bindAvatar, type Pictures } from './pictures.ts';

export interface ReactionsContext {
  readonly pictures: Pictures;
  /** réagit au message (émoji vide : réaction retirée) */
  readonly react: (m: Message, emoji: string) => void;
}

/** Une ligne par personne et par réaction, dans l'ordre des émojis puis des réactions. */
export function reactionPeople(reactions: readonly Reaction[], emoji: string | null): { id: string | null; name: string; emoji: string }[] {
  return reactions.filter((r) => emoji === null || r.emoji === emoji).flatMap((r) => r.people.map((p) => ({ ...p, emoji: r.emoji })));
}

/** « 1 réaction », « 3 réactions ». */
export const reactionCount = (reactions: readonly Reaction[]): string => {
  const n = reactions.reduce((sum, r) => sum + r.count, 0);
  return `${n} réaction${n > 1 ? 's' : ''}`;
};

function openPopover(ctx: ReactionsContext, anchor: Gtk.Widget, m: Message, end: boolean): void {
  // aligné sur le bord de la bulle (à gauche pour un message reçu), pas centré sous la pastille
  const popover = new Gtk.Popover({ hasArrow: false, position: Gtk.PositionType.BOTTOM, halign: end ? Gtk.Align.END : Gtk.Align.START, cssClasses: ['reactions-popover'] });
  popover.set_parent(anchor);
  const content = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8, widthRequest: 300 });
  popover.set_child(content);
  content.append(new Gtk.Label({ label: reactionCount(m.reactions), xalign: 0, cssClasses: ['heading', 'dim-label'], marginStart: 4 }));

  // choix d'une réaction (bouton +) et filtres par émoji
  const chips = new Gtk.Box({ spacing: 6 });
  const picker = new Gtk.Box({ spacing: 2, visible: false, cssClasses: ['reaction-picker'] });
  const mine = m.reactions.find((r) => r.mine)?.emoji ?? null;
  for (const emoji of QUICK_REACTIONS) {
    const b = new Gtk.Button({ label: emoji, tooltipText: emoji === mine ? 'Retirer ma réaction' : `Réagir ${emoji}`, cssClasses: ['flat', 'reaction-pick', ...(emoji === mine ? ['mine'] : [])] });
    b.connect('clicked', () => {
      popover.popdown();
      ctx.react(m, emoji === mine ? '' : emoji);
    });
    picker.append(b);
  }
  const add = new Gtk.ToggleButton({ iconName: 'face-smile-symbolic', tooltipText: 'Réagir', cssClasses: ['reaction-chip', 'circular'] });
  add.connect('toggled', () => {
    picker.visible = add.active;
  });
  chips.append(add);

  const list = new Gtk.ListBox({ selectionMode: Gtk.SelectionMode.NONE, cssClasses: ['reaction-people'] });
  const show = (emoji: string | null): void => {
    list.remove_all();
    for (const p of reactionPeople(m.reactions, emoji)) {
      const mineRow = p.id === null;
      const row = new Gtk.Box({ spacing: 12, marginTop: 6, marginBottom: 6, marginStart: 4, marginEnd: 4 });
      const avatar = new Adw.Avatar({ size: 36, text: avatarText(p.name), showInitials: /\p{L}/u.test(p.name) });
      if (p.id !== null) bindAvatar(avatar, ctx.pictures.texture(p.id));
      row.append(avatar);
      const names = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, hexpand: true, valign: Gtk.Align.CENTER });
      names.append(new Gtk.Label({ label: p.name, xalign: 0, ellipsize: Pango.EllipsizeMode.END }));
      if (mineRow) names.append(new Gtk.Label({ label: 'Cliquer pour retirer', xalign: 0, cssClasses: ['caption', 'dim-label'] }));
      row.append(names);
      row.append(new Gtk.Label({ label: p.emoji, cssClasses: ['reaction-emoji'] }));
      const item = new Gtk.ListBoxRow({ child: row, activatable: mineRow, tooltipText: mineRow ? 'Retirer ma réaction' : p.name });
      list.append(item);
    }
  };
  list.connect('row-activated', () => {
    popover.popdown();
    ctx.react(m, '');
  });
  // « Toutes » seulement s'il y a plusieurs émojis
  let first: Gtk.ToggleButton | null = null;
  const filters: [string | null, string][] = m.reactions.length > 1 ? [[null, `Toutes ${m.reactions.reduce((n, r) => n + r.count, 0)}`]] : [];
  for (const r of m.reactions) filters.push([r.emoji, `${r.emoji} ${r.count}`]);
  for (const [emoji, label] of filters) {
    const b = new Gtk.ToggleButton({ label, active: first === null, cssClasses: ['reaction-chip', 'filter'] });
    if (first === null) first = b;
    else b.set_group(first);
    b.connect('toggled', () => {
      if (b.active) show(emoji);
    });
    chips.append(b);
  }
  content.append(chips);
  content.append(picker);
  content.append(new Gtk.Separator());
  const scroll = new Gtk.ScrolledWindow({ child: list, hscrollbarPolicy: Gtk.PolicyType.NEVER, propagateNaturalHeight: true, maxContentHeight: 320 });
  content.append(scroll);
  show(null);
  popover.connect('closed', () => {
    // détaché une fois fermé (l'action éventuelle est déjà lancée)
    popover.unparent();
  });
  popover.popup();
}

/** Pastilles des réactions sous une bulle ; clic : fenêtre des réactions. */
export function ReactionsRow(ctx: ReactionsContext, live: () => Message, subscribe: (fn: () => void) => () => void, end: boolean): Gtk.Widget {
  const box = new Gtk.Box({ spacing: 4, halign: end ? Gtk.Align.END : Gtk.Align.START, cssClasses: ['reactions'] });
  const build = (): void => {
    for (let c = box.get_first_child(); c !== null; c = box.get_first_child()) box.remove(c);
    const m = live();
    box.visible = m.reactions.length > 0;
    if (m.reactions.length === 0) return;
    // un seul bouton pour toutes les pastilles, comme WhatsApp (émojis puis total)
    const total = m.reactions.reduce((n, r) => n + r.count, 0);
    const label = `${m.reactions.map((r) => r.emoji).join('')}${total > 1 ? ` ${total}` : ''}`;
    const b = new Gtk.Button({ label, tooltipText: `${reactionCount(m.reactions)} — voir qui a réagi`, cssClasses: ['reaction-chip', ...(m.reactions.some((r) => r.mine) ? ['mine'] : [])] });
    b.connect('clicked', () => openPopover(ctx, b, live(), end));
    box.append(b);
  };
  build();
  onCleanup(subscribe(build));
  return box;
}
