// Médias des messages : chargement depuis le démon (limité en parallèle, gardé en mémoire),
// aperçu en grand et enregistrement.
import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import type { Media, Message } from '../shared/api.ts';
import type { WaClient } from '../shared/client.ts';
import { errorMessage } from '../shared/errors.ts';
import { waMarkup } from '../shared/format.ts';
import { openLinks } from './widgets.ts';

Gio._promisify(Gtk.FileDialog.prototype, 'save', 'save_finish');
Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async', 'replace_contents_finish');
Gio._promisify(Gio.File.prototype, 'load_bytes_async', 'load_bytes_finish');
Gio._promisify(Gtk.FileLauncher.prototype, 'launch', 'launch_finish');

/** Taille d'affichage d'un média de `w`×`h` dans une boîte `max`×`max` (jamais agrandi au-delà de l'original). */
export function displaySize(w: number | null, h: number | null, max: number, min = 80): [number, number] {
  if (w === null || h === null || w <= 0 || h <= 0) return [max, Math.round(max * 0.75)];
  const scale = Math.min(1, max / Math.max(w, h));
  return [Math.max(min, Math.round(w * scale)), Math.max(min, Math.round(h * scale))];
}

export interface Loaded {
  readonly texture: Gdk.Texture;
  readonly bytes: GLib.Bytes;
}

/** Téléchargements simultanés au plus (une discussion peut contenir des dizaines d'images). */
const PARALLEL = 3;
/** Médias gardés en mémoire (les plus récemment demandés). */
const KEEP = 80;

export class MediaLoader {
  readonly #client: WaClient;
  readonly #cache = new Map<string, Promise<Loaded>>();
  readonly #queue: (() => void)[] = [];
  /** fichiers en cours d'écriture ou écrits (pas de contenu gardé en mémoire) */
  readonly #files = new Map<string, Promise<Gio.File>>();
  #running = 0;

  constructor(client: WaClient) {
    this.#client = client;
  }

  load(m: Pick<Message, 'chatId' | 'id'>): Promise<Loaded> {
    const key = `${m.chatId}/${m.id}`;
    const cached = this.#cache.get(key);
    if (cached !== undefined) {
      // remis en tête (le plus récent)
      this.#cache.delete(key);
      this.#cache.set(key, cached);
      return cached;
    }
    const promise = this.#slot(async () => {
      const bytes = await this.#client.media(m.chatId, m.id);
      return { texture: Gdk.Texture.new_from_bytes(bytes), bytes };
    });
    // échec : pas gardé, un nouvel essai retélécharge
    promise.catch(() => this.#cache.delete(key));
    this.#cache.set(key, promise);
    for (const old of this.#cache.keys()) {
      if (this.#cache.size <= KEEP) break;
      this.#cache.delete(old);
    }
    return promise;
  }

  /**
   * Média enregistré dans le cache de l'utilisateur (documents, vocaux, vidéos : ouverts par une
   * autre application ou lus par GStreamer depuis un fichier). Réutilisé s'il y est déjà.
   */
  file(m: Pick<Message, 'chatId' | 'id' | 'timestamp'>, media: Media): Promise<Gio.File> {
    const key = `file:${m.chatId}/${m.id}`;
    const pending = this.#files.get(key);
    if (pending !== undefined) return pending;
    const dir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'wa-gnome', 'media', GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, `${m.chatId}/${m.id}`, -1)?.slice(0, 24) ?? m.id]);
    const file = Gio.File.new_for_path(GLib.build_filenamev([dir, suggestedName(m, media).replaceAll('/', '_')]));
    const promise = (async (): Promise<Gio.File> => {
      if (file.query_exists(null)) return file;
      const bytes = await this.#slot(() => this.#client.media(m.chatId, m.id));
      GLib.mkdir_with_parents(dir, 0o700);
      await file.replace_contents_bytes_async(bytes, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
      return file;
    })();
    promise.catch(() => this.#files.delete(key));
    this.#files.set(key, promise);
    return promise;
  }

  async #slot<T>(task: () => Promise<T>): Promise<T> {
    if (this.#running >= PARALLEL) {
      await new Promise<void>((resolve) => {
        this.#queue.push(resolve);
      });
    }
    this.#running += 1;
    try {
      return await task();
    } finally {
      this.#running -= 1;
      this.#queue.shift()?.();
    }
  }
}

/** Miniature base64 → texture, ou null si absente ou illisible. */
export function thumbnailTexture(media: Media): Gdk.Texture | null {
  if (media.thumbnail === null) return null;
  try {
    return Gdk.Texture.new_from_bytes(new GLib.Bytes(GLib.base64_decode(media.thumbnail)));
  } catch {
    return null;
  }
}

/** Extension de fichier d'un type MIME d'image courant. */
const EXT: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/wav': 'wav',
  'video/mp4': 'mp4',
  'video/3gpp': '3gp',
  'application/pdf': 'pdf',
};

/** Extension d'un type MIME (paramètres ignorés : `audio/ogg; codecs=opus`). */
export const extensionOf = (mimetype: string): string => EXT[mimetype.split(';')[0]?.trim() ?? ''] ?? 'bin';

/** Taille lisible (`1,2 Mo`). */
export function fmtSize(bytes: number | null): string {
  if (bytes === null) return '';
  if (bytes < 1024) return `${bytes} o`;
  const units = ['Ko', 'Mo', 'Go'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v < 10 ? 1 : 0).replace('.', ',')} ${units[i] ?? ''}`;
}

/** Durée `m:ss` (ou `h:mm:ss`). */
export function fmtDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** Nom de fichier proposé à l'enregistrement. */
export function suggestedName(m: Pick<Message, 'id' | 'timestamp'>, media: Media): string {
  if (media.fileName !== null && media.fileName !== '') return media.fileName;
  const date = GLib.DateTime.new_from_unix_local(m.timestamp)?.format('%Y-%m-%d_%H-%M-%S') ?? m.id;
  return `WhatsApp_${date}.${extensionOf(media.mimetype)}`;
}

/** Enregistrer sous… : contenu en mémoire (image) ou fichier du cache (autres médias). */
export async function save(parent: Gtk.Widget, name: string, content: GLib.Bytes | Gio.File, toast: (t: string) => void): Promise<void> {
  const dialog = new Gtk.FileDialog({ initialName: name, modal: true });
  const root = parent.get_root();
  try {
    const file = await dialog.save(root instanceof Gtk.Window ? root : null, null);
    if (file === null) return;
    // fichier du cache : relu puis réécrit (copy_async n'est pas utilisable tel quel depuis GJS)
    const bytes = content instanceof Gio.File ? (await content.load_bytes_async(null))[0] : content;
    await file.replace_contents_bytes_async(bytes, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
    toast(`Enregistré : ${file.get_basename() ?? name}`);
  } catch (error) {
    // annulation du sélecteur : pas d'erreur à signaler
    if (error instanceof GLib.Error && error.matches(Gtk.DialogError, Gtk.DialogError.DISMISSED)) return;
    toast(`Enregistrement impossible : ${errorMessage(error)}`);
  }
}

/** Ouvre un fichier avec l'application par défaut de son type. */
export async function openExternal(parent: Gtk.Widget, file: Gio.File, toast: (t: string) => void): Promise<void> {
  const root = parent.get_root();
  try {
    await new Gtk.FileLauncher({ file }).launch(root instanceof Gtk.Window ? root : null, null);
  } catch (error) {
    if (error instanceof GLib.Error && error.matches(Gtk.DialogError, Gtk.DialogError.DISMISSED)) return;
    toast(`Ouverture impossible : ${errorMessage(error)}`);
  }
}

/** Zoom maximal (multiple de la taille réelle). */
const MAX_ZOOM = 8;
/** Facteur de zoom par cran de molette. */
const ZOOM_STEP = 1.25;

/** Bouton flottant précédente / suivante. */
const navButton = (icon: string, tip: string, align: Gtk.Align): Gtk.Button =>
  new Gtk.Button({ iconName: icon, tooltipText: tip, halign: align, valign: Gtk.Align.CENTER, marginStart: 12, marginEnd: 12, cssClasses: ['osd', 'circular'], widthRequest: 40, heightRequest: 40 });

/** Photo de la visionneuse (message avec média). */
export type Photo = Message & { media: Media };

/**
 * Aperçu en grand (Échap pour fermer) : zoom à la molette centré sur le pointeur, déplacement en
 * glissant, double-clic ajustée / taille réelle ; photos précédente / suivante de la discussion.
 */
export function openViewer(parent: Gtk.Widget, title: string, photos: readonly Photo[], start: number, loader: MediaLoader, toast: (t: string) => void): void {
  let index = Math.max(0, Math.min(start, photos.length - 1));
  let loaded: Loaded | null = null;
  /** null : ajustée à la fenêtre ; sinon échelle par rapport à la taille réelle */
  let scale: number | null = null;
  const picture = new Gtk.Picture({ contentFit: Gtk.ContentFit.CONTAIN, canShrink: true, hexpand: true, vexpand: true, halign: Gtk.Align.FILL, valign: Gtk.Align.FILL });
  const scroller = new Gtk.ScrolledWindow({ child: picture, hscrollbarPolicy: Gtk.PolicyType.NEVER, vscrollbarPolicy: Gtk.PolicyType.NEVER, hexpand: true, vexpand: true });
  const hadj = scroller.get_hadjustment();
  const vadj = scroller.get_vadjustment();
  const spinner = new Adw.Spinner({ halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER, widthRequest: 32, heightRequest: 32, canTarget: false });
  const prev = navButton('go-previous-symbolic', 'Photo précédente', Gtk.Align.START);
  const next = navButton('go-next-symbolic', 'Photo suivante', Gtk.Align.END);
  const overlay = new Gtk.Overlay({ child: scroller });
  overlay.add_overlay(spinner);
  overlay.add_overlay(prev);
  overlay.add_overlay(next);
  const header = new Adw.HeaderBar();
  const saveButton = new Gtk.Button({ iconName: 'document-save-symbolic', tooltipText: 'Enregistrer sous…' });
  header.pack_start(saveButton);
  const zoomLabel = new Gtk.Button({ label: 'Ajustée', tooltipText: 'Ajuster à la fenêtre (0)', cssClasses: ['flat', 'numeric'] });
  header.pack_end(zoomLabel);
  const view = new Adw.ToolbarView({ content: overlay });
  view.add_top_bar(header);
  const caption = new Gtk.Label({ wrap: true, marginTop: 6, marginBottom: 12, marginStart: 12, marginEnd: 12, selectable: true, useMarkup: true });
  openLinks(caption);
  view.add_bottom_bar(caption);
  const root = parent.get_root();
  const [ww, wh] = root instanceof Gtk.Window ? [root.get_width(), root.get_height()] : [900, 700];
  const dialog = new Adw.Dialog({ title, child: view, contentWidth: Math.round(ww * 0.9), contentHeight: Math.round(wh * 0.9) });

  const size = (): [number, number] => (loaded === null ? [0, 0] : [loaded.texture.get_width(), loaded.texture.get_height()]);
  /** échelle de l'image ajustée à la fenêtre (jamais agrandie) */
  const fitScale = (): number => {
    const [iw, ih] = size();
    if (iw === 0 || ih === 0) return 1;
    return Math.min(1, scroller.get_width() / iw, scroller.get_height() / ih);
  };
  const current = (): number => scale ?? fitScale();
  /** position visée après le prochain calcul des tailles (zoom centré sur un point) */
  let pending: { fx: number; fy: number; x: number; y: number } | null = null;
  const applyPending = (): void => {
    if (pending === null) return;
    const [iw, ih] = size();
    const s = current();
    const offX = Math.max(0, (scroller.get_width() - iw * s) / 2);
    const offY = Math.max(0, (scroller.get_height() - ih * s) / 2);
    hadj.set_value(pending.fx * iw * s + offX - pending.x);
    vadj.set_value(pending.fy * ih * s + offY - pending.y);
  };
  hadj.connect('changed', applyPending);
  vadj.connect('changed', applyPending);
  const setScale = (wanted: number | null, x = scroller.get_width() / 2, y = scroller.get_height() / 2): void => {
    const [iw, ih] = size();
    if (iw === 0) return;
    const fit = fitScale();
    const target = wanted === null || wanted <= fit * 1.001 ? null : Math.min(MAX_ZOOM, wanted);
    // point de l'image sous le pointeur (fraction), gardé au même endroit
    const old = current();
    const offX = Math.max(0, (scroller.get_width() - iw * old) / 2);
    const offY = Math.max(0, (scroller.get_height() - ih * old) / 2);
    pending = target === null ? null : { fx: (hadj.get_value() + x - offX) / (iw * old), fy: (vadj.get_value() + y - offY) / (ih * old), x, y };
    scale = target;
    const zoomed = target !== null;
    picture.contentFit = zoomed ? Gtk.ContentFit.FILL : Gtk.ContentFit.CONTAIN;
    picture.set_size_request(zoomed ? Math.round(iw * target) : -1, zoomed ? Math.round(ih * target) : -1);
    picture.halign = zoomed ? Gtk.Align.CENTER : Gtk.Align.FILL;
    picture.valign = zoomed ? Gtk.Align.CENTER : Gtk.Align.FILL;
    picture.canShrink = !zoomed;
    const policy = zoomed ? Gtk.PolicyType.EXTERNAL : Gtk.PolicyType.NEVER;
    scroller.set_policy(policy, policy);
    scroller.set_cursor_from_name(zoomed ? 'grab' : null);
    zoomLabel.label = zoomed ? `${Math.round(target * 100)} %` : 'Ajustée';
    applyPending();
  };

  // molette : zoom centré sur le pointeur (pas de défilement)
  let pointer: [number, number] = [0, 0];
  const motion = new Gtk.EventControllerMotion();
  motion.connect('motion', (_c: Gtk.EventControllerMotion, x: number, y: number) => {
    pointer = [x, y];
  });
  scroller.add_controller(motion);
  const wheel = new Gtk.EventControllerScroll({ flags: Gtk.EventControllerScrollFlags.VERTICAL, propagationPhase: Gtk.PropagationPhase.CAPTURE });
  wheel.connect('scroll', (_c: Gtk.EventControllerScroll, _dx: number, dy: number) => {
    if (dy === 0) return true;
    setScale(current() * ZOOM_STEP ** -dy, ...pointer);
    return true;
  });
  scroller.add_controller(wheel);
  // glisser : déplacement dans l'image zoomée
  const drag = new Gtk.GestureDrag();
  let origin: [number, number] = [0, 0];
  drag.connect('drag-begin', () => {
    origin = [hadj.get_value(), vadj.get_value()];
    if (scale !== null) scroller.set_cursor_from_name('grabbing');
  });
  drag.connect('drag-update', (_g: Gtk.GestureDrag, dx: number, dy: number) => {
    if (scale === null) return;
    hadj.set_value(origin[0] - dx);
    vadj.set_value(origin[1] - dy);
  });
  drag.connect('drag-end', () => scroller.set_cursor_from_name(scale === null ? null : 'grab'));
  scroller.add_controller(drag);
  // double-clic : ajustée ↔ taille réelle (au point cliqué)
  const dbl = new Gtk.GestureClick();
  dbl.connect('pressed', (_g: Gtk.GestureClick, n: number, x: number, y: number) => {
    if (n === 2) setScale(scale === null ? Math.max(1, fitScale() * 2) : null, x, y);
  });
  scroller.add_controller(dbl);
  zoomLabel.connect('clicked', () => setScale(null));

  let generation = 0;
  const show = async (i: number): Promise<void> => {
    index = i;
    const photo = photos[i];
    if (photo === undefined) return;
    const mine = (generation += 1);
    prev.visible = i > 0;
    next.visible = i < photos.length - 1;
    dialog.title = photos.length > 1 ? `${title} — ${i + 1} / ${photos.length}` : title;
    caption.label = waMarkup(photo.text);
    caption.visible = photo.text !== '';
    saveButton.sensitive = false;
    // zoom remis à « ajustée » avant de changer d'image (setScale a besoin de sa taille)
    setScale(null);
    loaded = null;
    picture.paintable = thumbnailTexture(photo.media);
    spinner.visible = true;
    try {
      const l = await loader.load(photo);
      if (mine !== generation) return;
      loaded = l;
      picture.paintable = l.texture;
      saveButton.sensitive = true;
    } catch (error) {
      if (mine === generation) toast(`Image indisponible : ${errorMessage(error)}`);
    } finally {
      if (mine === generation) spinner.visible = false;
    }
    // voisines préchargées
    for (const n of [photos[i - 1], photos[i + 1]]) if (n !== undefined) loader.load(n).catch((error: unknown) => console.error(`préchargement : ${errorMessage(error)}`));
  };
  const go = (delta: number): void => {
    const i = index + delta;
    if (i >= 0 && i < photos.length && i !== index) void show(i);
  };
  prev.connect('clicked', () => go(-1));
  next.connect('clicked', () => go(1));
  const keys = new Gtk.EventControllerKey({ propagationPhase: Gtk.PropagationPhase.CAPTURE });
  keys.connect('key-pressed', (_c: Gtk.EventControllerKey, keyval: number) => {
    switch (keyval) {
      case Gdk.KEY_Left:
        go(-1);
        return true;
      case Gdk.KEY_Right:
        go(1);
        return true;
      case Gdk.KEY_plus:
      case Gdk.KEY_KP_Add:
      case Gdk.KEY_equal:
        setScale(current() * ZOOM_STEP);
        return true;
      case Gdk.KEY_minus:
      case Gdk.KEY_KP_Subtract:
        setScale(current() / ZOOM_STEP);
        return true;
      case Gdk.KEY_0:
      case Gdk.KEY_KP_0:
        setScale(null);
        return true;
      default:
        return false;
    }
  });
  dialog.add_controller(keys);
  saveButton.connect('clicked', () => {
    const photo = photos[index];
    if (photo !== undefined && loaded !== null) void save(parent, suggestedName(photo, photo.media), loaded.bytes, toast);
  });
  dialog.present(parent);
  void show(index);
}
