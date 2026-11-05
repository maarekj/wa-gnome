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

/** Aperçu en grand (Échap ou clic hors de l'image pour fermer), avec enregistrement. */
export function openViewer(parent: Gtk.Widget, title: string, m: Message, media: Media, loaded: Loaded, toast: (t: string) => void): void {
  const picture = new Gtk.Picture({ paintable: loaded.texture, contentFit: Gtk.ContentFit.CONTAIN, canShrink: true, hexpand: true, vexpand: true });
  const header = new Adw.HeaderBar();
  const saveButton = new Gtk.Button({ iconName: 'document-save-symbolic', tooltipText: 'Enregistrer sous…' });
  header.pack_start(saveButton);
  const view = new Adw.ToolbarView({ content: picture });
  view.add_top_bar(header);
  const caption = m.text === '' ? null : new Gtk.Label({ label: m.text, wrap: true, marginTop: 6, marginBottom: 12, marginStart: 12, marginEnd: 12 });
  if (caption !== null) view.add_bottom_bar(caption);
  const root = parent.get_root();
  const [ww, wh] = root instanceof Gtk.Window ? [root.get_width(), root.get_height()] : [900, 700];
  const dialog = new Adw.Dialog({ title, child: view, contentWidth: Math.round(ww * 0.9), contentHeight: Math.round(wh * 0.9) });
  saveButton.connect('clicked', () => {
    void save(parent, suggestedName(m, media), loaded.bytes, toast);
  });
  dialog.present(parent);
}
