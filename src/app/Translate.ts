// Traduction des messages par la CLI de l'utilisateur (Claude Code ou opencode, avec ses
// identifiants) et transcription locale des vocaux (whisper.cpp). Résultats gardés en mémoire
// par message, affichés sous la bulle.
// Tests (WA_GNOME_TEST_TRANSLATE) : traduction et transcription simulées, aucun programme lancé.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gst from 'gi://Gst?version=1.0';
import { createState } from 'gnim';
import * as z from 'zod/mini';
import type { Message } from '../shared/api.ts';
import { errorMessage } from '../shared/errors.ts';
import { settings, VOICE_LANGUAGES, WHISPER_MODELS, type WhisperModel } from './Preferences.ts';
import { downloadWhisper, whisperFile } from './Whisper.ts';

export { VOICE_LANGUAGES };

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async', 'communicate_utf8_finish');

/** État de la traduction ou de la transcription d'un message. */
export interface Translation {
  readonly status: 'transcribing' | 'translating' | 'done' | 'error';
  /** transcription d'un vocal, et sa langue (code de whisper) */
  readonly transcript?: string;
  readonly spoken?: string | null;
  /** texte traduit ; vide : déjà dans la langue cible */
  readonly text?: string;
  /** langue d'origine (« anglais »), si connue */
  readonly from?: string | null;
  readonly error?: string;
}

const keyOf = (m: Pick<Message, 'chatId' | 'id'>): string => `${m.chatId}/${m.id}`;
const [translations, setTranslations] = createState<ReadonlyMap<string, Translation>>(new Map());
export { translations };

const put = (key: string, t: Translation | null): void => {
  const next = new Map(translations.peek());
  if (t === null) next.delete(key);
  else next.set(key, t);
  setTranslations(next);
};

/** Traduction affichée sous un message, ou undefined. */
export const translationOf = (m: Pick<Message, 'chatId' | 'id'>): Translation | undefined => translations.peek().get(keyOf(m));
export const hideTranslation = (m: Pick<Message, 'chatId' | 'id'>): void => put(keyOf(m), null);

// ---------------------------------------------------------------- traduction

/** Consigne envoyée à l'outil de traduction. */
export function translatePrompt(text: string, target: string): string {
  return [
    `Traduis en ${target} le message WhatsApp placé entre les balises <message>.`,
    'Réponds uniquement par un objet JSON sur une seule ligne, sans bloc de code :',
    '{"langue": "<langue d’origine, nommée en français, en minuscules>", "traduction": "<texte traduit>"}',
    `Si le message est déjà en ${target}, mets une traduction vide ("").`,
    'Garde la mise en forme WhatsApp (*gras*, _italique_), les émojis, les liens et les retours à la ligne.',
    '<message>',
    text,
    '</message>',
  ].join('\n');
}

const Answer = z.object({ langue: z.optional(z.nullable(z.string())), traduction: z.string() });

/** Réponse de l'outil : langue d'origine et traduction (texte brut si ce n'est pas du JSON). */
export function parseAnswer(out: string): { from: string | null; text: string } {
  const start = out.indexOf('{');
  const end = out.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      const parsed = Answer.safeParse(JSON.parse(out.slice(start, end + 1)));
      if (parsed.success) {
        const from = parsed.data.langue?.trim() ?? '';
        return { from: from === '' ? null : from, text: parsed.data.traduction.trim() };
      }
    } catch {
      // pas du JSON : réponse prise telle quelle
    }
  }
  return { from: null, text: out.trim() };
}

/** Texte de la réponse d'opencode (`--format json` : un événement JSON par ligne). */
export function opencodeText(out: string): string {
  const parts: string[] = [];
  for (const line of out.split('\n')) {
    try {
      const e: unknown = JSON.parse(line);
      if (typeof e !== 'object' || e === null || !('type' in e) || e.type !== 'text' || !('part' in e)) continue;
      const part: unknown = e.part;
      if (typeof part === 'object' && part !== null && 'text' in part && typeof part.text === 'string') parts.push(part.text);
    } catch {
      // ligne de journal : ignorée
    }
  }
  return parts.join('');
}

/** Programme de l'utilisateur : PATH, sinon emplacements habituels (lancement depuis le bureau). */
function program(name: string): string {
  const found = GLib.find_program_in_path(name);
  if (found !== null) return found;
  const home = GLib.get_home_dir();
  for (const dir of [`${home}/.local/bin`, `${home}/.nix-profile/bin`, `/etc/profiles/per-user/${GLib.get_user_name()}/bin`, '/run/current-system/sw/bin', '/usr/local/bin', '/usr/bin']) {
    const file = GLib.build_filenamev([dir, name]);
    if (GLib.file_test(file, GLib.FileTest.IS_EXECUTABLE)) return file;
  }
  throw new Error(`${name} introuvable : installez-le ou choisissez un autre outil dans les préférences`);
}

/** Dossier neutre où l'outil est lancé (pas de projet, pas de fichiers lus). */
function workDir(): string {
  const dir = GLib.build_filenamev([GLib.get_tmp_dir(), 'wa-gnome-traduction']);
  GLib.mkdir_with_parents(dir, 0o700);
  return dir;
}

/** Lance un programme, `input` sur l'entrée standard ; sortie standard, erreur si le code n'est pas 0. */
async function run(argv: string[], input: string | null, env: Record<string, string> = {}): Promise<string> {
  const launcher = new Gio.SubprocessLauncher({ flags: Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE });
  launcher.set_cwd(workDir());
  for (const [k, v] of Object.entries(env)) launcher.setenv(k, v, true);
  const proc = launcher.spawnv(argv);
  const [out, err] = await proc.communicate_utf8_async(input, null);
  if (!proc.get_successful()) {
    const last = (err ?? '').trim().split('\n').at(-1) ?? '';
    throw new Error(last === '' ? `${GLib.path_get_basename(argv[0] ?? '')} : échec` : last);
  }
  return out ?? '';
}

/** Agent opencode de l'app : aucun outil, toute permission refusée (texte seulement). */
const OPENCODE_AGENT = 'wa-gnome-traduction';
const OPENCODE_CONFIG = JSON.stringify({
  agent: { [OPENCODE_AGENT]: { description: 'Traduction de messages WhatsApp, sans outils', mode: 'primary', tools: { '*': false }, permission: { edit: 'deny', bash: 'deny', webfetch: 'deny' } } },
});

/** Réponse de l'outil choisi dans les préférences (Claude Code ou opencode) à une consigne. */
async function ask(prompt: string): Promise<string> {
  const s = settings();
  if (s.translator === 'opencode') {
    const model = s.opencodeModel === '' ? [] : ['--model', s.opencodeModel];
    // agent sans aucun outil : un message reçu ne peut pas faire lancer de commande (injection)
    return opencodeText(await run([program('opencode'), 'run', '--agent', OPENCODE_AGENT, '--format', 'json', '--dir', workDir(), ...model, prompt], null, { OPENCODE_CONFIG_CONTENT: OPENCODE_CONFIG }));
  }
  // Claude Code : sans outils ni session gardée, consigne sur l'entrée standard
  return run([program('claude'), '-p', '--tools', '', '--no-session-persistence', '--output-format', 'text'], prompt);
}

/** Traduit un texte avec l'outil choisi dans les préférences. */
export async function translateText(text: string): Promise<{ from: string | null; text: string }> {
  const s = settings();
  if (GLib.getenv('WA_GNOME_TEST_TRANSLATE') !== null) return { from: 'anglais', text: `[${s.translateTo}] ${text}` };
  return parseAnswer(await ask(translatePrompt(text, s.translateTo)));
}

/** Consigne : quelle transcription (une par langue supposée) est un texte cohérent. */
export function pickPrompt(candidates: readonly { lang: string; text: string }[]): string {
  return [
    'Voici plusieurs transcriptions automatiques du même message vocal WhatsApp, chacune obtenue en supposant une langue différente.',
    'Une seule correspond à la vraie langue : c’est celle qui forme un texte cohérent (les autres sont des approximations phonétiques sans sens).',
    'Réponds uniquement par le numéro de la bonne transcription.',
    ...candidates.map((c, i) => `${i + 1}. [${languageName(c.lang)}] ${c.text}`),
  ].join('\n');
}

/** Numéro choisi dans la réponse (1 à `count`), ou null. */
export function parsePick(out: string, count: number): number | null {
  const n = Number(/\d+/u.exec(out)?.[0]);
  return Number.isInteger(n) && n >= 1 && n <= count ? n - 1 : null;
}

// ---------------------------------------------------------------- transcription

export { downloadWhisper, whisperFile };

/** Vocal converti en WAV 16 kHz mono (format lu par whisper.cpp), avec GStreamer. */
function toWav(source: Gio.File): Promise<string> {
  Gst.init([]);
  const out = GLib.build_filenamev([workDir(), `vocal-${Date.now()}.wav`]);
  const pipeline = Gst.parse_launch(`filesrc name=src ! decodebin ! audioconvert ! audioresample ! audio/x-raw,format=S16LE,rate=16000,channels=1 ! wavenc ! filesink name=sink`);
  if (!(pipeline instanceof Gst.Bin)) throw new Error('GStreamer : conversion impossible');
  pipeline.get_by_name('src')?.set_property('location', source.get_path() ?? '');
  pipeline.get_by_name('sink')?.set_property('location', out);
  return new Promise((resolve, reject) => {
    const bus = pipeline.get_bus();
    bus?.add_signal_watch();
    bus?.connect('message', (_b: Gst.Bus, m: Gst.Message) => {
      if (m.type !== Gst.MessageType.EOS && m.type !== Gst.MessageType.ERROR) return;
      pipeline.set_state(Gst.State.NULL);
      bus.remove_signal_watch();
      if (m.type === Gst.MessageType.EOS) resolve(out);
      else reject(new Error(m.parse_error()[0]?.message ?? 'conversion impossible'));
    });
    pipeline.set_state(Gst.State.PLAYING);
  });
}

/** Nom d'une langue de whisper (code tel quel s'il n'est pas dans la liste). */
export const languageName = (code: string): string => VOICE_LANGUAGES.find((l) => l.code === code)?.name ?? code;

const WhisperJson = z.object({
  result: z.optional(z.object({ language: z.optional(z.string()) })),
  transcription: z.optional(z.array(z.object({ text: z.optional(z.string()), tokens: z.optional(z.array(z.object({ text: z.optional(z.string()), p: z.optional(z.number()) }))) }))),
});

/** Sortie JSON de whisper-cli (`-ojf`) : texte, langue, confiance moyenne des mots (0 à 1). */
export function parseWhisper(json: string): { text: string; lang: string | null; score: number } {
  const w = WhisperJson.safeParse(JSON.parse(json));
  if (!w.success) return { text: '', lang: null, score: 0 };
  const segments = w.data.transcription ?? [];
  const text = segments.map((s) => s.text ?? '').join(' ').replaceAll(/\s+/gu, ' ').trim();
  // jetons spéciaux ([_BEG_], <|fr|>…) exclus de la confiance
  const probs = segments.flatMap((s) => (s.tokens ?? []).filter((t) => !/^\[_|^<\|/u.test(t.text ?? '')).map((t) => t.p ?? 0));
  const score = probs.length === 0 ? 0 : probs.reduce((a, b) => a + b, 0) / probs.length;
  return { text, lang: w.data.result?.language ?? null, score };
}

/** Une passe de whisper-cli sur le WAV, dans la langue donnée (`auto` : détectée). */
async function whisper(wav: string, model: string, lang: string): Promise<{ text: string; lang: string | null; score: number }> {
  const bin = GLib.getenv('WA_GNOME_WHISPER') ?? program('whisper-cli');
  const base = `${wav}-${lang}`;
  await run([bin, '-m', model, '-f', wav, '-l', lang, '-nt', '-np', '-ojf', '-of', base, '-t', String(Math.max(1, Math.min(8, GLib.get_num_processors())))], null);
  try {
    const [, data] = GLib.file_get_contents(`${base}.json`);
    const r = parseWhisper(new TextDecoder().decode(data));
    return { ...r, lang: lang === 'auto' ? r.lang : lang };
  } finally {
    GLib.unlink(`${base}.json`);
  }
}

/**
 * Transcription locale d'un vocal. `lang` : langue imposée ; sinon détectée, et si elle ne fait
 * pas partie des langues de l'utilisateur (`languages`), nouvelle passe dans chacune d'elles et
 * meilleur résultat gardé (whisper confond par exemple l'hébreu et l'arménien).
 */
export async function transcribe(audio: Gio.File, lang: string | null = null, languages: readonly string[] = settings().voiceLanguages): Promise<{ text: string; lang: string | null }> {
  if (GLib.getenv('WA_GNOME_TEST_TRANSLATE') !== null) return { text: 'Bonjour, ceci est un vocal de test.', lang: lang ?? 'fr' };
  const model = whisperFile(settings().whisperModel);
  if (!GLib.file_test(model, GLib.FileTest.EXISTS)) throw new MissingModel(settings().whisperModel);
  const wav = await toWav(audio);
  try {
    if (lang !== null) return await whisper(wav, model, lang);
    const detected = await whisper(wav, model, 'auto');
    if (languages.length === 0 || (detected.lang !== null && languages.includes(detected.lang))) return detected;
    // langue détectée hors de la liste : une passe par langue de l'utilisateur, puis l'outil de
    // traduction choisit la transcription cohérente (la confiance de whisper ne suffit pas : une
    // approximation phonétique dans la mauvaise langue peut sembler très sûre)
    const candidates: { lang: string; text: string; score: number }[] = [];
    for (const l of languages) {
      // oxlint-disable-next-line no-await-in-loop -- une passe à la fois (processeur)
      const r = await whisper(wav, model, l);
      if (r.text !== '') candidates.push({ lang: l, text: r.text, score: r.score });
    }
    if (candidates.length === 0) return detected;
    if (candidates.length === 1) return candidates[0] ?? detected;
    try {
      const i = parsePick(await ask(pickPrompt(candidates)), candidates.length);
      if (i !== null) return candidates[i] ?? detected;
    } catch (error) {
      console.error(`choix de la langue : ${errorMessage(error)}`);
    }
    // outil indisponible : meilleure confiance
    return candidates.reduce((a, b) => (b.score > a.score ? b : a));
  } finally {
    GLib.unlink(wav);
  }
}

/** Modèle de transcription absent : à télécharger (proposé à l'utilisateur). */
export class MissingModel extends Error {
  readonly model: WhisperModel;
  constructor(model: WhisperModel) {
    const info = WHISPER_MODELS.find((m) => m.id === model);
    super(`modèle de transcription « ${info?.name ?? model} » absent`);
    this.model = model;
  }
}

// ---------------------------------------------------------------- traduction d'un message

/**
 * Traduit un message (texte ou légende) ; vocal : transcription puis traduction (`translate`
 * faux : transcription seule). `file` : fichier du vocal (cache des médias).
 */
export async function translateMessage(m: Message, opts: { file?: () => Promise<Gio.File>; translate?: boolean; lang?: string | null } = {}): Promise<void> {
  const key = keyOf(m);
  const audio = m.kind === 'audio' && opts.file !== undefined;
  let source = m.text;
  let spoken: string | null = null;
  try {
    if (audio && opts.file !== undefined) {
      put(key, { status: 'transcribing' });
      // langue : imposée, sinon celle retenue pour la discussion, sinon détectée
      const t = await transcribe(await opts.file(), opts.lang ?? settings().chatVoiceLanguages[m.chatId] ?? null);
      source = t.text;
      spoken = t.lang;
      if (opts.translate === false) {
        put(key, { status: 'done', transcript: source, spoken });
        return;
      }
      put(key, { status: 'translating', transcript: source, spoken });
    } else {
      put(key, { status: 'translating' });
    }
    if (source.trim() === '') {
      put(key, { status: 'done', transcript: source, spoken, text: '', from: null });
      return;
    }
    const t = await translateText(source);
    put(key, { status: 'done', ...(audio ? { transcript: source, spoken } : {}), text: t.text, from: t.from });
  } catch (error) {
    put(key, { status: 'error', ...(audio && source !== m.text ? { transcript: source, spoken } : {}), error: errorMessage(error) });
    if (error instanceof MissingModel) throw error;
  }
}
