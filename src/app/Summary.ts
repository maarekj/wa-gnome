// Résumés par IA des messages sélectionnés : même outil que la traduction (Claude Code ou opencode,
// sans outils), dans la langue des préférences. Vocaux transcrits d'abord s'ils ne le sont pas.
// Affichés dans un panneau à droite de la conversation (discussion toujours visible), gardés par
// discussion (fichier `summaries.json`) pour être relus plus tard.
import type Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';
import { type Accessor, createState, onCleanup } from 'gnim';
import * as z from 'zod/mini';
import { DELETED_TEXT, type Message, previewOf } from '../shared/api.ts';
import { dataDir } from '../shared/client.ts';
import { errorMessage } from '../shared/errors.ts';
import { fmtDateTime, markdownMarkup } from '../shared/format.ts';
import { openLinks } from './widgets.ts';
import { MissingModel, type SummaryLine, summarize, translateMessage, translationOf } from './Translate.ts';

/** Résumés gardés par discussion au plus (les plus récents). */
const KEEP = 20;

const Summary = z.object({
  id: z.string(),
  /** secondes */
  at: z.number(),
  count: z.number(),
  /** période résumée (secondes) */
  from: z.number(),
  to: z.number(),
  status: z.enum(['transcribing', 'summarizing', 'done', 'error']),
  /** avancement de la transcription des vocaux */
  progress: z.optional(z.string()),
  text: z.optional(z.string()),
  error: z.optional(z.string()),
  /** remarque (vocaux non transcrits…) */
  note: z.optional(z.string()),
});
export type Summary = z.infer<typeof Summary>;

const SummaryFile = z.record(z.string(), z.array(Summary));

const summariesFile = (): string => GLib.build_filenamev([dataDir(), 'summaries.json']);

function load(): ReadonlyMap<string, readonly Summary[]> {
  try {
    const [, bytes] = GLib.file_get_contents(summariesFile());
    const parsed = SummaryFile.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
    // résumé interrompu (application fermée) : en erreur
    return new Map(Object.entries(parsed.success ? parsed.data : {}).map(([k, list]) => [k, list.map((s) => (s.status === 'done' || s.status === 'error' ? s : { ...s, status: 'error' as const, error: 'interrompu' }))]));
  } catch {
    return new Map();
  }
}

const [summaries, setSummaries] = createState<ReadonlyMap<string, readonly Summary[]>>(load());
export { summaries };

function save(): void {
  try {
    GLib.mkdir_with_parents(dataDir(), 0o700);
    GLib.file_set_contents(summariesFile(), JSON.stringify(Object.fromEntries(summaries.peek())));
  } catch (error) {
    console.error(`résumés : ${errorMessage(error)}`);
  }
}

/** Clé d'une discussion : compte et identifiant. */
export const summaryKey = (account: string, chatId: string): string => `${account}/${chatId}`;

function put(key: string, s: Summary): void {
  const next = new Map(summaries.peek());
  const list = next.get(key) ?? [];
  next.set(key, list.some((x) => x.id === s.id) ? list.map((x) => (x.id === s.id ? s : x)) : [s, ...list].slice(0, KEEP));
  setSummaries(next);
  if (s.status === 'done' || s.status === 'error') save();
}

function remove(key: string, id: string): void {
  const next = new Map(summaries.peek());
  const list = (next.get(key) ?? []).filter((x) => x.id !== id);
  if (list.length === 0) next.delete(key);
  else next.set(key, list);
  setSummaries(next);
  save();
}

/** Lignes envoyées au résumé : auteur, heure, texte (transcription d'un vocal si elle est faite). */
export function summaryLines(messages: readonly Message[], chatName: string): SummaryLine[] {
  return messages
    .filter((m) => m.kind !== 'reaction')
    .map((m) => {
      const transcript = translationOf(m)?.transcript;
      const text = m.deleted ? DELETED_TEXT : m.kind === 'audio' && transcript !== undefined ? `(vocal) ${transcript}` : m.text === '' || m.kind === 'call' ? previewOf(m) : m.kind === 'text' ? m.text : `${previewOf(m)} · ${m.text}`;
      return {
        when: GLib.DateTime.new_from_unix_local(m.timestamp)?.format('%d/%m %H:%M') ?? '',
        who: m.fromMe ? 'Moi' : (m.senderName ?? m.sender?.split('@')[0] ?? chatName),
        text,
      };
    });
}

/** Vocaux à transcrire avant le résumé (pas encore de transcription). */
export const voicesToTranscribe = (messages: readonly Message[]): Message[] => messages.filter((m) => m.kind === 'audio' && m.media !== null && !m.deleted && !m.viewOnce && translationOf(m)?.transcript === undefined);

/**
 * Nouveau résumé (affiché dans le panneau) : vocaux transcrits d'abord, puis résumé.
 * `file` : fichier d'un vocal (cache des médias).
 */
export function startSummary(key: string, chatName: string, messages: readonly Message[], file: (m: Message) => Promise<Gio.File>): void {
  const first = messages[0];
  const last = messages.at(-1);
  const base: Summary = { id: `${Date.now()}`, at: Math.floor(Date.now() / 1000), count: messages.length, from: first?.timestamp ?? 0, to: last?.timestamp ?? 0, status: 'summarizing' };
  void (async (): Promise<void> => {
    let note: string | undefined;
    const voices = voicesToTranscribe(messages);
    for (const [i, m] of voices.entries()) {
      put(key, { ...base, status: 'transcribing', progress: `${i + 1}/${voices.length}` });
      try {
        // oxlint-disable-next-line no-await-in-loop -- une transcription à la fois (processeur)
        await translateMessage(m, { file: () => file(m), translate: false });
      } catch (error) {
        // modèle absent : vocaux laissés tels quels (« Audio »), signalé sous le résumé
        note = error instanceof MissingModel ? 'Vocaux non transcrits : modèle de transcription à télécharger (Préférences)' : `Vocaux non transcrits : ${errorMessage(error)}`;
        break;
      }
    }
    const withNote = note === undefined ? base : { ...base, note };
    put(key, withNote);
    try {
      put(key, { ...withNote, status: 'done', text: await summarize(chatName, summaryLines(messages, chatName)) });
    } catch (error) {
      put(key, { ...withNote, status: 'error', error: errorMessage(error) });
    }
  })();
}

/** Carte d'un résumé : période, état ou texte, copier, effacer. */
function summaryCard(key: string, s: Summary): Gtk.Widget {
  const card = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6, cssClasses: ['card', 'summary-card'] });
  const top = new Gtk.Box({ spacing: 6 });
  const period = s.from === s.to ? fmtDateTime(s.from) : `${fmtDateTime(s.from)} – ${fmtDateTime(s.to)}`;
  const title = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, hexpand: true });
  title.append(new Gtk.Label({ label: s.count === 1 ? '1 message' : `${s.count} messages`, xalign: 0, cssClasses: ['heading'] }));
  title.append(new Gtk.Label({ label: period, xalign: 0, ellipsize: Pango.EllipsizeMode.END, cssClasses: ['caption', 'dim-label'] }));
  top.append(title);
  const copy = new Gtk.Button({ iconName: 'edit-copy-symbolic', tooltipText: 'Copier le résumé', cssClasses: ['flat', 'circular'], valign: Gtk.Align.START, sensitive: s.status === 'done' });
  copy.connect('clicked', () => {
    copy.get_clipboard().set(s.text ?? '');
    copy.tooltipText = 'Résumé copié';
  });
  const del = new Gtk.Button({ iconName: 'user-trash-symbolic', tooltipText: 'Effacer ce résumé', cssClasses: ['flat', 'circular'], valign: Gtk.Align.START, sensitive: s.status === 'done' || s.status === 'error' });
  del.connect('clicked', () => remove(key, s.id));
  top.append(copy);
  top.append(del);
  card.append(top);
  if (s.status === 'transcribing' || s.status === 'summarizing') {
    const wait = new Gtk.Box({ spacing: 8 });
    wait.append(new Gtk.Spinner({ spinning: true }));
    wait.append(new Gtk.Label({ label: s.status === 'transcribing' ? `Transcription des vocaux (${s.progress ?? ''})…` : 'Résumé en cours…', xalign: 0, cssClasses: ['dim-label'] }));
    card.append(wait);
  } else if (s.status === 'error') {
    card.append(new Gtk.Label({ label: `Résumé impossible : ${s.error ?? ''}`, xalign: 0, wrap: true, wrapMode: Pango.WrapMode.WORD_CHAR, cssClasses: ['error'] }));
  } else {
    // réponse en Markdown (gras, listes, citations…) ; liens ouverts dans le navigateur
    const body = new Gtk.Label({ label: markdownMarkup(s.text ?? ''), useMarkup: true, xalign: 0, wrap: true, wrapMode: Pango.WrapMode.WORD_CHAR, selectable: true, cssClasses: ['summary'] });
    openLinks(body);
    card.append(body);
  }
  if (s.note !== undefined) card.append(new Gtk.Label({ label: s.note, xalign: 0, wrap: true, cssClasses: ['caption', 'warning'] }));
  return card;
}

/**
 * Panneau des résumés de la discussion `key` (à droite de la conversation) ; `open` le montre ou
 * le cache, `close` : bouton de fermeture.
 */
export function SummaryPanel(key: Accessor<string>, open: Accessor<boolean>, close: () => void): Gtk.Widget {
  const top = new Gtk.Box({ spacing: 6, marginTop: 8, marginBottom: 8, marginStart: 12, marginEnd: 8 });
  top.append(new Gtk.Label({ label: 'Résumés (IA)', xalign: 0, hexpand: true, cssClasses: ['heading'] }));
  const closeButton = new Gtk.Button({ iconName: 'window-close-symbolic', tooltipText: 'Fermer les résumés', cssClasses: ['flat', 'circular'] });
  closeButton.connect('clicked', close);
  top.append(closeButton);
  const list = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 10, marginTop: 10, marginBottom: 12, marginStart: 10, marginEnd: 10 });
  const empty = new Gtk.Label({ label: 'Aucun résumé pour cette discussion.\nSélectionnez des messages puis « Résumer (IA) ».', wrap: true, justify: Gtk.Justification.CENTER, marginTop: 24, cssClasses: ['dim-label'] });
  const panel = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, vexpand: true, cssClasses: ['chat-search'] });
  panel.append(top);
  panel.append(new Gtk.Separator());
  const inner = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
  inner.append(empty);
  inner.append(list);
  panel.append(new Gtk.ScrolledWindow({ child: inner, vexpand: true, hscrollbarPolicy: Gtk.PolicyType.NEVER }));
  const render = (): void => {
    for (let c = list.get_first_child(); c !== null; c = list.get_first_child()) list.remove(c);
    const k = key.peek();
    const items = summaries.peek().get(k) ?? [];
    empty.visible = items.length === 0;
    for (const s of items) list.append(summaryCard(k, s));
  };
  render();
  onCleanup(summaries.subscribe(render));
  onCleanup(key.subscribe(render));
  // caché hors de l'animation (comme la recherche)
  const revealer = new Gtk.Revealer({ child: panel, transitionType: Gtk.RevealerTransitionType.NONE, revealChild: open.peek(), visible: open.peek() });
  revealer.connect('notify::child-revealed', () => {
    if (!revealer.childRevealed && !open.peek()) revealer.visible = false;
  });
  onCleanup(
    open.subscribe(() => {
      if (open.peek()) revealer.visible = true;
      revealer.revealChild = open.peek();
    }),
  );
  return revealer;
}
