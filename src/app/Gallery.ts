// Galerie des médias d'une discussion : photos et vidéos (grille par mois), documents, audio ;
// pages chargées au défilement. Clic : visionneuse, lecteur ou application par défaut ; clic
// droit (ou bouton) : aller au message dans la conversation.
import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import type { GalleryTab, Media, Message } from '../shared/api.ts';
import { errorMessage } from '../shared/errors.ts';
import { fmtShortDate } from '../shared/format.ts';
import type { Store } from '../shared/store.ts';
import { fmtDuration, type MediaLoader, openViewer, type Photo, thumbnailTexture } from './media.ts';
import { MediaFrame } from './MediaFrame.ts';
import { AudioView, DocumentView, type MediaContext, openVideo } from './MediaViews.ts';

/** Messages chargés par page. */
const PAGE = 60;
/** Côté d'une vignette (px). */
const TILE = 112;

type MediaMessage = Message & { media: Media };
const hasMedia = (m: Message): m is MediaMessage => m.media !== null;

/** Libellé du mois d'un message (« novembre 2026 »), première lettre en capitale. */
export function monthLabel(seconds: number): string {
  const s = GLib.DateTime.new_from_unix_local(seconds)?.format('%B %Y') ?? '';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Messages groupés par mois, dans l'ordre reçu (plus récents d'abord). */
export function byMonth<T extends { timestamp: number }>(list: readonly T[]): { label: string; items: T[] }[] {
  const groups: { label: string; items: T[] }[] = [];
  for (const m of list) {
    const label = monthLabel(m.timestamp);
    const last = groups.at(-1);
    if (last?.label === label) last.items.push(m);
    else groups.push({ label, items: [m] });
  }
  return groups;
}

interface GalleryContext extends MediaContext {
  readonly store: Store;
  /** fermeture de la galerie, message amené dans la conversation */
  readonly goTo: (m: Message) => void;
}

/** Clic droit / appui long : menu « Aller au message ». */
function attachGoTo(ctx: GalleryContext, widget: Gtk.Widget, m: Message): void {
  const show = (x: number, y: number): void => {
    const pop = new Gtk.Popover({ hasArrow: false });
    const button = new Gtk.Button({ label: 'Aller au message', cssClasses: ['flat'] });
    button.connect('clicked', () => {
      pop.popdown();
      ctx.goTo(m);
    });
    pop.set_child(button);
    pop.set_parent(widget);
    pop.set_pointing_to(new Gdk.Rectangle({ x: Math.round(x), y: Math.round(y), width: 1, height: 1 }));
    pop.connect('closed', () => {
      GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        pop.unparent();
        return GLib.SOURCE_REMOVE;
      });
    });
    pop.popup();
  };
  const right = new Gtk.GestureClick({ button: Gdk.BUTTON_SECONDARY });
  right.connect('pressed', (_g: Gtk.GestureClick, _n: number, x: number, y: number) => show(x, y));
  widget.add_controller(right);
  const press = new Gtk.GestureLongPress({ touchOnly: true });
  press.connect('pressed', (_g: Gtk.GestureLongPress, x: number, y: number) => show(x, y));
  widget.add_controller(press);
}

/** Vignette d'une photo ou d'une vidéo (miniature, puis image complète pour les photos). */
function tile(ctx: GalleryContext, m: MediaMessage, open: () => void): Gtk.Widget {
  const frame = new MediaFrame({ cssClasses: ['gallery-tile'] });
  frame.setup(TILE, TILE, 'cover', 6);
  frame.setPaintable(thumbnailTexture(m.media));
  const overlay = new Gtk.Overlay({ child: frame, tooltipText: m.kind === 'video' ? 'Lire la vidéo' : 'Ouvrir la photo', name: `g:${m.id}` });
  if (m.kind === 'video') {
    overlay.add_overlay(new Gtk.Image({ iconName: 'media-playback-start-symbolic', pixelSize: 20, halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER, cssClasses: ['video-play'] }));
    if (m.media.seconds !== null) overlay.add_overlay(new Gtk.Label({ label: fmtDuration(m.media.seconds), halign: Gtk.Align.START, valign: Gtk.Align.END, marginStart: 6, marginBottom: 4, cssClasses: ['video-duration', 'caption'] }));
  } else {
    void (async (): Promise<void> => {
      try {
        frame.setPaintable((await ctx.loader.load(m)).texture);
      } catch {
        overlay.add_css_class('media-error');
      }
    })();
  }
  overlay.set_cursor_from_name('pointer');
  const click = new Gtk.GestureClick({ button: Gdk.BUTTON_PRIMARY });
  click.connect('released', open);
  overlay.add_controller(click);
  attachGoTo(ctx, overlay, m);
  return overlay;
}

/** Ligne d'un document ou d'un audio : vue de la bulle, date, bouton « Aller au message ». */
function fileRow(ctx: GalleryContext, m: MediaMessage): Gtk.Widget {
  const row = new Gtk.ListBoxRow({ activatable: false, name: `g:${m.id}` });
  const box = new Gtk.Box({ spacing: 8, marginTop: 6, marginBottom: 6, marginStart: 8, marginEnd: 8 });
  const view = m.kind === 'audio' ? AudioView(ctx, m) : DocumentView(ctx, m);
  view.hexpand = true;
  box.append(view);
  box.append(new Gtk.Label({ label: fmtShortDate(m.timestamp), cssClasses: ['caption', 'dim-label'], valign: Gtk.Align.CENTER }));
  const go = new Gtk.Button({ iconName: 'mail-reply-sender-symbolic', tooltipText: 'Aller au message', valign: Gtk.Align.CENTER, cssClasses: ['flat', 'circular'] });
  go.connect('clicked', () => ctx.goTo(m));
  box.append(go);
  row.set_child(box);
  return row;
}

/** Contenu d'un onglet : chargé à la première ouverture, page suivante près du bas. */
function tabPage(ctx: GalleryContext, chatId: string, tab: GalleryTab, empty: string): { widget: Gtk.Widget; load: () => void } {
  const loaded: MediaMessage[] = [];
  let busy = false;
  let end = false;
  const content = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6, marginTop: 12, marginBottom: 12, marginStart: 12, marginEnd: 12 });
  const status = new Gtk.Label({ cssClasses: ['dim-label'], marginTop: 24, wrap: true });
  const spinner = new Adw.Spinner({ halign: Gtk.Align.CENTER, marginTop: 12, marginBottom: 12, visible: false });
  const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
  box.append(content);
  box.append(spinner);
  box.append(status);
  const scroller = new Gtk.ScrolledWindow({ child: new Adw.Clamp({ child: box, maximumSize: 900 }), vexpand: true, hscrollbarPolicy: Gtk.PolicyType.NEVER });
  // dernier mois affiché : les vignettes d'une page suivante du même mois s'y ajoutent
  let month: { label: string; grid: Gtk.FlowBox } | null = null;
  let list: Gtk.ListBox | null = null;

  /** photos chargées, ordre chronologique (visionneuse : précédente / suivante) */
  const photos = (): Photo[] => loaded.filter((m) => m.kind === 'image').toReversed();
  const open = (m: MediaMessage, anchor: Gtk.Widget): void => {
    if (m.kind === 'image') {
      const all = photos();
      openViewer(anchor, ctx.chatName(), all, Math.max(0, all.findIndex((p) => p.id === m.id)), ctx.loader, ctx.toast);
      return;
    }
    void (async (): Promise<void> => {
      try {
        openVideo(anchor, ctx, m, await ctx.loader.file(m, m.media));
      } catch (error) {
        ctx.toast(`Vidéo indisponible : ${errorMessage(error)}`);
      }
    })();
  };
  const append = (page: readonly MediaMessage[]): void => {
    if (tab !== 'visual') {
      if (list === null) {
        list = new Gtk.ListBox({ selectionMode: Gtk.SelectionMode.NONE, cssClasses: ['boxed-list'] });
        content.append(list);
      }
      for (const m of page) list.append(fileRow(ctx, m));
      return;
    }
    for (const group of byMonth(page)) {
      if (month?.label !== group.label) {
        content.append(new Gtk.Label({ label: group.label, xalign: 0, marginTop: month === null ? 0 : 12, cssClasses: ['heading'] }));
        const grid = new Gtk.FlowBox({ selectionMode: Gtk.SelectionMode.NONE, homogeneous: true, columnSpacing: 4, rowSpacing: 4, minChildrenPerLine: 3, maxChildrenPerLine: 12 });
        content.append(grid);
        month = { label: group.label, grid };
      }
      for (const m of group.items) {
        const t = tile(ctx, m, () => open(m, t));
        month.grid.append(t);
      }
    }
  };
  const load = (): void => {
    if (busy || end) return;
    busy = true;
    spinner.visible = true;
    void (async (): Promise<void> => {
      try {
        const last = loaded.at(-1);
        const page = (await ctx.store.client.gallery(chatId, tab, PAGE, last === undefined ? undefined : { timestamp: last.timestamp, id: last.id })).filter((m) => hasMedia(m));
        loaded.push(...page);
        append(page);
        if (page.length < PAGE) end = true;
        status.label = loaded.length === 0 ? empty : '';
        status.visible = loaded.length === 0;
      } catch (error) {
        // erreur passagère (démon redémarré) : nouvel essai au prochain défilement
        status.label = `Médias indisponibles : ${errorMessage(error)}`;
        status.visible = true;
      } finally {
        busy = false;
        spinner.visible = false;
      }
    })();
  };
  scroller.vadjustment.connect('value-changed', (adj: Gtk.Adjustment) => {
    if (adj.value + adj.pageSize > adj.upper - 400) load();
  });
  return { widget: scroller, load };
}

/** Fenêtre de la galerie d'une discussion. */
export function openGallery(parent: Gtk.Widget, store: Store, loader: MediaLoader, chatId: string, chatName: string, toast: (t: string) => void): void {
  let dialog: Adw.Dialog | null = null;
  const ctx: GalleryContext = {
    store,
    loader,
    toast,
    chatName: () => chatName,
    goTo: (m) => {
      dialog?.close();
      store.openAt(m.chatId, m.id, m.timestamp);
    },
  };
  const stack = new Adw.ViewStack({ vexpand: true });
  const tabs: [GalleryTab, string, string, string][] = [
    ['visual', 'Photos et vidéos', 'image-x-generic-symbolic', 'Aucune photo ni vidéo'],
    ['document', 'Documents', 'x-office-document-symbolic', 'Aucun document'],
    ['audio', 'Audio', 'audio-x-generic-symbolic', 'Aucun message audio'],
  ];
  const loaders = new Map<string, () => void>();
  for (const [tab, title, icon, empty] of tabs) {
    const page = tabPage(ctx, chatId, tab, empty);
    stack.add_titled_with_icon(page.widget, tab, title, icon);
    loaders.set(tab, page.load);
  }
  // onglet chargé à sa première ouverture
  const loadVisible = (): void => loaders.get(stack.visibleChildName ?? '')?.();
  stack.connect('notify::visible-child-name', loadVisible);
  const header = new Adw.HeaderBar({ titleWidget: new Adw.ViewSwitcher({ stack, policy: Adw.ViewSwitcherPolicy.WIDE }) });
  const view = new Adw.ToolbarView({ content: stack });
  view.add_top_bar(header);
  const root = parent.get_root();
  const [ww, wh] = root instanceof Gtk.Window ? [root.get_width(), root.get_height()] : [900, 700];
  dialog = new Adw.Dialog({ title: `Médias — ${chatName}`, child: view, contentWidth: Math.min(900, Math.round(ww * 0.9)), contentHeight: Math.round(wh * 0.9) });
  dialog.present(parent);
  loadVisible();
}
