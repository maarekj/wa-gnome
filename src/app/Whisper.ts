// Modèles de transcription (whisper.cpp) : emplacement, téléchargement suivi (une fois par
// modèle, annulable), suppression. Partagé par la fenêtre des préférences et la transcription.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';
import { createState } from 'gnim';
import { dataDir } from '../shared/client.ts';
import { errorMessage } from '../shared/errors.ts';
import type { WhisperModel } from './Preferences.ts';

Gio._promisify(Soup.Session.prototype, 'send_async', 'send_finish');
Gio._promisify(Gio.InputStream.prototype, 'read_bytes_async', 'read_bytes_finish');
Gio._promisify(Gio.OutputStream.prototype, 'write_bytes_async', 'write_bytes_finish');

/** Dossier des modèles (dossier de données de l'app). */
export const whisperDir = (): string => GLib.build_filenamev([dataDir(), 'whisper']);
export const whisperFile = (model: WhisperModel): string => GLib.build_filenamev([whisperDir(), `ggml-${model}.bin`]);
export const hasWhisper = (model: WhisperModel): boolean => GLib.file_test(whisperFile(model), GLib.FileTest.EXISTS);

/** Téléchargement en cours ou terminé en échec, par modèle. */
export type DownloadState = { readonly status: 'downloading'; readonly fraction: number } | { readonly status: 'error'; readonly error: string };

const [downloads, setDownloads] = createState<ReadonlyMap<WhisperModel, DownloadState>>(new Map());
/** États des téléchargements ; `models` change aussi à la fin (modèle présent ou supprimé). */
export { downloads };
const [models, setModels] = createState(0);
export { models };

const cancels = new Map<WhisperModel, Gio.Cancellable>();
const running = new Map<WhisperModel, Promise<void>>();

const setState = (model: WhisperModel, s: DownloadState | null): void => {
  const next = new Map(downloads.peek());
  if (s === null) next.delete(model);
  else next.set(model, s);
  setDownloads(next);
};

/** Télécharge le modèle (Hugging Face, dépôt de whisper.cpp) ; un seul téléchargement par modèle. */
export function downloadWhisper(model: WhisperModel): Promise<void> {
  const pending = running.get(model);
  if (pending !== undefined) return pending;
  const cancel = new Gio.Cancellable();
  cancels.set(model, cancel);
  setState(model, { status: 'downloading', fraction: 0 });
  const task = (async (): Promise<void> => {
    const partial = Gio.File.new_for_path(`${whisperFile(model)}.part`);
    try {
      GLib.mkdir_with_parents(whisperDir(), 0o700);
      const session = new Soup.Session({ timeout: 0 });
      const msg = Soup.Message.new('GET', `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${model}.bin`);
      if (msg === null) throw new Error('adresse du modèle invalide');
      const input = await session.send_async(msg, GLib.PRIORITY_DEFAULT, cancel);
      if (msg.get_status() !== Soup.Status.OK) throw new Error(`HTTP ${msg.get_status()}`);
      const total = msg.get_response_headers().get_content_length();
      const output = partial.replace(null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
      let done = 0;
      let shown = 0;
      try {
        for (;;) {
          // oxlint-disable-next-line no-await-in-loop -- lecture du flux par morceaux
          const chunk = await input.read_bytes_async(1 << 20, GLib.PRIORITY_DEFAULT, cancel);
          const size = chunk.get_size();
          if (size === 0) break;
          // écriture asynchrone : pas de saccade de l'interface (modèle de 1,5 Go)
          // oxlint-disable-next-line no-await-in-loop -- morceaux écrits dans l'ordre
          await output.write_bytes_async(chunk, GLib.PRIORITY_DEFAULT, cancel);
          done += size;
          // avancement publié par pas de 1 %
          if (total > 0 && done / total - shown >= 0.01) {
            shown = done / total;
            setState(model, { status: 'downloading', fraction: shown });
          }
        }
      } finally {
        output.close(null);
      }
      partial.move(Gio.File.new_for_path(whisperFile(model)), Gio.FileCopyFlags.OVERWRITE, null, null);
      setState(model, null);
    } catch (error) {
      try {
        partial.delete(null);
      } catch {
        // pas de fichier partiel
      }
      const cancelled = error instanceof GLib.Error && error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
      setState(model, cancelled ? null : { status: 'error', error: errorMessage(error) });
      throw cancelled ? new DownloadCancelled() : error;
    } finally {
      cancels.delete(model);
      running.delete(model);
      setModels(models.peek() + 1);
    }
  })();
  running.set(model, task);
  return task;
}

/** Téléchargement annulé par l'utilisateur (pas une erreur à signaler). */
export class DownloadCancelled extends Error {
  constructor() {
    super('téléchargement annulé');
  }
}

/** Annule le téléchargement en cours d'un modèle. */
export const cancelWhisper = (model: WhisperModel): void => cancels.get(model)?.cancel();

/** Supprime un modèle téléchargé (place libérée). */
export function deleteWhisper(model: WhisperModel): void {
  Gio.File.new_for_path(whisperFile(model)).delete(null);
  setModels(models.peek() + 1);
}
