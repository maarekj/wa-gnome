// Photos de profil (personnes, groupes) : demandées à WhatsApp à la demande, gardées sur disque.
// `<hash>.jpg` : photo ; `<hash>.none` : pas de photo (ou masquée par la confidentialité). La date
// du fichier sert de date de récupération : relu après PICTURE_TTL.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Durée de validité d'une photo (ou de son absence) en cache. */
export const PICTURE_TTL = 3 * 24 * 3600 * 1000;
/** Requêtes simultanées vers WhatsApp au plus (la liste demande des centaines de photos). */
const PARALLEL = 4;
/** Après un échec (WhatsApp ne répond pas pour certains groupes) : pas de nouvel essai avant ce délai. */
const RETRY_MS = 3600 * 1000;

/** Erreur de WhatsApp signifiant « pas de photo » (absente, ou masquée par la confidentialité). */
export const isNoPicture = (e: unknown): boolean => {
  // réponse de WhatsApp (« item-not-found », « not-authorized ») ou code HTTP de l'erreur Boom
  if (e instanceof Error && /^(item-not-found|not-authorized|forbidden)$/u.test(e.message)) return true;
  if (typeof e !== 'object' || e === null || !('output' in e)) return false;
  const { output } = e;
  if (typeof output !== 'object' || output === null || !('statusCode' in output)) return false;
  return output.statusCode === 404 || output.statusCode === 401 || output.statusCode === 403;
};

/** Téléchargement d'une photo au plus (une requête bloquée occuperait sa place dans la file). */
const FETCH_TIMEOUT_MS = 15_000;

export class Pictures {
  readonly #dir: string;
  /** adresse de la photo (aperçu) d'un identifiant, undefined si aucune ; rejette sur erreur */
  readonly #url: (jid: string) => Promise<string | undefined>;
  readonly #pending = new Map<string, Promise<Buffer | null>>();
  readonly #queue: (() => void)[] = [];
  /** échecs récents (en mémoire seulement) : identifiant → date */
  readonly #failed = new Map<string, number>();
  #running = 0;

  constructor(dir: string, url: (jid: string) => Promise<string | undefined>) {
    this.#dir = dir;
    this.#url = url;
  }

  #file(jid: string, ext: 'jpg' | 'none'): string {
    return path.join(this.#dir, `${createHash('sha256').update(jid).digest('hex').slice(0, 32)}.${ext}`);
  }

  /** Photo d'un identifiant, ou null s'il n'en a pas. */
  get(jid: string, now = Date.now()): Promise<Buffer | null> {
    for (const ext of ['jpg', 'none'] as const) {
      try {
        const stat = fs.statSync(this.#file(jid, ext));
        if (now - stat.mtimeMs < PICTURE_TTL) return Promise.resolve(ext === 'jpg' ? fs.readFileSync(this.#file(jid, ext)) : null);
      } catch {
        // absent : récupéré ci-dessous
      }
    }
    // échec récent : sans photo pour l'instant, sans bloquer la file une nouvelle fois
    if (now - (this.#failed.get(jid) ?? 0) < RETRY_MS) return Promise.resolve(null);
    const pending = this.#pending.get(jid);
    if (pending !== undefined) return pending;
    const promise = this.#fetch(jid).finally(() => {
      this.#pending.delete(jid);
    });
    this.#pending.set(jid, promise);
    return promise;
  }

  /** Photo changée ou retirée : relue à la prochaine demande. */
  invalidate(jid: string): void {
    this.#failed.delete(jid);
    for (const ext of ['jpg', 'none'] as const) fs.rmSync(this.#file(jid, ext), { force: true });
  }

  clear(): void {
    fs.rmSync(this.#dir, { recursive: true, force: true });
  }

  async #fetch(jid: string): Promise<Buffer | null> {
    await this.#slot();
    try {
      let url: string | undefined;
      try {
        url = await this.#url(jid);
      } catch (error) {
        if (!isNoPicture(error)) throw error;
      }
      fs.mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
      if (url === undefined) {
        this.invalidate(jid);
        fs.writeFileSync(this.#file(jid, 'none'), '');
        return null;
      }
      const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`photo : HTTP ${res.status}`);
      const data = Buffer.from(await res.arrayBuffer());
      this.#failed.delete(jid);
      this.invalidate(jid);
      fs.writeFileSync(this.#file(jid, 'jpg'), data, { mode: 0o600 });
      return data;
    } catch (error) {
      this.#failed.set(jid, Date.now());
      throw error;
    } finally {
      this.#running -= 1;
      this.#queue.shift()?.();
    }
  }

  async #slot(): Promise<void> {
    if (this.#running >= PARALLEL) {
      await new Promise<void>((resolve) => {
        this.#queue.push(resolve);
      });
    }
    this.#running += 1;
  }
}
