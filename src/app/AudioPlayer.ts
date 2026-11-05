// Lecteur audio GStreamer (playbin) : Gtk.MediaFile ne permet pas de changer la vitesse.
// `scaletempo` garde la hauteur de la voix en x1,5 / x2, comme dans WhatsApp.
import GLib from 'gi://GLib';
import Gst from 'gi://Gst?version=1.0';

/** Vitesses proposées, dans l'ordre du bouton. */
export const SPEEDS = [1, 1.5, 2] as const;
export type Speed = (typeof SPEEDS)[number];

/** Vitesse suivante (x1 → x1,5 → x2 → x1). */
export const nextSpeed = (s: Speed): Speed => SPEEDS[(SPEEDS.indexOf(s) + 1) % SPEEDS.length] ?? 1;

/** Libellé du bouton (`×1,5`). */
export const speedLabel = (s: Speed): string => `×${String(s).replace('.', ',')}`;

let initialized = false;
/** Nanosecondes par seconde (Gst.SECOND, typé bigint par les déclarations). */
const NS = 1_000_000_000;

export interface PlayerState {
  playing: boolean;
  /** secondes */
  position: number;
  /** secondes, 0 tant qu'inconnue */
  duration: number;
}

export class AudioPlayer {
  readonly #bin: Gst.Element;
  readonly #onState: (s: PlayerState) => void;
  readonly #onError: (message: string) => void;
  #speed: Speed = 1;
  #playing = false;
  #tick = 0;
  #bus = 0;

  constructor(uri: string, onState: (s: PlayerState) => void, onError: (message: string) => void) {
    if (!initialized) {
      Gst.init([]);
      initialized = true;
    }
    this.#onState = onState;
    this.#onError = onError;
    const bin = Gst.ElementFactory.make('playbin', null);
    if (bin === null) throw new Error('GStreamer : playbin indisponible');
    bin.set_property('uri', uri);
    // pas de vidéo ; hauteur de voix conservée quand la vitesse change
    bin.set_property('flags', 0x02 | 0x10);
    const tempo = Gst.ElementFactory.make('scaletempo', null);
    if (tempo !== null) bin.set_property('audio-filter', tempo);
    this.#bin = bin;
    const bus = bin.get_bus();
    if (bus !== null) {
      bus.add_signal_watch();
      this.#bus = bus.connect('message', (_b: Gst.Bus, msg: Gst.Message) => this.#message(msg));
    }
  }

  get speed(): Speed {
    return this.#speed;
  }

  get playing(): boolean {
    return this.#playing;
  }

  #message(msg: Gst.Message): void {
    if (msg.type === Gst.MessageType.EOS) {
      // fin : retour au début, en pause
      this.#playing = false;
      this.#bin.set_state(Gst.State.PAUSED);
      this.#seek(0);
      this.#stopTick();
      this.#emit();
    } else if (msg.type === Gst.MessageType.ERROR) {
      const [error] = msg.parse_error();
      this.#onError(error?.message ?? 'erreur GStreamer');
      this.pause();
    } else if (msg.type === Gst.MessageType.ASYNC_DONE) {
      // pipeline prêt (après lecture ou déplacement) : durée connue
      this.#emit();
    }
  }

  #position(): number {
    const [ok, pos] = this.#bin.query_position(Gst.Format.TIME);
    return ok ? pos / NS : 0;
  }

  #duration(): number {
    const [ok, d] = this.#bin.query_duration(Gst.Format.TIME);
    return ok && d > 0 ? d / NS : 0;
  }

  #seek(seconds: number): void {
    this.#bin.seek(this.#speed, Gst.Format.TIME, Gst.SeekFlags.FLUSH | Gst.SeekFlags.ACCURATE, Gst.SeekType.SET, Math.round(seconds * NS), Gst.SeekType.NONE, -1);
  }

  #emit(): void {
    this.#onState({ playing: this.#playing, position: this.#position(), duration: this.#duration() });
  }

  #startTick(): void {
    if (this.#tick !== 0) return;
    this.#tick = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
      this.#emit();
      return GLib.SOURCE_CONTINUE;
    });
  }

  #stopTick(): void {
    if (this.#tick !== 0) GLib.source_remove(this.#tick);
    this.#tick = 0;
  }

  play(): void {
    this.#playing = true;
    this.#bin.set_state(Gst.State.PLAYING);
    this.#startTick();
    this.#emit();
  }

  pause(): void {
    this.#playing = false;
    this.#bin.set_state(Gst.State.PAUSED);
    this.#stopTick();
    this.#emit();
  }

  toggle(): void {
    if (this.#playing) this.pause();
    else this.play();
  }

  seek(seconds: number): void {
    this.#seek(seconds);
  }

  setSpeed(speed: Speed): void {
    this.#speed = speed;
    // nouvelle vitesse depuis la position courante
    this.#seek(this.#position());
  }

  dispose(): void {
    this.#stopTick();
    const bus = this.#bin.get_bus();
    if (bus !== null && this.#bus !== 0) {
      bus.disconnect(this.#bus);
      bus.remove_signal_watch();
    }
    this.#bin.set_state(Gst.State.NULL);
  }
}
