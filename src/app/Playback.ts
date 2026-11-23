// Lecture audio de l'application : un seul vocal à la fois (en lancer un autre arrête le
// précédent), qui continue quand on change de discussion. Les bulles et la barre du lecteur
// (`PlaybackBar`) ne sont que des vues de cet état.
import type Gio from 'gi://Gio';
import { type Accessor, createState, type Setter } from 'gnim';
import type { Message } from '../shared/api.ts';
import { AudioPlayer, type PlayerState, type Speed } from './AudioPlayer.ts';

/** Vocal chargé dans le lecteur. */
export interface Track {
  /** compte de la discussion */
  readonly account: string;
  readonly chatId: string;
  readonly messageId: string;
  readonly timestamp: number;
  /** auteur affiché (« Vous » pour les miens) */
  readonly author: string;
  readonly chatName: string;
  /** durée annoncée par le message (secondes), avant que le lecteur ne la connaisse */
  readonly seconds: number;
}

export interface PlaybackState extends PlayerState {
  readonly track: Track | null;
  readonly speed: Speed;
}

const IDLE: PlaybackState = { track: null, playing: false, position: 0, duration: 0, speed: 1 };

class Playback {
  readonly state: Accessor<PlaybackState>;
  readonly #set: Setter<PlaybackState>;
  #player: AudioPlayer | null = null;
  #speed: Speed = 1;

  constructor() {
    [this.state, this.#set] = createState<PlaybackState>(IDLE);
  }

  /** Vocal du message `id` chargé (en lecture ou en pause). */
  isCurrent(account: string, chatId: string, messageId: string): boolean {
    const t = this.state.peek().track;
    return t !== null && t.account === account && t.chatId === chatId && t.messageId === messageId;
  }

  /** Lance la lecture de `file` (le vocal précédent est arrêté). */
  play(track: Track, file: Gio.File, onError: (message: string) => void): void {
    this.stop();
    const player = new AudioPlayer(
      file.get_uri(),
      (st) => {
        if (this.#player === player) this.#set({ ...st, track, speed: this.#speed });
      },
      onError,
    );
    this.#player = player;
    if (this.#speed !== 1) player.setSpeed(this.#speed);
    this.#set({ track, playing: false, position: 0, duration: track.seconds, speed: this.#speed });
    player.play();
  }

  toggle(): void {
    this.#player?.toggle();
  }

  pause(): void {
    this.#player?.pause();
  }

  seek(seconds: number): void {
    this.#player?.seek(seconds);
  }

  /** Vitesse du lecteur (gardée pour les vocaux suivants). */
  setSpeed(speed: Speed): void {
    this.#speed = speed;
    this.#player?.setSpeed(speed);
    this.#set({ ...this.state.peek(), speed });
  }

  /** Arrêt : plus de vocal chargé (barre du lecteur cachée). */
  stop(): void {
    this.#player?.dispose();
    this.#player = null;
    this.#set({ ...IDLE, speed: this.#speed });
  }
}

/** Lecteur unique de l'application. */
export const playback = new Playback();

/** Piste d'un message vocal. */
export function trackOf(m: Message, chatName: string, account: string): Track {
  return {
    account,
    chatId: m.chatId,
    messageId: m.id,
    timestamp: m.timestamp,
    author: m.fromMe ? 'Vous' : (m.senderName ?? chatName),
    chatName,
    seconds: m.media?.seconds ?? 0,
  };
}
