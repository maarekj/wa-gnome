// Pièces jointes de la zone de saisie : choisies (sélecteur), glissées-déposées ou collées
// (fichiers ou image du presse-papier), montrées au-dessus de la saisie avant l'envoi.
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';
import { MAX_UPLOAD } from '../shared/api.ts';
import { errorMessage } from '../shared/errors.ts';
import { fmtSize } from './media.ts';
import { MediaFrame } from './MediaFrame.ts';

Gio._promisify(Gtk.FileDialog.prototype, 'open_multiple', 'open_multiple_finish');
Gio._promisify(Gio.File.prototype, 'load_bytes_async', 'load_bytes_finish');
Gio._promisify(Gio.File.prototype, 'query_info_async', 'query_info_finish');
Gio._promisify(Gdk.Clipboard.prototype, 'read_texture_async', 'read_texture_finish');
Gio._promisify(Gdk.Clipboard.prototype, 'read_value_async', 'read_value_finish');

export interface Attachment {
  readonly id: number;
  readonly name: string;
  readonly mimetype: string;
  readonly bytes: GLib.Bytes;
  /** aperçu (images) */
  readonly texture: Gdk.Texture | null;
}

let counter = 0;

/** Texture d'une image (aperçu), null si ce n'en est pas une ou si elle est illisible. */
function preview(mimetype: string, bytes: GLib.Bytes): Gdk.Texture | null {
  if (!mimetype.startsWith('image/')) return null;
  try {
    return Gdk.Texture.new_from_bytes(bytes);
  } catch {
    return null;
  }
}

/** Fichier lu en pièce jointe ; refusé s'il dépasse la limite d'envoi. */
export async function fromFile(file: Gio.File): Promise<Attachment> {
  const info = await file.query_info_async('standard::content-type,standard::display-name,standard::size', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, null);
  if (info.get_size() > MAX_UPLOAD) throw new Error(`${info.get_display_name()} : ${fmtSize(info.get_size())}, ${fmtSize(MAX_UPLOAD)} au plus`);
  const [bytes] = await file.load_bytes_async(null);
  const mimetype = Gio.content_type_get_mime_type(info.get_content_type() ?? '') ?? 'application/octet-stream';
  counter += 1;
  return { id: counter, name: info.get_display_name(), mimetype, bytes, texture: preview(mimetype, bytes) };
}

/** Image collée (capture d'écran…) : envoyée en PNG. */
export function fromTexture(texture: Gdk.Texture): Attachment {
  counter += 1;
  const date = GLib.DateTime.new_now_local().format('%Y-%m-%d_%H-%M-%S') ?? 'image';
  return { id: counter, name: `Image_${date}.png`, mimetype: 'image/png', bytes: texture.save_to_png_bytes(), texture };
}

/** Sélecteur de fichiers (plusieurs à la fois). */
export async function pickFiles(parent: Gtk.Widget): Promise<Gio.File[]> {
  const root = parent.get_root();
  const dialog = new Gtk.FileDialog({ title: 'Joindre des fichiers', modal: true });
  try {
    const list = await dialog.open_multiple(root instanceof Gtk.Window ? root : null, null);
    const files: Gio.File[] = [];
    for (let i = 0; i < (list?.get_n_items() ?? 0); i += 1) {
      const f = list?.get_item(i);
      if (f instanceof Gio.File) files.push(f);
    }
    return files;
  } catch (error) {
    if (error instanceof GLib.Error && error.matches(Gtk.DialogError, Gtk.DialogError.DISMISSED)) return [];
    throw error;
  }
}

/**
 * Collage dans la saisie : fichiers copiés (gestionnaire de fichiers) ou image ; true si le
 * presse-papier contenait l'un ou l'autre (le texte est alors laissé au collage normal).
 */
export function pasteAttachments(widget: Gtk.Widget, add: (files: Gio.File[], textures: Gdk.Texture[]) => void, toast: (t: string) => void): boolean {
  const clipboard = widget.get_clipboard();
  const formats = clipboard.get_formats();
  const files = formats.contain_gtype(Gdk.FileList.$gtype);
  if (!files && !formats.contain_gtype(Gdk.Texture.$gtype)) return false;
  const read = async (): Promise<void> => {
    try {
      if (files) {
        const value: unknown = await clipboard.read_value_async(Gdk.FileList.$gtype, GLib.PRIORITY_DEFAULT, null);
        if (value instanceof Gdk.FileList) add(value.get_files(), []);
      } else {
        const texture = await clipboard.read_texture_async(null);
        if (texture !== null) add([], [texture]);
      }
    } catch (error) {
      toast(`Collage impossible : ${errorMessage(error)}`);
    }
  };
  void read();
  return true;
}

/**
 * Fichiers déposés n'importe où dans `widget` (glisser-déposer depuis le gestionnaire de
 * fichiers). Phase de capture : le dépôt est pris avant les widgets enfants (la zone de saisie
 * collerait sinon le chemin du fichier comme du texte).
 */
export function attachDrop(widget: Gtk.Widget, add: (files: Gio.File[]) => void): void {
  const drop = new Gtk.DropTarget({ actions: Gdk.DragAction.COPY, propagationPhase: Gtk.PropagationPhase.CAPTURE });
  drop.set_gtypes([Gdk.FileList.$gtype, Gio.File.$gtype]);
  drop.connect('drop', (_d: Gtk.DropTarget, value: unknown) => {
    if (value instanceof Gdk.FileList) add(value.get_files());
    else if (value instanceof Gio.File) add([value]);
    else return false;
    return true;
  });
  drop.connect('enter', () => {
    widget.add_css_class('drop-target');
    return Gdk.DragAction.COPY;
  });
  drop.connect('leave', () => widget.remove_css_class('drop-target'));
  drop.connect('notify::current-drop', () => {
    if (drop.currentDrop === null) widget.remove_css_class('drop-target');
  });
  widget.add_controller(drop);
}

/** Vignette d'une pièce jointe : aperçu ou icône, nom, bouton de retrait. */
export function attachmentChip(a: Attachment, remove: () => void): Gtk.Widget {
  const box = new Gtk.Box({ spacing: 6, cssClasses: ['attachment'], tooltipText: `${a.name} · ${fmtSize(a.bytes.get_size())}` });
  if (a.texture === null) {
    box.append(new Gtk.Image({ gicon: Gio.content_type_get_symbolic_icon(Gio.content_type_from_mime_type(a.mimetype) ?? a.mimetype), pixelSize: 24 }));
  } else {
    // Gtk.Picture prendrait la taille de l'image : cadre fixe recadré
    const pic = new MediaFrame({ valign: Gtk.Align.CENTER });
    pic.setup(40, 40, 'cover', 6);
    pic.setPaintable(a.texture);
    box.append(pic);
  }
  box.append(new Gtk.Label({ label: a.name, ellipsize: Pango.EllipsizeMode.MIDDLE, maxWidthChars: 18 }));
  const close = new Gtk.Button({ iconName: 'window-close-symbolic', tooltipText: 'Retirer', valign: Gtk.Align.CENTER, cssClasses: ['flat', 'circular'] });
  close.connect('clicked', remove);
  box.append(close);
  return box;
}
