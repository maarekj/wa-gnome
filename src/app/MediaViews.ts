// Documents, vocaux et vidéos dans les bulles : téléchargés à la demande dans le cache, puis
// ouverts par l'application par défaut (documents), lus sur place (vocaux) ou dans un aperçu (vidéos).
import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';
import type { Media, Message } from '../shared/api.ts';
import { errorMessage } from '../shared/errors.ts';
import { displaySize, extensionOf, fmtDuration, fmtSize, type MediaLoader, openExternal, save, suggestedName, thumbnailTexture } from './media.ts';
import { nextSpeed, speedLabel } from './AudioPlayer.ts';
import { playback, trackOf } from './Playback.ts';
import { MediaFrame } from './MediaFrame.ts';
import { waveformView } from './Waveform.ts';

export interface MediaContext {
  readonly loader: MediaLoader;
  readonly toast: (text: string) => void;
  readonly chatName: () => string;
  /** compte de la discussion (lecteur audio : retour au bon compte) */
  readonly account: string;
}

type MediaMessage = Message & { media: Media };

/** Bouton qui télécharge le média (spinner pendant ce temps) puis passe le fichier à `then`. */
function withFile(ctx: MediaContext, m: MediaMessage, button: Gtk.Button, then: (file: Gio.File) => void): void {
  const icon = button.iconName;
  button.sensitive = false;
  button.set_child(new Adw.Spinner());
  // bouton rendu avant `then` : celui-ci peut changer son icône (lecture : pause)
  const restore = (): void => {
    button.sensitive = true;
    button.iconName = icon;
  };
  ctx.loader
    .file(m, m.media)
    .then((file) => {
      restore();
      then(file);
      return file;
    })
    .catch((error: unknown) => {
      restore();
      ctx.toast(`Média indisponible : ${errorMessage(error)}`);
    });
}

// ---------------------------------------------------------------- documents

/** Document : icône du type, nom, taille ; ouvrir (application par défaut) ou enregistrer. */
export function DocumentView(ctx: MediaContext, m: MediaMessage): Gtk.Widget {
  const media = m.media;
  const name = media.fileName ?? suggestedName(m, media);
  const box = new Gtk.Box({ spacing: 10, cssClasses: ['document'], widthRequest: 260 });
  const icon = new Gtk.Image({
    gicon: Gio.content_type_get_symbolic_icon(Gio.content_type_from_mime_type(media.mimetype) ?? media.mimetype),
    pixelSize: 32,
    valign: Gtk.Align.CENTER,
  });
  box.append(icon);
  const text = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, hexpand: true, valign: Gtk.Align.CENTER });
  text.append(new Gtk.Label({ label: name, xalign: 0, ellipsize: Pango.EllipsizeMode.MIDDLE, maxWidthChars: 28, cssClasses: ['heading'] }));
  const details = [extensionOf(media.mimetype).toUpperCase(), fmtSize(media.size)].filter((d) => d !== '' && d !== 'BIN').join(' · ');
  text.append(new Gtk.Label({ label: details, xalign: 0, cssClasses: ['caption', 'dim-label'] }));
  box.append(text);
  const open = new Gtk.Button({ iconName: 'document-open-symbolic', tooltipText: 'Ouvrir', valign: Gtk.Align.CENTER, cssClasses: ['flat', 'circular'] });
  open.connect('clicked', () => withFile(ctx, m, open, (file) => void openExternal(open, file, ctx.toast)));
  const saveButton = new Gtk.Button({
    iconName: 'document-save-symbolic',
    tooltipText: 'Enregistrer sous…',
    valign: Gtk.Align.CENTER,
    cssClasses: ['flat', 'circular'],
  });
  saveButton.connect('clicked', () => withFile(ctx, m, saveButton, (file) => void save(saveButton, name, file, ctx.toast)));
  box.append(open);
  box.append(saveButton);
  return box;
}

// ---------------------------------------------------------------- vocaux et audio

/**
 * Lecteur audio dans la bulle : lecture / pause, position (glissable), durée, vitesse ×1 / ×1,5 / ×2.
 * Vue du lecteur de l'application (`playback`) : un seul vocal à la fois, qui continue hors de
 * la discussion.
 */
export function AudioView(ctx: MediaContext, m: MediaMessage): Gtk.Widget {
  const box = new Gtk.Box({ spacing: 8, cssClasses: ['audio'], widthRequest: 280 });
  const play = new Gtk.Button({ iconName: 'media-playback-start-symbolic', tooltipText: 'Lire', valign: Gtk.Align.CENTER, cssClasses: ['circular'] });
  const scale = new Gtk.Scale({
    orientation: Gtk.Orientation.HORIZONTAL,
    hexpand: true,
    drawValue: false,
    sensitive: false,
    adjustment: new Gtk.Adjustment({ lower: 0, upper: Math.max(1, m.media.seconds ?? 1), stepIncrement: 1 }),
  });
  const time = new Gtk.Label({ label: fmtDuration(m.media.seconds ?? 0), widthChars: 5, xalign: 1, cssClasses: ['caption', 'dim-label', 'numeric'] });
  const speed = new Gtk.Button({
    label: speedLabel(playback.state.peek().speed),
    tooltipText: 'Vitesse de lecture',
    valign: Gtk.Align.CENTER,
    cssClasses: ['flat', 'pill', 'speed', 'caption-heading'],
  });
  box.append(play);
  const current = (): boolean => playback.isCurrent(ctx.account, m.chatId, m.id);
  // vocal avec forme d'onde : barres à la place de la barre de progression (comme WhatsApp)
  const wave =
    m.media.waveform === null || m.media.waveform === undefined || m.media.waveform.length === 0
      ? null
      : waveformView(m.media.waveform, (fraction) => {
          if (current()) scale.set_value(fraction * scale.adjustment.upper);
        });
  box.append(wave?.widget ?? scale);
  box.append(time);
  box.append(speed);
  /** position mise à jour par le lecteur (pas un glissement de l'utilisateur) */
  let syncing = false;
  /** affichage précédent : une bulle qui ne joue pas n'est redessinée qu'à un changement */
  let shown: { mine: boolean; speed: number } | null = null;
  const show = (): void => {
    const st = playback.state.peek();
    const mine = current();
    if (!mine && shown !== null && !shown.mine && shown.speed === st.speed) return;
    shown = { mine, speed: st.speed };
    const position = mine ? st.position : 0;
    if (mine && st.duration > 0) scale.adjustment.upper = st.duration;
    syncing = true;
    scale.set_value(position);
    syncing = false;
    scale.sensitive = mine;
    if (wave !== null) {
      wave.widget.sensitive = mine;
      wave.setProgress(scale.adjustment.upper > 0 ? position / scale.adjustment.upper : 0);
    }
    const playing = mine && st.playing;
    time.label = fmtDuration(mine && (st.playing || st.position > 0) ? st.position : (m.media.seconds ?? st.duration));
    play.iconName = playing ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
    play.tooltipText = playing ? 'Pause' : 'Lire';
    speed.label = speedLabel(st.speed);
  };
  // abonnée tant qu'elle est à l'écran (retirée : désabonnée, la lecture continue) ; le lecteur
  // global ne retient donc pas les bulles des discussions fermées
  let off: (() => void) | null = null;
  box.connect('realize', () => {
    shown = null;
    show();
    off ??= playback.state.subscribe(show);
  });
  box.connect('unrealize', () => {
    off?.();
    off = null;
  });
  scale.connect('value-changed', () => {
    if (!syncing && current()) playback.seek(scale.get_value());
  });
  speed.connect('clicked', () => playback.setSpeed(nextSpeed(playback.state.peek().speed)));
  play.connect('clicked', () => {
    if (current()) {
      playback.toggle();
      return;
    }
    withFile(ctx, m, play, (file) => {
      try {
        playback.play(trackOf(m, ctx.chatName(), ctx.account), file, (message) => ctx.toast(`Lecture impossible : ${message}`));
      } catch (error) {
        ctx.toast(errorMessage(error));
      }
    });
  });
  return box;
}

// ---------------------------------------------------------------- vidéos

/** Vidéo : miniature avec bouton de lecture et durée ; clic : lecture dans un aperçu. */
export function VideoView(ctx: MediaContext, m: MediaMessage): Gtk.Widget {
  const [w, h] = displaySize(m.media.width, m.media.height, 300);
  const frame = new MediaFrame({ cssClasses: ['message-media'] });
  frame.setup(w, h, 'cover', 8);
  frame.setPaintable(thumbnailTexture(m.media));
  const overlay = new Gtk.Overlay({ child: frame, tooltipText: 'Lire la vidéo', halign: Gtk.Align.START });
  const play = new Gtk.Image({
    iconName: 'media-playback-start-symbolic',
    pixelSize: 24,
    halign: Gtk.Align.CENTER,
    valign: Gtk.Align.CENTER,
    cssClasses: ['video-play'],
  });
  overlay.add_overlay(play);
  if (m.media.seconds !== null)
    overlay.add_overlay(
      new Gtk.Label({
        label: fmtDuration(m.media.seconds),
        halign: Gtk.Align.START,
        valign: Gtk.Align.END,
        marginStart: 8,
        marginBottom: 6,
        cssClasses: ['video-duration', 'caption'],
      }),
    );
  overlay.set_cursor_from_name('pointer');
  const click = new Gtk.GestureClick();
  click.connect('released', () => {
    play.visible = false;
    const spinner = new Adw.Spinner({ halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER, widthRequest: 32, heightRequest: 32 });
    overlay.add_overlay(spinner);
    ctx.loader
      .file(m, m.media)
      .then((file) => openVideo(overlay, ctx, m, file))
      .catch((error: unknown) => ctx.toast(`Vidéo indisponible : ${errorMessage(error)}`))
      .finally(() => {
        overlay.remove_overlay(spinner);
        play.visible = true;
      });
  });
  overlay.add_controller(click);
  return overlay;
}

/** Aperçu de lecture : Gtk.Video (lecture immédiate), ouverture externe et enregistrement. */
export function openVideo(parent: Gtk.Widget, ctx: MediaContext, m: MediaMessage, file: Gio.File): void {
  const video = new Gtk.Video({ file, autoplay: true, hexpand: true, vexpand: true });
  const header = new Adw.HeaderBar();
  const external = new Gtk.Button({ iconName: 'document-open-symbolic', tooltipText: 'Ouvrir avec l’application par défaut' });
  external.connect('clicked', () => void openExternal(parent, file, ctx.toast));
  const saveButton = new Gtk.Button({ iconName: 'document-save-symbolic', tooltipText: 'Enregistrer sous…' });
  saveButton.connect('clicked', () => void save(parent, suggestedName(m, m.media), file, ctx.toast));
  header.pack_start(saveButton);
  header.pack_start(external);
  const view = new Adw.ToolbarView({ content: video });
  view.add_top_bar(header);
  if (m.text !== '') view.add_bottom_bar(new Gtk.Label({ label: m.text, wrap: true, marginTop: 6, marginBottom: 12, marginStart: 12, marginEnd: 12 }));
  const root = parent.get_root();
  const [ww, wh] = root instanceof Gtk.Window ? [root.get_width(), root.get_height()] : [900, 700];
  const dialog = new Adw.Dialog({ title: ctx.chatName(), child: view, contentWidth: Math.round(ww * 0.9), contentHeight: Math.round(wh * 0.9) });
  // fermeture : lecture arrêtée
  dialog.connect('closed', () => {
    video.get_media_stream()?.pause();
    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      video.set_file(null);
      return GLib.SOURCE_REMOVE;
    });
  });
  dialog.present(parent);
}
