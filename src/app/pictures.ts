// Photos de profil dans l'app : une texture réactive par discussion, chargée à la première
// demande (quelques requêtes à la fois, dans l'ordre d'affichage), rechargée si elle change.
import type Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import { createState, onCleanup, type Accessor, type Setter } from 'gnim';
import type { WaClient } from '../shared/client.ts';
import { errorMessage } from '../shared/errors.ts';

/** Chargements simultanés au plus (le démon interroge WhatsApp pour chaque photo absente du cache). */
const PARALLEL = 4;

interface Entry {
  readonly texture: Accessor<Gdk.Texture | null>;
  readonly set: Setter<Gdk.Texture | null>;
}

export class Pictures {
  readonly #client: WaClient;
  readonly #entries = new Map<string, Entry>();
  readonly #queue: string[] = [];
  #running = 0;

  constructor(client: WaClient) {
    this.#client = client;
  }

  /** Photo d'une discussion (null : pas de photo, ou pas encore chargée). */
  texture(id: string): Accessor<Gdk.Texture | null> {
    let entry = this.#entries.get(id);
    if (entry === undefined) {
      const [texture, set] = createState<Gdk.Texture | null>(null);
      entry = { texture, set };
      this.#entries.set(id, entry);
      this.#enqueue(id);
    }
    return entry.texture;
  }

  /** Photo changée ou retirée : rechargée si elle est affichée. */
  invalidate(id: string): void {
    if (this.#entries.has(id)) this.#enqueue(id);
  }

  #enqueue(id: string): void {
    if (!this.#queue.includes(id)) this.#queue.push(id);
    this.#pump();
  }

  #pump(): void {
    while (this.#running < PARALLEL) {
      const id = this.#queue.shift();
      if (id === undefined) return;
      this.#running += 1;
      void this.#load(id).finally(() => {
        this.#running -= 1;
        this.#pump();
      });
    }
  }

  async #load(id: string): Promise<void> {
    try {
      const bytes = await this.#client.picture(id);
      this.#entries.get(id)?.set(bytes === null ? null : Gdk.Texture.new_from_bytes(bytes));
    } catch (error) {
      // photo indisponible (démon déconnecté…) : initiales gardées, nouvel essai au prochain lancement
      console.error(`photo ${id} : ${errorMessage(error)}`);
    }
  }
}

/** Photo suivie par un avatar (la propriété n'accepte pas de liaison nullable). */
export function bindAvatar(avatar: Adw.Avatar, texture: Accessor<Gdk.Texture | null>): void {
  const apply = (): void => avatar.set_custom_image(texture.peek());
  apply();
  onCleanup(texture.subscribe(apply));
}
