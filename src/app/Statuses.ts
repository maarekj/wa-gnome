// Statuts (« stories ») en lecture : liste des personnes (non vus d'abord), puis visionneuse plein
// écran (photo, vidéo, texte sur fond de couleur) qui passe au statut suivant toute seule ;
// chaque statut affiché est marqué vu (et accusé à son auteur, comme le téléphone).
import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';
import type { StatusGroup, StatusItem } from '../shared/api.ts';
import { errorMessage } from '../shared/errors.ts';
import { fmtDateTime, mentionMarkup, waMarkup } from '../shared/format.ts';
import type { Store } from '../shared/store.ts';
import { MediaLoader } from './media.ts';
import type { Pictures } from './pictures.ts';

/** Durée d'affichage d'une photo ou d'un texte (ms) ; vidéo : sa durée. */
const SHOW_MS = 6000;

/** Statuts non vus d'une personne. */
export const unseenCount = (g: StatusGroup): number => g.items.filter((i) => !i.seen).length;

/** Premier statut à montrer : le premier non vu, sinon le premier. */
export const startIndex = (g: StatusGroup): number => Math.max(0, g.items.findIndex((i) => !i.seen));

/** Ligne d'une personne : photo (cercle accentué s'il y a du nouveau), nom, heure du dernier statut. */
function groupRow(pictures: Pictures, g: StatusGroup): Gtk.ListBoxRow {
  const box = new Gtk.Box({ spacing: 12, marginTop: 6, marginBottom: 6, marginStart: 6, marginEnd: 6 });
  const avatar = new Adw.Avatar({ size: 44, text: g.name.replace(/^~\s*/u, ''), showInitials: true, cssClasses: unseenCount(g) > 0 ? ['status-ring'] : ['status-ring', 'seen'] });
  if (!g.me) avatar.set_custom_image(pictures.texture(g.sender).peek());
  box.append(avatar);
  const texts = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, valign: Gtk.Align.CENTER, hexpand: true });
  texts.append(new Gtk.Label({ label: g.name, xalign: 0, ellipsize: Pango.EllipsizeMode.END, cssClasses: ['heading'] }));
  const last = g.items.at(-1)?.message.timestamp ?? 0;
  const n = g.items.length;
  texts.append(new Gtk.Label({ label: `${n === 1 ? '1 statut' : `${n} statuts`} · ${fmtDateTime(last)}`, xalign: 0, cssClasses: ['caption', 'dim-label'] }));
  box.append(texts);
  const unseen = unseenCount(g);
  if (unseen > 0) box.append(new Gtk.Label({ label: String(unseen), valign: Gtk.Align.CENTER, cssClasses: ['unread-badge'] }));
  const row = new Gtk.ListBoxRow({ child: box, tooltipText: `Voir les statuts de ${g.name}` });
  row.update_property([Gtk.AccessibleProperty.LABEL], [`Statuts de ${g.name}`]);
  return row;
}

/** Fenêtre des statuts : liste des personnes, puis visionneuse. */
export function openStatuses(parent: Gtk.Widget, store: Store, pictures: Pictures, toast: (t: string) => void): void {
  const loader = new MediaLoader(store.client);
  const nav = new Adw.NavigationView();
  const list = new Gtk.ListBox({ selectionMode: Gtk.SelectionMode.NONE, cssClasses: ['boxed-list'], marginTop: 12, marginBottom: 12, marginStart: 12, marginEnd: 12, valign: Gtk.Align.START });
  const empty = new Adw.StatusPage({ iconName: 'camera-photo-symbolic', title: 'Aucun statut', description: 'Les statuts de vos contacts des dernières 24 heures apparaissent ici' });
  const stack = new Gtk.Stack();
  stack.add_named(new Gtk.ScrolledWindow({ child: list, hscrollbarPolicy: Gtk.PolicyType.NEVER }), 'list');
  stack.add_named(empty, 'empty');
  const top = new Adw.ToolbarView({ content: stack });
  top.add_top_bar(new Adw.HeaderBar());
  nav.add(new Adw.NavigationPage({ title: 'Statuts', child: top, tag: 'list' }));
  let shown: readonly StatusGroup[] = [];
  const render = (): void => {
    shown = store.statuses.peek();
    list.remove_all();
    for (const g of shown) list.append(groupRow(pictures, g));
    stack.visibleChildName = shown.length === 0 ? 'empty' : 'list';
  };
  render();
  const off = store.statuses.subscribe(render);
  list.connect('row-activated', (_l: Gtk.ListBox, row: Gtk.ListBoxRow) => {
    const index = row.get_index();
    const g = shown[index];
    if (g !== undefined) nav.push(viewerPage(store, loader, toast, shown, index, startIndex(g)));
  });
  const root = parent.get_root();
  const [ww, wh] = root instanceof Gtk.Window ? [root.get_width(), root.get_height()] : [900, 700];
  const dialog = new Adw.Dialog({ title: 'Statuts', child: nav, contentWidth: Math.min(560, Math.round(ww * 0.9)), contentHeight: Math.round(wh * 0.9) });
  dialog.connect('closed', off);
  void store.loadStatuses();
  dialog.present(parent);
}

/** Visionneuse : statut `item` de la personne `group`, passage au suivant (et à la personne suivante). */
function viewerPage(store: Store, loader: MediaLoader, toast: (t: string) => void, groups: readonly StatusGroup[], group: number, item: number): Adw.NavigationPage {
  // barres d'avancement (une par statut de la personne)
  const bars = new Gtk.Box({ spacing: 4, marginTop: 6, marginStart: 10, marginEnd: 10, homogeneous: true });
  const title = new Gtk.Label({ xalign: 0, ellipsize: Pango.EllipsizeMode.END, cssClasses: ['heading'] });
  const when = new Gtk.Label({ xalign: 0, cssClasses: ['caption', 'dim-label'] });
  const head = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, marginStart: 10, marginTop: 6 });
  head.append(title);
  head.append(when);
  const frame = new Gtk.Box({ vexpand: true, hexpand: true, cssClasses: ['status-frame'] });
  const caption = new Gtk.Label({ wrap: true, wrapMode: Pango.WrapMode.WORD_CHAR, justify: Gtk.Justification.CENTER, useMarkup: true, marginTop: 8, marginBottom: 12, marginStart: 12, marginEnd: 12, selectable: true });
  const prev = new Gtk.Button({ iconName: 'go-previous-symbolic', tooltipText: 'Statut précédent (←)', cssClasses: ['osd', 'circular'], valign: Gtk.Align.CENTER, halign: Gtk.Align.START, marginStart: 10 });
  const next = new Gtk.Button({ iconName: 'go-next-symbolic', tooltipText: 'Statut suivant (→)', cssClasses: ['osd', 'circular'], valign: Gtk.Align.CENTER, halign: Gtk.Align.END, marginEnd: 10 });
  const pause = new Gtk.ToggleButton({ iconName: 'media-playback-pause-symbolic', tooltipText: 'Pause (Espace)', cssClasses: ['flat'] });
  const overlay = new Gtk.Overlay({ child: frame, vexpand: true });
  overlay.add_overlay(prev);
  overlay.add_overlay(next);
  const body = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
  body.append(bars);
  body.append(head);
  body.append(overlay);
  body.append(caption);
  const view = new Adw.ToolbarView({ content: body });
  const header = new Adw.HeaderBar();
  header.pack_end(pause);
  view.add_top_bar(header);
  const page = new Adw.NavigationPage({ title: 'Statut', child: view });

  let g = group;
  let i = item;
  let timer = 0;
  /** fond des statuts texte : un seul fournisseur de style, rechargé à chaque statut */
  const bgCss = new Gtk.CssProvider();
  // oxlint-disable-next-line typescript/no-deprecated -- seule API exposée par GJS pour le style d'un widget
  frame.get_style_context().add_provider(bgCss, Gtk.STYLE_PROVIDER_PRIORITY_USER);
  /** vus pendant cette visite (liste figée à l'ouverture) : pas de second accusé */
  const seen = new Set<string>();
  /** fin de la vidéo affichée (ms, horloge monotone), pour reprendre après une pause */
  let ends = 0;
  /** début de la pause (ms, horloge monotone) */
  let paused = 0;
  let video: Gtk.Video | null = null;
  const stop = (): void => {
    if (timer !== 0) GLib.source_remove(timer);
    timer = 0;
    video?.get_media_stream()?.pause();
    video = null;
  };
  const current = (): StatusItem | undefined => groups[g]?.items[i];
  /** suivant : statut de la personne, puis personne suivante ; fin : retour à la liste */
  const step = (delta: number): void => {
    const items = groups[g]?.items ?? [];
    if (i + delta >= 0 && i + delta < items.length) i += delta;
    else if (delta > 0 && g + 1 < groups.length) {
      g += 1;
      i = startIndex(groups[g] ?? { sender: '', name: '', me: false, items: [] });
    } else if (delta < 0 && g > 0) {
      g -= 1;
      i = Math.max(0, (groups[g]?.items.length ?? 1) - 1);
    } else {
      stop();
      page.activate_action('navigation.pop', null);
      return;
    }
    show();
  };
  const schedule = (ms: number): void => {
    if (timer !== 0) GLib.source_remove(timer);
    // programmé pendant la pause (vidéo chargée) : temps restant compté depuis maintenant
    if (pause.active) paused = GLib.get_monotonic_time() / 1000;
    ends = GLib.get_monotonic_time() / 1000 + ms;
    timer = pause.active
      ? 0
      : GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
          timer = 0;
          // fenêtre fermée ou page quittée : plus rien (ni affichage ni accusé « vu »)
          if (page.get_mapped()) step(1);
          return GLib.SOURCE_REMOVE;
        });
  };
  const show = (): void => {
    stop();
    if (!page.get_mapped()) return;
    bgCss.load_from_string('');
    const it = current();
    const who = groups[g];
    if (it === undefined || who === undefined) return;
    const m = it.message;
    title.label = who.name;
    when.label = fmtDateTime(m.timestamp);
    for (let c = bars.get_first_child(); c !== null; c = bars.get_first_child()) bars.remove(c);
    who.items.forEach((_x, k) => bars.append(new Gtk.ProgressBar({ fraction: k < i ? 1 : k === i ? 0.5 : 0, hexpand: true })));
    for (let c = frame.get_first_child(); c !== null; c = frame.get_first_child()) frame.remove(c);
    frame.set_css_classes(['status-frame']);
    const text = mentionMarkup(waMarkup(m.text), m.mentions);
    caption.label = text;
    caption.visible = m.kind !== 'text' && m.text !== '';
    if (m.kind === 'text') {
      // statut texte : en grand sur sa couleur de fond
      bgCss.load_from_string(`box { background: ${it.background ?? '#1c71d8'}; color: white; }`);
      frame.append(new Gtk.Label({ label: text, useMarkup: true, wrap: true, wrapMode: Pango.WrapMode.WORD_CHAR, justify: Gtk.Justification.CENTER, hexpand: true, vexpand: true, marginStart: 24, marginEnd: 24, cssClasses: ['status-text'] }));
      schedule(SHOW_MS);
    } else if (m.media === null) {
      frame.append(new Gtk.Label({ label: 'Statut non pris en charge', hexpand: true, cssClasses: ['dim-label'] }));
      schedule(2000);
    } else if (m.kind === 'video') {
      const media = m.media;
      const spinner = new Adw.Spinner({ hexpand: true, vexpand: true, widthRequest: 32, heightRequest: 32 });
      frame.append(spinner);
      void (async (): Promise<void> => {
        try {
          const file = await loader.file(m, media);
          if (current() !== it) return;
          frame.remove(spinner);
          const v = new Gtk.Video({ file, autoplay: !pause.active, hexpand: true, vexpand: true });
          video = v;
          frame.append(v);
          schedule(Math.max(SHOW_MS, (media.seconds ?? 6) * 1000 + 500));
        } catch (error) {
          toast(`Vidéo indisponible : ${errorMessage(error)}`);
          schedule(1500);
        }
      })();
    } else {
      const picture = new Gtk.Picture({ contentFit: Gtk.ContentFit.CONTAIN, hexpand: true, vexpand: true, canShrink: true });
      frame.append(picture);
      void (async (): Promise<void> => {
        try {
          const loaded = await loader.load(m);
          if (current() === it) picture.paintable = loaded.texture;
        } catch (error) {
          toast(`Photo indisponible : ${errorMessage(error)}`);
        }
      })();
      schedule(SHOW_MS);
    }
    // vu : noté et accusé (pas les miens)
    if (!it.seen && !who.me && !seen.has(m.id)) {
      seen.add(m.id);
      void store.client.seeStatus(m.id).catch((error: unknown) => console.error(`statut vu : ${errorMessage(error)}`));
    }
  };
  prev.connect('clicked', () => step(-1));
  next.connect('clicked', () => step(1));
  pause.connect('toggled', () => {
    pause.iconName = pause.active ? 'media-playback-start-symbolic' : 'media-playback-pause-symbolic';
    pause.tooltipText = pause.active ? 'Reprendre (Espace)' : 'Pause (Espace)';
    if (pause.active) {
      paused = GLib.get_monotonic_time() / 1000;
      if (timer !== 0) GLib.source_remove(timer);
      timer = 0;
      video?.get_media_stream()?.pause();
    } else {
      video?.get_media_stream()?.play();
      // temps restant (vidéo coupée sinon), au moins une seconde
      const left = paused > 0 ? Math.max(1000, ends - paused) : SHOW_MS;
      schedule(left);
    }
  });
  const keys = new Gtk.EventControllerKey();
  keys.connect('key-pressed', (_c: Gtk.EventControllerKey, keyval: number) => {
    if (keyval === Gdk.KEY_Right) step(1);
    else if (keyval === Gdk.KEY_Left) step(-1);
    else if (keyval === Gdk.KEY_space) pause.active = !pause.active;
    else return false;
    return true;
  });
  page.add_controller(keys);
  page.connect('hidden', stop);
  // fenêtre fermée avec la visionneuse ouverte : arrêtée aussi
  page.connect('unmap', stop);
  page.connect('shown', show);
  return page;
}

/** Entrée « Statuts » de la barre latérale : nombre de personnes avec du nouveau. */
export function statusEntryLabel(groups: readonly StatusGroup[]): string {
  const fresh = groups.filter((g) => !g.me && unseenCount(g) > 0).length;
  if (fresh > 0) return fresh === 1 ? '1 nouveau' : `${fresh} nouveaux`;
  return String(groups.filter((g) => !g.me).length);
}
