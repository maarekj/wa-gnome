// Discussion ouverte : messages (bulles, séparateurs de jour) et zone de saisie.
import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';
import { createMemo, createState, onCleanup, type Accessor } from 'gnim';
import { DELETED_TEXT, editability, PIN_DURATIONS, type Poll, ephemeralText, viewOnceLabel, isMissedCall, isVideoCall, type Media, type Presence, type MessageStatus, previewOf, type Message, QUICK_REACTIONS, REVOKE_WINDOW_S, type Quoted, uploadKind } from '../shared/api.ts';
import { errorMessage } from '../shared/errors.ts';
import { dayKey, emojiOnly, esc, fmtDateTime, fmtDay, fmtTime, mentionMarkup, waMarkup } from '../shared/format.ts';
import { type Store, typingText } from '../shared/store.ts';
import { type Attachment, attachDrop, attachmentChip, fromFile, fromTexture, pasteAttachments, pickFiles } from './Attachments.ts';
import { avatarText, isChannel } from './ChatList.tsx';
import { openMessageInfo } from './MessageInfo.ts';
import { ChatSearch } from './ChatSearch.ts';
import { rememberSidePanelWidth, setChatVoiceLanguage, settings, sidePanelWidth, WHISPER_MODELS, type WhisperModel } from './Preferences.ts';
import { DownloadCancelled } from './Whisper.ts';
import { ScheduledBar, scheduleButton } from './Schedule.ts';
import { mentionPicker, type MentionPicker, resolveMentions } from './MentionPicker.ts';
import { startSummary, SummaryPanel, summaries, summaryKey } from './Summary.ts';
import { downloadWhisper, hideTranslation, languageName, MissingModel, translateMessage, translationOf, translations } from './Translate.ts';
import { fmtRecording, Recorder } from './Recorder.ts';
import { attachDragSelect } from './DragSelect.ts';
import { openGallery } from './Gallery.ts';
import { openChatInfo } from './ChatInfoDialog.ts';
import { confirmRemoveMany, copyText, openForward } from './Selection.ts';
import { ReactionsRow } from './Reactions.ts';
import { keyedBox } from './KeyedBox.ts';
import { bindAvatar, type Pictures } from './pictures.ts';
import { displaySize, type Loaded, MediaLoader, openViewer, type Photo, thumbnailTexture } from './media.ts';
import { MediaFrame } from './MediaFrame.ts';
import { AudioView, DocumentView, VideoView } from './MediaViews.ts';
import { asWidget, openLinks } from './widgets.ts';

/** Élément de la conversation : séparateur de jour ou message. */
export type Item = { kind: 'day'; key: string; label: string } | { kind: 'message'; key: string; message: Message; showSender: boolean; group: boolean };

/** Messages groupés par jour ; nom de l'auteur affiché au premier message d'une suite (groupes). */
export function itemsOf(messages: readonly Message[], group: boolean): Item[] {
  const items: Item[] = [];
  let day = '';
  let previous: Message | null = null;
  for (const m of messages) {
    const k = dayKey(m.timestamp);
    if (k !== day) {
      day = k;
      previous = null;
      items.push({ kind: 'day', key: `day:${k}`, label: fmtDay(m.timestamp) });
    }
    const known = m.sender !== null || m.senderName !== null;
    const showSender = group && !m.fromMe && known && (previous === null || previous.fromMe || previous.sender !== m.sender);
    // supprimé : clé différente, bulle reconstruite (média et citation retirés)
    items.push({ kind: 'message', key: m.deleted ? `m:${m.id}:x` : `m:${m.id}`, message: m, showSender, group });
    previous = m;
  }
  return items;
}

/** Classe d'un message fait de 1 à 3 émojis seulement (affichés en grand, comme WhatsApp). */
export function bigEmoji(m: Pick<Message, 'kind' | 'text'>): string[] {
  if (m.kind !== 'text') return [];
  const n = emojiOnly(m.text);
  return n === 0 || n > 3 ? [] : [n === 1 ? 'emoji-1' : 'emoji-3'];
}

/** « de l’anglais », « du russe », « de l’hébreu » (langue d'origine d'une traduction). */
export const fromLanguage = (lang: string): string => (/^[aeiouyéèêh]/iu.test(lang) ? `de l’${lang}` : `du ${lang}`);

/**
 * Modèle de transcription absent : téléchargement proposé (taille indiquée, suivi dans les
 * préférences), puis `then`.
 */
function offerWhisperDownload(parent: Gtk.Widget, model: WhisperModel, toast: (t: string) => void, then: () => void): void {
  const info = WHISPER_MODELS.find((w) => w.id === model);
  const dialog = new Adw.AlertDialog({
    heading: 'Télécharger le modèle de transcription ?',
    body: `Les vocaux sont transcrits sur cet ordinateur. Le modèle « ${info?.name ?? model} » doit être téléchargé une fois${info === undefined ? '' : ` (${info.size} Mo)`}. Les modèles se gèrent dans Préférences › Transcription des vocaux.`,
  });
  dialog.add_response('cancel', 'Annuler');
  dialog.add_response('prefs', 'Préférences');
  dialog.add_response('download', 'Télécharger');
  dialog.set_response_appearance('download', Adw.ResponseAppearance.SUGGESTED);
  dialog.connect('response', (_d: Adw.AlertDialog, response: string) => {
    if (response === 'prefs') {
      parent.activate_action('app.preferences', null);
      return;
    }
    if (response !== 'download') return;
    toast('Téléchargement du modèle… (avancement dans les préférences)');
    void (async (): Promise<void> => {
      try {
        await downloadWhisper(model);
        toast('Modèle de transcription prêt');
        then();
      } catch (error) {
        // annulé depuis les préférences : rien à reprendre
        if (!(error instanceof DownloadCancelled)) toast(`Téléchargement impossible : ${errorMessage(error)}`);
      }
    })();
  });
  dialog.present(parent);
}

/** Transcription et traduction d'un message (sous son texte), mises à jour en direct. */
function TranslationView(m: Message): Gtk.Widget {
  const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2, cssClasses: ['translation'], visible: false });
  const transcript = new Gtk.Label({ xalign: 0, wrap: true, wrapMode: Pango.WrapMode.WORD_CHAR, selectable: true, maxWidthChars: 60, cssClasses: ['transcript'] });
  // à la ligne : un long message d'erreur élargissait toute la conversation (et la fenêtre)
  const head = new Gtk.Label({ xalign: 0, wrap: true, wrapMode: Pango.WrapMode.WORD_CHAR, maxWidthChars: 60, cssClasses: ['caption', 'dim-label'] });
  const text = new Gtk.Label({ xalign: 0, wrap: true, wrapMode: Pango.WrapMode.WORD_CHAR, selectable: true, maxWidthChars: 60, useMarkup: true });
  openLinks(text);
  box.append(transcript);
  box.append(head);
  box.append(text);
  const sync = (): void => {
    const t = translationOf(m);
    box.visible = t !== undefined;
    if (t === undefined) return;
    transcript.visible = t.transcript !== undefined && t.transcript !== '';
    transcript.label = t.transcript === undefined ? '' : `« ${t.transcript} »`;
    head.visible = true;
    text.visible = t.text !== undefined && t.text !== '';
    text.label = waMarkup(t.text ?? '');
    head.label =
      t.status === 'transcribing'
        ? 'Transcription…'
        : t.status === 'translating'
          ? 'Traduction…'
          : t.status === 'error'
            ? `Échec : ${t.error ?? ''}`
            : t.text === undefined
              ? t.spoken === null || t.spoken === undefined
                ? 'Transcription'
                : `Transcription (${languageName(t.spoken)})`
              : t.text === ''
                ? `Déjà en ${settings().translateTo}`
                : t.from === null || t.from === undefined
                  ? 'Traduction'
                  : `Traduit ${fromLanguage(t.from)}`;
  };
  sync();
  onCleanup(translations.subscribe(sync));
  return box;
}

/** Couleurs des noms des participants (lisibles en thème clair et sombre). */
const SENDER_COLORS = ['#d63d6e', '#1f7aec', '#c75000', '#9141c2', '#0a8f55', '#d13438', '#0f8394', '#a06a00', '#5b5fc7', '#b5338a', '#3d8a1f', '#e0662c'] as const;

/** Couleur du nom d'un participant : stable, choisie d'après son identifiant. */
export function senderColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (Math.imul(h, 31) + (id.codePointAt(i) ?? 0)) >>> 0;
  return SENDER_COLORS[h % SENDER_COLORS.length] ?? SENDER_COLORS[0];
}

/** Bulle d'un message (pour la mise en évidence) : premier descendant de classe `bubble` ou `sticker`. */
function findBubble(w: Gtk.Widget): Gtk.Widget | null {
  if (w.has_css_class('bubble') || w.has_css_class('sticker')) return w;
  for (let c = w.get_first_child(); c !== null; c = c.get_next_sibling()) {
    const found = findBubble(c);
    if (found !== null) return found;
  }
  return null;
}

/**
 * Message reçu dans un groupe : photo de l'auteur à gauche, au premier message d'une suite
 * (place gardée pour les suivants, bulles alignées). Le nom `m:<id>` passe à l'enveloppe.
 */
function withAuthor(ctx: BubbleContext, w: Gtk.Widget, m: Message, live: Accessor<Item>): Gtk.Widget {
  const name = m.senderName ?? m.sender?.split('@')[0] ?? '';
  const avatar = new Adw.Avatar({ size: 28, text: avatarText(name), showInitials: /\p{L}/u.test(name), valign: Gtk.Align.START, marginTop: 2, tooltipText: name });
  if (m.sender !== null) bindAvatar(avatar, ctx.pictures.texture(m.sender));
  const first = (): boolean => {
    const it = live.peek();
    return it.kind === 'message' && it.showSender;
  };
  avatar.opacity = first() ? 1 : 0;
  onCleanup(
    live.subscribe(() => {
      avatar.opacity = first() ? 1 : 0;
    }),
  );
  const row = new Gtk.Box({ name: w.name, spacing: 6, halign: Gtk.Align.START, marginEnd: w.marginEnd });
  w.name = '';
  w.marginEnd = 0;
  row.append(avatar);
  row.append(w);
  return row;
}

/** Contexte du rendu des bulles. */
interface BubbleContext {
  readonly loader: MediaLoader;
  readonly toast: (text: string) => void;
  readonly chatName: () => string;
  /** photos chargées de la discussion (visionneuse : précédente / suivante) */
  readonly photos: () => readonly Photo[];
  /** répondre à ce message (bandeau dans la zone de saisie) */
  readonly reply: (m: Message) => void;
  /** amène le message à l'écran s'il est chargé ; false sinon */
  readonly scrollTo: (id: string) => boolean;
  /** réagit au message (émoji vide : réaction retirée) */
  readonly react: (m: Message, emoji: string) => void;
  /** photos des personnes (fenêtre des réactions) */
  readonly pictures: Pictures;
  /** infos d'un message envoyé (accusés) */
  readonly info: (m: Message) => void;
  /** modifier un de mes messages (zone de saisie) */
  readonly edit: (m: Message) => void;
  /** supprimer pour tous ou pour moi (après confirmation) */
  readonly remove: (parent: Gtk.Widget, m: Message, action: 'revoke' | 'delete-for-me') => void;
  /** messages sélectionnés (identifiants) ; vide : pas de sélection en cours */
  readonly selection: Accessor<ReadonlySet<string>>;
  /** coche ou décoche un message (entre en mode sélection) */
  readonly toggleSelect: (m: Message) => void;
  /** transférer ce message (fenêtre de choix des discussions) */
  readonly forward: (parent: Gtk.Widget, m: Message) => void;
  /** traduire (texte, vocal : transcription puis traduction) ou seulement transcrire un vocal */
  readonly translate: (parent: Gtk.Widget, m: Message, mode: 'translate' | 'transcribe', lang?: string | null) => void;
  /** messages épinglés de la discussion (identifiants) */
  readonly pinned: () => ReadonlySet<string>;
  /** épingler pour `duration` secondes, ou désépingler (null) */
  readonly pin: (m: Message, duration: number | null) => void;
  /** voter à un sondage (options choisies ; vide : vote retiré) */
  readonly vote: (m: Message, options: readonly string[]) => void;
  /** mon identifiant (ma photo), null s'il n'est pas connu */
  readonly me: () => string | null;
}

/** Messages transférables (pas ceux supprimés pour tous). */
const forwardable = (list: readonly Message[]): Message[] => list.filter((m) => !m.deleted);

/**
 * Ligne d'un message, sur toute la largeur : surlignée si sélectionnée ; en mode sélection, un clic
 * n'importe où sur la ligne coche ou décoche (capturé avant l'image, la citation ou le texte).
 * Le nom `m:<id>` passe à la ligne (défilement vers un message cité).
 */
function selectableRow(ctx: BubbleContext, row: Gtk.Widget, id: string, msg: () => Message): Gtk.Widget {
  const line = new Gtk.Box({ name: row.name, hexpand: true, cssClasses: ['message-line'] });
  row.name = '';
  row.hexpand = true;
  line.append(row);
  const click = new Gtk.GestureClick({ button: Gdk.BUTTON_PRIMARY, propagationPhase: Gtk.PropagationPhase.CAPTURE });
  click.connect('pressed', (g: Gtk.GestureClick) => {
    if (ctx.selection.peek().size === 0) return;
    g.set_state(Gtk.EventSequenceState.CLAIMED);
    ctx.toggleSelect(msg());
  });
  line.add_controller(click);
  const update = (): void => {
    const s = ctx.selection.peek();
    for (const w of [row, line]) {
      if (s.has(id)) w.add_css_class('selected-message');
      else w.remove_css_class('selected-message');
    }
    line.set_cursor_from_name(s.size > 0 ? 'pointer' : null);
  };
  update();
  onCleanup(ctx.selection.subscribe(update));
  return line;
}

/** Sous-titre de l'en-tête : écrit…, en ligne, vu à … ; vide sans information. */
export function presenceLine(p: Presence | null, group: boolean, now = Date.now() / 1000): string {
  if (p === null) return '';
  const typing = typingText(p, group);
  if (typing !== null) return typing;
  if (group) return '';
  if (p.online) return 'en ligne';
  if (p.lastSeen === null) return '';
  return `vu ${fmtDay(p.lastSeen, GLib.DateTime.new_from_unix_local(now) ?? undefined).toLowerCase()} à ${fmtTime(p.lastSeen)}`;
}

/** Coches d'un message envoyé (comme WhatsApp). */
export const STATUS_MARK: Readonly<Record<MessageStatus, string>> = { pending: '🕓', sent: '✓', delivered: '✓✓', read: '✓✓', played: '✓✓', error: '⚠' };
const STATUS_TEXT: Readonly<Record<MessageStatus, string>> = { pending: 'En attente d’envoi', sent: 'Envoyé', delivered: 'Reçu', read: 'Lu', played: 'Écouté', error: 'Échec de l’envoi' };

/** Ma réaction sur un message, ou null. */
export const myReaction = (m: Pick<Message, 'reactions'>): string | null => m.reactions.find((r) => r.mine)?.emoji ?? null;

/** Aperçu d'une citation : auteur et début du texte (ou genre du média). */
export const quotePreview = (q: Pick<Quoted, 'kind' | 'text'>): string => previewOf(q).replaceAll('\n', ' ');

/** Transferts à partir desquels WhatsApp affiche « Transféré à plusieurs reprises ». */
const FORWARDED_MANY = 5;

/** Mention « Transféré » en tête de bulle (comme WhatsApp). */
function ForwardedMark(score: number): Gtk.Widget {
  const many = score >= FORWARDED_MANY;
  const box = new Gtk.Box({ spacing: 4, cssClasses: ['forwarded', 'dim-label'] });
  box.append(new Gtk.Image({ iconName: 'mail-forward-symbolic', pixelSize: 14 }));
  box.append(new Gtk.Label({ label: many ? 'Transféré à plusieurs reprises' : 'Transféré', xalign: 0, cssClasses: ['caption'] }));
  return box;
}

/** Bloc de citation dans une bulle ; clic : message cité à l'écran. */
function QuoteBlock(ctx: BubbleContext, q: Quoted): Gtk.Widget {
  const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, cssClasses: ['quote', ...(q.fromMe ? ['mine'] : [])], tooltipText: 'Voir le message cité' });
  box.append(new Gtk.Label({ label: q.senderName ?? '', xalign: 0, ellipsize: Pango.EllipsizeMode.END, cssClasses: ['caption-heading', 'accent'], visible: q.senderName !== null }));
  box.append(new Gtk.Label({ label: quotePreview(q), xalign: 0, ellipsize: Pango.EllipsizeMode.END, lines: 2, wrap: true, wrapMode: Pango.WrapMode.WORD_CHAR, maxWidthChars: 40, cssClasses: ['caption'] }));
  box.set_cursor_from_name('pointer');
  const click = new Gtk.GestureClick();
  click.connect('released', () => {
    if (!ctx.scrollTo(q.id)) ctx.toast('Message cité plus ancien que ceux affichés');
  });
  box.add_controller(click);
  return box;
}

/** Menu d'une bulle (clic droit, appui long) : répondre, copier le texte. */
function attachBubbleMenu(ctx: BubbleContext, widget: Gtk.Widget, msg: () => Message): void {
  const group = new Gio.SimpleActionGroup();
  const reactAction = new Gio.SimpleAction({ name: 'react', parameterType: new GLib.VariantType('s') });
  reactAction.connect('activate', (_a: Gio.SimpleAction, param: GLib.Variant | null) => ctx.react(msg(), param?.get_string()[0] ?? ''));
  group.add_action(reactAction);
  const infoAction = new Gio.SimpleAction({ name: 'info' });
  infoAction.connect('activate', () => ctx.info(msg()));
  group.add_action(infoAction);
  const editAction = new Gio.SimpleAction({ name: 'edit' });
  editAction.connect('activate', () => ctx.edit(msg()));
  group.add_action(editAction);
  // entrée grisée (délai dépassé) : action désactivée
  group.add_action(new Gio.SimpleAction({ name: 'edit-late', enabled: false }));
  for (const [name, action] of [['revoke', 'revoke'], ['delete-for-me', 'delete-for-me']] as const) {
    const a = new Gio.SimpleAction({ name });
    a.connect('activate', () => ctx.remove(widget, msg(), action));
    group.add_action(a);
  }
  const replyAction = new Gio.SimpleAction({ name: 'reply' });
  replyAction.connect('activate', () => ctx.reply(msg()));
  group.add_action(replyAction);
  const selectAction = new Gio.SimpleAction({ name: 'select' });
  selectAction.connect('activate', () => ctx.toggleSelect(msg()));
  group.add_action(selectAction);
  const forwardAction = new Gio.SimpleAction({ name: 'forward' });
  forwardAction.connect('activate', () => ctx.forward(widget, msg()));
  group.add_action(forwardAction);
  for (const [name, mode] of [['translate', 'translate'], ['transcribe', 'transcribe']] as const) {
    const a = new Gio.SimpleAction({ name });
    a.connect('activate', () => ctx.translate(widget, msg(), mode));
    group.add_action(a);
  }
  // vocal : langue imposée (« auto » : détection), retenue pour la discussion
  const inLang = new Gio.SimpleAction({ name: 'transcribe-in', parameterType: new GLib.VariantType('s') });
  inLang.connect('activate', (_a: Gio.SimpleAction, param: GLib.Variant | null) => {
    const code = param?.get_string()[0] ?? 'auto';
    ctx.translate(widget, msg(), 'translate', code === 'auto' ? null : code);
  });
  group.add_action(inLang);
  const hide = new Gio.SimpleAction({ name: 'hide-translation' });
  hide.connect('activate', () => hideTranslation(msg()));
  group.add_action(hide);
  const pinAction = new Gio.SimpleAction({ name: 'pin', parameterType: new GLib.VariantType('u') });
  pinAction.connect('activate', (_a: Gio.SimpleAction, param: GLib.Variant | null) => ctx.pin(msg(), param?.get_uint32() ?? PIN_DURATIONS[1].seconds));
  group.add_action(pinAction);
  const unpinAction = new Gio.SimpleAction({ name: 'unpin' });
  unpinAction.connect('activate', () => ctx.pin(msg(), null));
  group.add_action(unpinAction);
  const copy = new Gio.SimpleAction({ name: 'copy' });
  copy.connect('activate', () => {
    widget.get_clipboard().set(msg().text);
    ctx.toast('Texte copié');
  });
  group.add_action(copy);
  widget.insert_action_group('msg', group);
  const openMenu = (model: Gio.Menu, x: number, y: number): void => {
    const menu = Gtk.PopoverMenu.new_from_model_full(model, Gtk.PopoverMenuFlags.NESTED);
    menu.hasArrow = false;
    menu.halign = Gtk.Align.START;
    menu.set_parent(widget);
    menu.set_pointing_to(new Gdk.Rectangle({ x: Math.round(x), y: Math.round(y), width: 1, height: 1 }));
    menu.connect('closed', () => {
      GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        menu.unparent();
        return GLib.SOURCE_REMOVE;
      });
    });
    menu.popup();
  };
  const popup = (x: number, y: number): void => {
    const model = new Gio.Menu();
    const m = msg();
    const age = Date.now() / 1000 - m.timestamp;
    // message supprimé pour tous : seulement « Supprimer pour moi »
    if (m.deleted) {
      model.append('Sélectionner', 'msg.select');
      model.append('Supprimer pour moi…', 'msg.delete-for-me');
      openMenu(model, x, y);
      return;
    }
    model.append('Répondre', 'msg.reply');
    model.append('Transférer…', 'msg.forward');
    if (m.fromMe) model.append('Infos du message', 'msg.info');
    // modification : mes messages texte et légendes ; grisée après le délai de WhatsApp
    const editable = editability(m);
    if (editable === 'yes') model.append(m.kind === 'text' ? 'Modifier' : 'Modifier la légende', 'msg.edit');
    else if (editable === 'late') model.append('Modifier (plus de 15 min : impossible)', 'msg.edit-late');
    const reactions = new Gio.Menu();
    const mine = myReaction(msg());
    for (const emoji of QUICK_REACTIONS) {
      const it = Gio.MenuItem.new(`${emoji}${emoji === mine ? '  ✓' : ''}`, null);
      // même émoji que le mien : retiré
      it.set_action_and_target_value('msg.react', new GLib.Variant('s', emoji === mine ? '' : emoji));
      reactions.append_item(it);
    }
    if (mine !== null && !(QUICK_REACTIONS as readonly string[]).includes(mine)) {
      const it = Gio.MenuItem.new('Retirer ma réaction', null);
      it.set_action_and_target_value('msg.react', new GLib.Variant('s', ''));
      reactions.append_item(it);
    }
    model.append_submenu('Réagir', reactions);
    if (msg().text !== '') model.append('Copier le texte', 'msg.copy');
    // traduction : texte ou légende ; vocaux : transcription (puis traduction)
    if (translationOf(m) !== undefined) model.append(m.kind === 'audio' ? 'Masquer la transcription' : 'Masquer la traduction', 'msg.hide-translation');
    else if (m.kind === 'audio') {
      model.append('Transcrire', 'msg.transcribe');
      model.append('Transcrire et traduire', 'msg.translate');
    } else if (m.text.trim() !== '') model.append('Traduire', 'msg.translate');
    if (m.kind === 'audio' && m.media !== null) {
      // langue du vocal (mal détectée) : imposée, puis retenue pour la discussion
      const langs = new Gio.Menu();
      const chosen = settings().chatVoiceLanguages[m.chatId] ?? 'auto';
      const items = [...settings().voiceLanguages.map((code) => ({ code, label: languageName(code) })), { code: 'auto', label: 'détecter automatiquement' }];
      for (const l of items) {
        const it = Gio.MenuItem.new(`${l.label.replace(/^./u, (c) => c.toUpperCase())}${l.code === chosen ? '  ✓' : ''}`, null);
        it.set_action_and_target_value('msg.transcribe-in', new GLib.Variant('s', l.code));
        langs.append_item(it);
      }
      model.append_submenu('Transcrire et traduire en…', langs);
    }
    // épingler pour tous (durée), ou désépingler
    if (ctx.pinned().has(m.id)) model.append('Désépingler', 'msg.unpin');
    else {
      const durations = new Gio.Menu();
      for (const d of PIN_DURATIONS) {
        const it = Gio.MenuItem.new(d.label, null);
        it.set_action_and_target_value('msg.pin', new GLib.Variant('u', d.seconds));
        durations.append_item(it);
      }
      model.append_submenu('Épingler', durations);
    }
    model.append('Sélectionner', 'msg.select');
    const danger = new Gio.Menu();
    if (m.fromMe && age < REVOKE_WINDOW_S) danger.append('Supprimer pour tous…', 'msg.revoke');
    danger.append('Supprimer pour moi…', 'msg.delete-for-me');
    model.append_section(null, danger);
    openMenu(model, x, y);
  };
  // capture : avant le menu du texte sélectionnable
  const click = new Gtk.GestureClick({ button: Gdk.BUTTON_SECONDARY, propagationPhase: Gtk.PropagationPhase.CAPTURE });
  click.connect('pressed', (g: Gtk.GestureClick, _n: number, x: number, y: number) => {
    g.set_state(Gtk.EventSequenceState.CLAIMED);
    popup(x, y);
  });
  widget.add_controller(click);
  const press = new Gtk.GestureLongPress({ touchOnly: true });
  press.connect('pressed', (_g: Gtk.GestureLongPress, x: number, y: number) => popup(x, y));
  widget.add_controller(press);
}

/** Document, vocal ou vidéo (null : pas de média ou type sans lecteur). */
function mediaView(ctx: BubbleContext, m: Message): Gtk.Widget | null {
  if (m.media === null) return null;
  const mm = { ...m, media: m.media };
  const views: Partial<Record<Message['kind'], (c: BubbleContext, msg: typeof mm) => Gtk.Widget>> = { document: DocumentView, audio: AudioView, video: VideoView };
  return views[m.kind]?.(ctx, mm) ?? null;
}

/** Types affichés comme image. */
const isPicture = (m: Message): m is Message & { media: Media } => m.media !== null && (m.kind === 'image' || m.kind === 'sticker');

/** Image d'un message : miniature tout de suite, image complète une fois téléchargée ; clic : aperçu. */
function MessagePicture(ctx: BubbleContext, m: Message & { media: Media }): Gtk.Widget {
  const sticker = m.kind === 'sticker';
  const [w, h] = displaySize(m.media.width, m.media.height, sticker ? 160 : 300);
  const frame = new MediaFrame({ cssClasses: ['message-media'], tooltipText: sticker ? 'Autocollant' : 'Ouvrir l’image' });
  frame.setup(w, h, sticker ? 'contain' : 'cover', sticker ? 0 : 8);
  frame.setPaintable(thumbnailTexture(m.media));
  let loaded: Loaded | null = null;
  const load = async (): Promise<void> => {
    try {
      loaded = await ctx.loader.load(m);
      frame.setPaintable(loaded.texture);
    } catch (error) {
      frame.tooltipText = `Image indisponible : ${errorMessage(error)}`;
      frame.add_css_class('media-error');
    }
  };
  void load();
  if (!sticker) {
    frame.set_cursor_from_name('pointer');
    const click = new Gtk.GestureClick();
    click.connect('released', () => {
      if (loaded === null) return;
      // photos chargées de la discussion (ordre chronologique), pour précédente / suivante
      const photos = ctx.photos();
      const start = photos.findIndex((p) => p.id === m.id);
      openViewer(frame, ctx.chatName(), start < 0 ? [m] : photos, Math.max(0, start), ctx.loader, ctx.toast);
    });
    frame.add_controller(click);
  }
  return frame;
}

/** Message supprimé pour tous : mention seule (pas de média, de citation ni de réactions). */
function DeletedBubble(ctx: BubbleContext, m: Message, msg: () => Message, live: Accessor<Item>): Gtk.Widget {
  return asWidget(
    <Gtk.Box name={`m:${m.id}`} orientation={Gtk.Orientation.VERTICAL} halign={m.fromMe ? Gtk.Align.END : Gtk.Align.START} marginStart={m.fromMe ? 64 : 0} marginEnd={m.fromMe ? 0 : 64}>
      <Gtk.Box
        orientation={Gtk.Orientation.VERTICAL}
        spacing={2}
        cssClasses={['bubble', m.fromMe ? 'outgoing' : 'incoming', 'deleted']}
        $={(self: Gtk.Box) => {
          attachBubbleMenu(ctx, self, msg);
        }}
      >
        <Gtk.Label visible={live((it) => it.kind === 'message' && it.showSender)} useMarkup label={`<span foreground="${senderColor(m.sender ?? '')}">${esc(m.senderName ?? '')}</span>`} xalign={0} cssClasses={['caption-heading']} />
        <Gtk.Box spacing={6}>
          <Gtk.Image iconName="action-unavailable-symbolic" cssClasses={['dim-label']} />
          <Gtk.Label label={m.fromMe ? 'Vous avez supprimé ce message' : DELETED_TEXT} xalign={0} cssClasses={['dim-label', 'deleted-text']} />
        </Gtk.Box>
        <Gtk.Label label={fmtTime(m.timestamp)} halign={Gtk.Align.END} cssClasses={['caption', 'dim-label']} />
      </Gtk.Box>
    </Gtk.Box>,
  );
}

/** Média à vue unique : inaccessible depuis un appareil lié, à ouvrir sur le téléphone. */
function ViewOnceView(m: Message): Gtk.Widget {
  const box = new Gtk.Box({ spacing: 10, marginTop: 4, marginBottom: 2, cssClasses: ['view-once'] });
  box.append(new Gtk.Image({ iconName: m.kind === 'video' ? 'camera-video-symbolic' : m.kind === 'audio' ? 'audio-input-microphone-symbolic' : 'camera-photo-symbolic', pixelSize: 22 }));
  const texts = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, valign: Gtk.Align.CENTER });
  texts.append(new Gtk.Label({ label: viewOnceLabel(m.kind), xalign: 0, cssClasses: ['heading'] }));
  texts.append(new Gtk.Label({ label: m.fromMe ? 'Envoyée depuis votre téléphone' : 'À ouvrir sur votre téléphone', xalign: 0, cssClasses: ['caption', 'dim-label'] }));
  box.append(texts);
  return box;
}

/**
 * Bandeau des messages épinglés (en haut de la conversation) : le message affiché, son auteur et
 * sa position (« 1/3 ») ; un clic amène le message à l'écran puis passe au suivant, comme WhatsApp.
 */
function PinnedBar(store: Store, go: (m: Message) => void): Gtk.Widget {
  const bar = new Gtk.Button({ cssClasses: ['flat', 'pinned-bar'], visible: false, tooltipText: 'Aller au message épinglé' });
  const box = new Gtk.Box({ spacing: 10 });
  box.append(new Gtk.Image({ iconName: 'view-pin-symbolic' }));
  const texts = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, hexpand: true });
  const head = new Gtk.Label({ xalign: 0, cssClasses: ['caption-heading', 'accent'] });
  const text = new Gtk.Label({ xalign: 0, ellipsize: Pango.EllipsizeMode.END, singleLineMode: true });
  texts.append(head);
  texts.append(text);
  box.append(texts);
  bar.child = box;
  let index = 0;
  const show = (): void => {
    const pins = store.pins.peek();
    bar.visible = pins.length > 0;
    if (pins.length === 0) return;
    if (index >= pins.length) index = 0;
    const m = pins[index];
    if (m === undefined) return;
    const who = m.fromMe ? 'Vous' : (m.senderName ?? '');
    head.label = `Message épinglé${pins.length > 1 ? ` ${index + 1}/${pins.length}` : ''}${who === '' ? '' : ` · ${who}`}`;
    text.label = quotePreview(m);
    bar.update_property([Gtk.AccessibleProperty.LABEL], [`Message épinglé : ${text.label}`]);
  };
  bar.connect('clicked', () => {
    const m = store.pins.peek()[index];
    if (m === undefined) return;
    go(m);
    // suivant (le plus ancien après le plus récent), comme WhatsApp
    index += 1;
    show();
  });
  // même liste (message modifié, réaction) : position gardée ; autre liste : premier
  let ids = '';
  onCleanup(
    store.pins.subscribe(() => {
      const next = store.pins.peek().map((p) => p.id).join(',');
      if (next !== ids) index = 0;
      ids = next;
      show();
    }),
  );
  show();
  return bar;
}

/** Récapitulatif des votes d'un sondage : chaque option, son nombre de votes et les votants. */
function openPollVotes(parent: Gtk.Widget, pictures: Pictures, me: string | null, m: Message): void {
  const poll = m.poll;
  if (poll === null) return;
  const page = new Adw.PreferencesPage();
  const head = new Adw.PreferencesGroup({ title: m.text, description: poll.voters === 1 ? '1 personne a voté' : `${poll.voters} personnes ont voté` });
  page.add(head);
  // options les plus choisies d'abord (ordre du sondage à égalité)
  for (const o of poll.options.toSorted((a, b) => b.count - a.count)) {
    const group = new Adw.PreferencesGroup({ title: o.name, description: o.count === 0 ? 'Aucun vote' : o.count === 1 ? '1 vote' : `${o.count} votes` });
    for (const v of o.voters) {
      const row = new Adw.ActionRow({ title: v.name, ...(v.id === null ? { subtitle: 'Votre vote' } : {}) });
      // photo de la personne (initiales en attendant, ou sans photo)
      const avatar = new Adw.Avatar({ size: 32, text: v.name.replace(/^~\s*/u, ''), showInitials: true });
      // moi : ma photo de profil
      const id = v.id ?? me;
      if (id !== null) {
        const texture = pictures.texture(id);
        avatar.set_custom_image(texture.peek());
        const off = texture.subscribe(() => avatar.set_custom_image(texture.peek()));
        row.connect('destroy', off);
      }
      row.add_prefix(avatar);
      group.add(row);
    }
    page.add(group);
  }
  const view = new Adw.ToolbarView({ content: page });
  view.add_top_bar(new Adw.HeaderBar());
  const dialog = new Adw.Dialog({ title: 'Votes du sondage', child: view, contentWidth: 420, contentHeight: 520 });
  dialog.present(parent);
}

/** Nouvelle sélection après un clic sur une option (une seule réponse : remplacée, ou retirée). */
export function toggleVote(poll: Poll, option: string): string[] {
  const mine = poll.options.filter((o) => o.mine).map((o) => o.name);
  if (!poll.multiple) return mine.includes(option) ? [] : [option];
  return mine.includes(option) ? mine.filter((o) => o !== option) : [...mine, option];
}

/** Sondage : question, options (case ou bouton radio, barre, nombre, votants), mis à jour en direct. */
function PollView(ctx: BubbleContext, msg: () => Message, live: Accessor<Item>): Gtk.Widget {
  const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6, widthRequest: 280, cssClasses: ['poll'] });
  const render = (): void => {
    for (let c = box.get_first_child(); c !== null; c = box.get_first_child()) box.remove(c);
    const m = msg();
    const poll = m.poll;
    if (poll === null) return;
    box.append(new Gtk.Label({ label: m.text, xalign: 0, wrap: true, wrapMode: Pango.WrapMode.WORD_CHAR, cssClasses: ['heading'] }));
    box.append(new Gtk.Label({ label: poll.multiple ? 'Choisissez une ou plusieurs options' : 'Choisissez une option', xalign: 0, cssClasses: ['caption', 'dim-label'] }));
    const max = Math.max(1, ...poll.options.map((o) => o.count));
    for (const o of poll.options) {
      const row = new Gtk.Button({ cssClasses: ['flat', 'poll-option'] });
      const lines = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4 });
      const top = new Gtk.Box({ spacing: 8 });
      top.append(new Gtk.Image({ iconName: o.mine ? (poll.multiple ? 'checkbox-checked-symbolic' : 'radio-checked-symbolic') : poll.multiple ? 'checkbox-symbolic' : 'radio-symbolic', cssClasses: o.mine ? ['accent'] : [] }));
      top.append(new Gtk.Label({ label: o.name, xalign: 0, hexpand: true, wrap: true, wrapMode: Pango.WrapMode.WORD_CHAR }));
      top.append(new Gtk.Label({ label: String(o.count), cssClasses: ['caption', 'numeric'] }));
      lines.append(top);
      lines.append(new Gtk.ProgressBar({ fraction: o.count / max, cssClasses: ['poll-bar'] }));
      row.child = lines;
      row.tooltipText = o.voters.length === 0 ? 'Voter' : `${o.voters.map((v) => v.name).join(', ')}${o.mine ? '' : ' — cliquer pour voter'}`;
      row.update_property([Gtk.AccessibleProperty.LABEL], [`${o.name} : ${o.count} vote${o.count > 1 ? 's' : ''}${o.mine ? ' (le vôtre)' : ''}`]);
      // sélection relue au clic (vote précédent pas encore revenu : pas écrasé)
      row.connect('clicked', () => {
        const current = msg();
        if (current.poll !== null) ctx.vote(current, toggleVote(current.poll, o.name));
      });
      box.append(row);
    }
    const foot = new Gtk.Box({ spacing: 6 });
    foot.append(new Gtk.Label({ label: poll.voters === 0 ? 'Aucun vote' : poll.voters === 1 ? '1 personne a voté' : `${poll.voters} personnes ont voté`, xalign: 0, hexpand: true, cssClasses: ['caption', 'dim-label'] }));
    const details = new Gtk.Button({ label: 'Voir les votes', cssClasses: ['flat', 'caption'], sensitive: poll.voters > 0 });
    details.connect('clicked', () => openPollVotes(box, ctx.pictures, ctx.me(), msg()));
    foot.append(details);
    box.append(foot);
  };
  // redessiné seulement si le sondage change (pas pour un accusé ou une réaction)
  let shown = '';
  const update = (): void => {
    const next = JSON.stringify([msg().text, msg().poll]);
    if (next === shown) return;
    shown = next;
    render();
  };
  update();
  onCleanup(live.subscribe(update));
  return box;
}

/** Ligne d'un appel (manqué, refusé…), centrée comme un séparateur de jour. */
function CallLine(m: Message): Gtk.Widget {
  const missed = isMissedCall(m);
  const box = new Gtk.Box({ name: `m:${m.id}`, spacing: 6, halign: Gtk.Align.CENTER, marginTop: 4, marginBottom: 4, cssClasses: ['call-line', ...(missed ? ['missed'] : [])] });
  box.append(new Gtk.Image({ iconName: isVideoCall(m) ? 'camera-video-symbolic' : 'call-start-symbolic' }));
  const who = m.senderName === null ? '' : ` · ${m.senderName}`;
  box.append(new Gtk.Label({ label: `${m.text}${who} · ${fmtTime(m.timestamp)}`, cssClasses: ['caption'] }));
  return box;
}

function bubble(ctx: BubbleContext) {
  return (item: Item, live: Accessor<Item>): Gtk.Widget => {
    if (item.kind === 'day') return asWidget(<Gtk.Label label={item.label} halign={Gtk.Align.CENTER} marginTop={12} marginBottom={4} cssClasses={['day-separator', 'caption']} />);
    const m = item.message;
    const msg = (): Message => {
      const it = live.peek();
      return it.kind === 'message' ? it.message : m;
    };
    // groupe, message reçu : photo de l'auteur à gauche
    const author = (w: Gtk.Widget): Gtk.Widget => (item.group && !m.fromMe ? withAuthor(ctx, w, m, live) : w);
    if (m.deleted) return selectableRow(ctx, author(DeletedBubble(ctx, m, msg, live)), m.id, msg);
    if (m.kind === 'call') return CallLine(m);
    const picture = m.viewOnce ? ViewOnceView(m) : m.kind === 'poll' && m.poll !== null ? PollView(ctx, msg, live) : isPicture(m) ? MessagePicture(ctx, m) : mediaView(ctx, m);
    // autocollant : sans bulle, comme dans WhatsApp
    const bare = picture !== null && m.kind === 'sticker';
    // émojis seuls (sans citation ni « Transféré ») : en grand, sans fond de bulle, comme WhatsApp
    const plain = picture === null && m.quoted === null && m.forwarded === 0;
    const emojiClasses = (): string[] => (plain ? bigEmoji(msg()) : []);
    const classes = bare ? ['sticker'] : ['bubble', m.fromMe ? 'outgoing' : 'incoming', ...(picture === null ? [] : ['with-media'])];
    return selectableRow(ctx, author(asWidget(
      <Gtk.Box name={`m:${m.id}`} orientation={Gtk.Orientation.VERTICAL} halign={m.fromMe ? Gtk.Align.END : Gtk.Align.START} marginStart={m.fromMe ? 64 : 0} marginEnd={m.fromMe ? 0 : 64}>
        <Gtk.Box
          orientation={Gtk.Orientation.VERTICAL}
          spacing={2}
          cssClasses={classes}
          $={(self: Gtk.Box) => {
            attachBubbleMenu(ctx, self, msg);
            // suivi des modifications (texte devenu ou n'étant plus un émoji seul)
            const sync = (): void => {
              if (emojiClasses().length > 0) self.add_css_class('emoji-only');
              else self.remove_css_class('emoji-only');
            };
            sync();
            onCleanup(live.subscribe(sync));
          }}
        >
          <Gtk.Label
            visible={live((it) => it.kind === 'message' && it.showSender)}
            useMarkup
            // couleur propre à chaque participant (comme WhatsApp)
            label={live(() => `<span foreground="${senderColor(msg().sender ?? '')}">${esc(msg().senderName ?? msg().sender?.split('@')[0] ?? '')}</span>`)}
            xalign={0}
            cssClasses={['caption-heading']}
          />
          {m.forwarded === 0 ? null : ForwardedMark(m.forwarded)}
          {m.quoted === null ? null : QuoteBlock(ctx, m.quoted)}
          {picture}
          <Gtk.Label
            visible={live(() => (picture === null || msg().text !== '') && msg().kind !== 'poll')}
            // mise en forme WhatsApp (gras, italique, code, citations, listes)
            useMarkup
            label={live(() => (msg().kind === 'text' || picture !== null ? mentionMarkup(waMarkup(msg().text), msg().mentions) : esc(previewOf(msg()))))}
            cssClasses={live(() => (msg().kind === 'text' || picture !== null ? ['body', ...emojiClasses()] : ['body', 'dim-label']))}
            wrap
            wrapMode={Pango.WrapMode.WORD_CHAR}
            xalign={0}
            selectable
            // sous une image : la légende prend la largeur de l'image au lieu d'élargir la bulle
            maxWidthChars={picture === null ? 60 : 1}
            // liens : ouverts dans le navigateur par défaut
            $={(self: Gtk.Label) => openLinks(self)}
          />
          {TranslationView(m)}
          <Gtk.Box spacing={4} halign={Gtk.Align.END}>
            <Gtk.Label label="Modifié" visible={live(() => msg().edited)} tooltipText="Message modifié par son auteur" cssClasses={['caption', 'dim-label', 'edited-mark']} />
            <Gtk.Label label={live(() => fmtTime(msg().timestamp))} cssClasses={['caption', 'dim-label']} />
            {/* coches des messages envoyés */}
            <Gtk.Label
              visible={live(() => msg().status !== null)}
              label={live(() => STATUS_MARK[msg().status ?? 'sent'])}
              tooltipText={live(() => `${STATUS_TEXT[msg().status ?? 'sent']} — infos du message`)}
              cssClasses={live(() => ['caption', 'ticks', msg().status ?? 'sent'])}
              $={(self: Gtk.Label) => {
                // clic sur les coches : infos du message (comme WhatsApp Web)
                self.set_cursor_from_name('pointer');
                const click = new Gtk.GestureClick();
                click.connect('released', () => ctx.info(msg()));
                self.add_controller(click);
              }}
            />
          </Gtk.Box>
        </Gtk.Box>
        {ReactionsRow(ctx, msg, (fn) => live.subscribe(fn), m.fromMe)}
      </Gtk.Box>,
    )), m.id, msg);
  };
}

/** Suppression d'un message, après confirmation (comme WhatsApp). */
function confirmRemove(parent: Gtk.Widget, store: Store, m: Message, action: 'revoke' | 'delete-for-me', toast: (t: string) => void): void {
  const forAll = action === 'revoke';
  const dialog = new Adw.AlertDialog({
    heading: forAll ? 'Supprimer pour tous ?' : 'Supprimer pour moi ?',
    body: forAll ? 'Le message sera remplacé par « Ce message a été supprimé » pour tous les participants.' : 'Le message sera supprimé de cet ordinateur et de vos autres appareils. Les autres participants le verront toujours.',
  });
  dialog.add_response('cancel', 'Annuler');
  dialog.add_response('ok', 'Supprimer');
  dialog.set_response_appearance('ok', Adw.ResponseAppearance.DESTRUCTIVE);
  dialog.connect('response', (_d: Adw.AlertDialog, response: string) => {
    if (response !== 'ok') return;
    store.client.messageAction(m.chatId, m.id, { action }).catch((error: unknown) => toast(`Suppression impossible : ${errorMessage(error)}`));
  });
  dialog.present(parent);
}

/** Composer : `register` reçoit la fonction d'ajout de fichiers (dépôt sur toute la conversation). */
function Composer({ store, chatId, toast, register, pictures }: { store: Store; chatId: Accessor<string | null>; toast: (text: string) => void; register: (add: (files: Gio.File[]) => void) => void; pictures: Pictures }): JSX.Element {
  /** mentions (@) de la zone de saisie, créée avec elle */
  let mentions: MentionPicker | null = null;
  const [sending, setSending] = createState(false);
  const [attachments, setAttachments] = createState<readonly Attachment[]>([]);
  // « document » : fichiers envoyés tels quels (pas de compression des photos par WhatsApp)
  const [asDocument, setAsDocument] = createState(false);
  let view: Gtk.TextView | null = null;
  /** ma saisie annoncée à WhatsApp : « écrit… » au plus toutes les 8 s, pause après 4 s sans frappe */
  let composing = 0;
  let pauseTimer = 0;
  /** discussion où « écrit… » a été annoncé (la pause lui est envoyée, même après un changement) */
  let typingIn: string | null = null;
  const stopTyping = (): void => {
    if (pauseTimer !== 0) GLib.source_remove(pauseTimer);
    pauseTimer = 0;
    const id = typingIn;
    typingIn = null;
    if (composing !== 0 && id !== null) void store.client.typing(id, 'paused').catch((error: unknown) => console.error(`saisie : ${errorMessage(error)}`));
    composing = 0;
  };
  const typed = (): void => {
    if (restoring) return;
    const id = chatId.peek();
    if (id === null || store.editing.peek() !== null || view?.buffer.text.trim() === '') {
      stopTyping();
      return;
    }
    const now = GLib.get_monotonic_time();
    if (now - composing > 8_000_000 || typingIn !== id) {
      composing = now;
      typingIn = id;
      void store.client.typing(id, 'composing').catch((error: unknown) => console.error(`saisie : ${errorMessage(error)}`));
    }
    if (pauseTimer !== 0) GLib.source_remove(pauseTimer);
    pauseTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 4000, () => {
      pauseTimer = 0;
      stopTyping();
      return GLib.SOURCE_REMOVE;
    });
  };
  /** texte placé dans la saisie au début d'une modification (retiré si elle est abandonnée) */
  let editedText: string | null = null;
  /** texte posé par l'app (brouillon, modification) : ni « écrit… » ni brouillon enregistré */
  let restoring = false;
  const setText = (text: string): void => {
    if (view === null) return;
    restoring = true;
    view.buffer.set_text(text, -1);
    view.buffer.place_cursor(view.buffer.get_end_iter());
    restoring = false;
  };
  /** Fin d'une modification : le brouillon de la discussion revient dans la saisie. */
  const endEditing = (): void => {
    store.setEditing(null);
    const id = chatId.peek();
    setText(id === null ? '' : (store.drafts.peek().get(id) ?? ''));
  };
  /** zone de saisie vide (bouton micro à la place d'Envoyer) */
  const [empty, setEmpty] = createState(true);

  // ---------------------------------------------------------------- message vocal
  const [recording, setRecording] = createState<{ seconds: number; level: number } | null>(null);
  let recorder: Recorder | null = null;
  /** « enregistre un audio… » annoncé au correspondant (toutes les 8 s) */
  let recordingAnnounced = 0;
  const startRecording = (): void => {
    const id = chatId.peek();
    if (id === null || recorder !== null) return;
    try {
      const r = new Recorder();
      r.onLevel = (db, seconds) => {
        // relevés reçus après l'envoi ou l'abandon (fin du flux) : ignorés
        if (recorder !== r) return;
        setRecording({ seconds, level: Math.max(0, Math.min(1, (db + 50) / 50)) });
        const now = GLib.get_monotonic_time();
        if (now - recordingAnnounced > 8_000_000) {
          recordingAnnounced = now;
          void store.client.typing(id, 'recording').catch((error: unknown) => console.error(`saisie : ${errorMessage(error)}`));
        }
      };
      r.onError = (message) => {
        if (recorder !== r) return;
        toast(`Enregistrement impossible : ${message}`);
        recorder = null;
        setRecording(null);
      };
      r.start();
      recorder = r;
      setRecording({ seconds: 0, level: 0 });
    } catch (error) {
      toast(`Enregistrement impossible : ${errorMessage(error)}`);
    }
  };
  const endRecording = (id: string | null): void => {
    recorder = null;
    recordingAnnounced = 0;
    setRecording(null);
    if (id !== null) void store.client.typing(id, 'paused').catch((error: unknown) => console.error(`saisie : ${errorMessage(error)}`));
  };
  const cancelRecording = (): void => {
    recorder?.cancel();
    endRecording(chatId.peek());
  };
  const sendRecording = (): void => {
    const r = recorder;
    const id = chatId.peek();
    if (r === null || id === null) return;
    endRecording(id);
    setSending(true);
    void (async (): Promise<void> => {
      try {
        const rec = await r.stop();
        if (rec === null) return;
        const replyTo = store.replyTo.peek()?.id;
        await store.client.sendFile(id, { bytes: rec.bytes, mimetype: 'audio/ogg; codecs=opus', name: 'vocal.ogg', caption: '', asDocument: false, voice: { seconds: rec.seconds, waveform: rec.waveform }, ...(replyTo === undefined ? {} : { replyTo }) });
        store.setReplyTo(null);
      } catch (error) {
        toast(`Envoi du vocal impossible : ${errorMessage(error)}`);
      } finally {
        setSending(false);
      }
    })();
  };
  // autre discussion : enregistrement abandonné
  onCleanup(chatId.subscribe(() => {
    if (recorder !== null) cancelRecording();
  }));

  const addFiles = (files: Gio.File[], textures: Gdk.Texture[] = []): void => {
    for (const t of textures) setAttachments([...attachments.peek(), fromTexture(t)]);
    for (const f of files) {
      fromFile(f)
        .then((a) => setAttachments([...attachments.peek(), a]))
        .catch((error: unknown) => toast(`Fichier ignoré : ${errorMessage(error)}`));
    }
  };

  /** Programme le texte saisi pour `at` (secondes) ; la saisie est vidée. */
  const scheduleText = (at: number): void => {
    const id = chatId.peek();
    const buffer = view?.buffer;
    if (id === null || buffer === undefined) return;
    const text = buffer.text.trim();
    if (text === '') return;
    if (at <= Date.now() / 1000 + 30) {
      toast('Choisissez une heure à venir');
      return;
    }
    const replyTo = store.replyTo.peek()?.id;
    const out = resolveMentions(text, mentions?.chosen(id) ?? new Map<string, string>());
    void (async (): Promise<void> => {
      try {
        await store.client.schedule(id, out.text, at, replyTo, out.mentions);
        mentions?.sent(id);
        store.setDraft(id, '');
        if (chatId.peek() === id) buffer.set_text('', -1);
        store.setReplyTo(null);
        toast(`Message programmé pour ${fmtDateTime(at)}`);
      } catch (error) {
        toast(`Programmation impossible : ${errorMessage(error)}`);
      }
    })();
  };
  const send = (): void => {
    const id = chatId.peek();
    const buffer = view?.buffer;
    if (id === null || buffer === undefined || sending.peek()) return;
    const text = buffer.text.trim();
    const files = attachments.peek();
    // modification d'un de mes messages : nouveau texte à la place de l'ancien
    const editing = store.editing.peek();
    if (editing !== null) {
      if (files.length > 0) toast('Pièces jointes ignorées pendant une modification');
      if (text === '' || text === editing.text) {
        endEditing();
        return;
      }
      setSending(true);
      const edit = async (): Promise<void> => {
        try {
          await store.client.messageAction(editing.chatId, editing.id, { action: 'edit', text });
          if (chatId.peek() === editing.chatId) endEditing();
          else store.setEditing(null);
        } catch (error) {
          toast(`Modification impossible : ${errorMessage(error)}`);
        } finally {
          setSending(false);
          view?.grab_focus();
        }
      };
      void edit();
      return;
    }
    if (text === '' && files.length === 0) return;
    stopTyping();
    setSending(true);
    // réponse : portée par le message texte, ou par le premier fichier
    const replyTo = store.replyTo.peek()?.id;
    const run = async (): Promise<void> => {
      // le texte sert de légende au premier fichier (comme WhatsApp)
      for (const [i, f] of files.entries()) {
        // oxlint-disable-next-line no-await-in-loop -- envois dans l'ordre choisi
        await store.client.sendFile(id, { bytes: f.bytes, mimetype: f.mimetype, name: f.name, caption: i === 0 ? text : '', asDocument: asDocument.peek(), ...(i === 0 && replyTo !== undefined ? { replyTo } : {}) });
        setAttachments(attachments.peek().filter((x) => x.id !== f.id));
      }
      if (files.length === 0) {
        // « @Nom » choisis : « @numéro » et personnes mentionnées
        const out = resolveMentions(text, mentions?.chosen(id) ?? new Map<string, string>());
        await store.send(id, out.text, replyTo, out.mentions);
        mentions?.sent(id);
      }
      // envoyé : brouillon vidé (autre discussion affichée entre-temps : la saisie n'est pas touchée)
      store.setDraft(id, '');
      if (chatId.peek() === id) buffer.set_text('', -1);
      store.setReplyTo(null);
    };
    run()
      .catch((error: unknown) => toast(`Envoi impossible : ${errorMessage(error)}`))
      .finally(() => {
        setSending(false);
        setAsDocument(false);
        view?.grab_focus();
      });
  };
  return (
    <Gtk.Box
      orientation={Gtk.Orientation.VERTICAL}
      spacing={6}
      marginStart={12}
      marginEnd={12}
      marginTop={6}
      marginBottom={12}
      cssClasses={['composer']}
      $={() => {
        register((files) => addFiles(files));
        // réponse choisie : saisie au premier plan
        onCleanup(
          store.replyTo.subscribe(() => {
            if (store.replyTo.peek() === null) return;
            // répondre pendant une modification : la modification est abandonnée
            if (store.editing.peek() !== null) endEditing();
            view?.grab_focus();
          }),
        );
        // modification : texte d'origine dans la saisie, curseur à la fin ; pas de réponse en même temps
        onCleanup(
          store.editing.subscribe(() => {
            const m = store.editing.peek();
            if (view === null) return;
            // modification terminée sans envoi (autre discussion, message supprimé) : texte retiré
            if (m === null) {
              if (editedText !== null && view.buffer.text === editedText) setText('');
              editedText = null;
              return;
            }
            editedText = m.text;
            store.setReplyTo(null);
            setText(m.text);
            view.grab_focus();
          }),
        );
        // autre discussion : pièces jointes abandonnées, saisie terminée
        onCleanup(
          chatId.subscribe(() => {
            // autre discussion : pause envoyée à celle que l'on quitte
            stopTyping();
            setAttachments([]);
            setAsDocument(false);
          }),
        );
      }}
    >
      {/* modification en cours : texte d'origine, annulable (croix, Échap) */}
      <Gtk.Box spacing={8} visible={store.editing((m) => m !== null)} cssClasses={['reply-banner']}>
        <Gtk.Image iconName="document-edit-symbolic" valign={Gtk.Align.CENTER} cssClasses={['accent']} />
        <Gtk.Box orientation={Gtk.Orientation.VERTICAL} hexpand>
          <Gtk.Label label={store.editing((m) => (m === null || m.kind === 'text' ? 'Modification du message' : 'Modification de la légende'))} xalign={0} cssClasses={['caption-heading', 'accent']} />
          <Gtk.Label label={store.editing((m) => m?.text.replaceAll('\n', ' ') ?? '')} xalign={0} ellipsize={Pango.EllipsizeMode.END} cssClasses={['caption']} />
        </Gtk.Box>
        <Gtk.Button
          iconName="window-close-symbolic"
          tooltipText="Annuler la modification (Échap)"
          valign={Gtk.Align.CENTER}
          cssClasses={['flat', 'circular']}
          onClicked={endEditing}
        />
      </Gtk.Box>
      {/* réponse en cours : message cité, annulable (croix, Échap) */}
      <Gtk.Box spacing={8} visible={store.replyTo((r) => r !== null)} cssClasses={['reply-banner']}>
        <Gtk.Image iconName="mail-reply-sender-symbolic" valign={Gtk.Align.CENTER} cssClasses={['accent']} />
        <Gtk.Box orientation={Gtk.Orientation.VERTICAL} hexpand>
          <Gtk.Label
            label={store.replyTo((r) => (r === null ? '' : `Réponse à ${r.fromMe ? 'vous-même' : (r.senderName ?? store.chat(r.chatId)?.name ?? '')}`))}
            xalign={0}
            ellipsize={Pango.EllipsizeMode.END}
            cssClasses={['caption-heading', 'accent']}
          />
          <Gtk.Label label={store.replyTo((r) => (r === null ? '' : quotePreview(r)))} xalign={0} ellipsize={Pango.EllipsizeMode.END} cssClasses={['caption']} />
        </Gtk.Box>
        <Gtk.Button iconName="window-close-symbolic" tooltipText="Annuler la réponse (Échap)" valign={Gtk.Align.CENTER} cssClasses={['flat', 'circular']} onClicked={() => store.setReplyTo(null)} />
      </Gtk.Box>
      {/* messages programmés de la discussion (annulables) */}
      {ScheduledBar(store, toast)}
      <Gtk.Box spacing={6} visible={attachments((l) => l.length > 0)}>
        <Gtk.ScrolledWindow hexpand vscrollbarPolicy={Gtk.PolicyType.NEVER} propagateNaturalHeight>
          <Gtk.Box
            spacing={6}
            $={(self: Gtk.Box) => {
              onCleanup(keyedBox(self, attachments, (a) => String(a.id), (a) => attachmentChip(a, () => setAttachments(attachments.peek().filter((x) => x.id !== a.id)))));
            }}
          />
        </Gtk.ScrolledWindow>
        <Gtk.ToggleButton
          label="Comme fichier"
          tooltipText="Envoyer les photos et vidéos comme fichiers, sans compression"
          valign={Gtk.Align.CENTER}
          active={asDocument}
          visible={attachments((l) => l.some((a) => uploadKind(a.mimetype) !== 'document'))}
          cssClasses={['flat', 'caption']}
          onToggled={(b: Gtk.ToggleButton) => setAsDocument(b.active)}
        />
      </Gtk.Box>
      {/* enregistrement d'un vocal : durée, niveau, annuler, envoyer */}
      <Gtk.Box spacing={10} visible={recording((r) => r !== null)} cssClasses={['recording-bar']}>
        <Gtk.Button iconName="user-trash-symbolic" tooltipText="Annuler le vocal" valign={Gtk.Align.CENTER} cssClasses={['circular', 'flat']} onClicked={cancelRecording} />
        <Gtk.Image iconName="media-record-symbolic" cssClasses={['recording-dot']} />
        <Gtk.Label label={recording((r) => fmtRecording(r?.seconds ?? 0))} cssClasses={['numeric']} widthChars={5} xalign={0} />
        <Gtk.LevelBar hexpand valign={Gtk.Align.CENTER} heightRequest={6} value={recording((r) => r?.level ?? 0)} cssClasses={['recording-level']} />
        <Gtk.Button iconName="mail-send-symbolic" tooltipText="Envoyer le vocal" valign={Gtk.Align.CENTER} cssClasses={['circular', 'suggested-action']} onClicked={sendRecording} />
      </Gtk.Box>
      <Gtk.Box spacing={6} visible={recording((r) => r === null)}>
        {/* émojis : insérés à la position du curseur */}
        <Gtk.MenuButton
          iconName="face-smile-symbolic"
          tooltipText="Émojis"
          valign={Gtk.Align.END}
          sensitive={sending((s) => !s)}
          cssClasses={['circular', 'flat']}
          direction={Gtk.ArrowType.UP}
          $={(self: Gtk.MenuButton) => {
            const chooser = new Gtk.EmojiChooser();
            chooser.connect('emoji-picked', (_c: Gtk.EmojiChooser, text: string) => {
              if (view === null) return;
              // texte sélectionné : remplacé par l'émoji (comme une frappe)
              view.buffer.delete_selection(true, true);
              view.buffer.insert_at_cursor(text, -1);
              view.grab_focus();
            });
            self.popover = chooser;
          }}
        />
        <Gtk.Button
          iconName="mail-attachment-symbolic"
          tooltipText="Joindre des fichiers"
          valign={Gtk.Align.END}
          sensitive={sending((s) => !s)}
          cssClasses={['circular', 'flat']}
          onClicked={(b: Gtk.Button) => {
            pickFiles(b)
              .then((files) => addFiles(files))
              .catch((error: unknown) => toast(errorMessage(error)));
          }}
        />
        <Gtk.ScrolledWindow hexpand propagateNaturalHeight maxContentHeight={160} hscrollbarPolicy={Gtk.PolicyType.NEVER} cssClasses={['composer-entry']}>
          <Gtk.TextView
            wrapMode={Gtk.WrapMode.WORD_CHAR}
            topMargin={8}
            bottomMargin={8}
            leftMargin={10}
            rightMargin={10}
            sensitive={sending((s) => !s)}
            tooltipText="Message (Entrée : envoyer, Maj+Entrée : nouvelle ligne)"
            $={(self: Gtk.TextView) => {
              view = self;
              const picker = mentionPicker(self, store, pictures, () => chatId.peek());
              mentions = picker;
              self.buffer.connect('changed', () => {
                if (!restoring) picker.update();
              });
              // liste des membres ouverte : flèches, Entrée, Tab et Échap pour elle (avant la zone)
              const pickerKeys = new Gtk.EventControllerKey({ propagationPhase: Gtk.PropagationPhase.CAPTURE });
              pickerKeys.connect('key-pressed', (_c: Gtk.EventControllerKey, keyval: number) => picker.key(keyval));
              self.add_controller(pickerKeys);
              const keys = new Gtk.EventControllerKey();
              keys.connect('key-pressed', (_c: Gtk.EventControllerKey, keyval: number, _code: number, state: Gdk.ModifierType) => {
                if (keyval === Gdk.KEY_Escape && store.editing.peek() !== null) {
                  endEditing();
                  return true;
                }
                if (keyval === Gdk.KEY_Escape && store.replyTo.peek() !== null) {
                  store.setReplyTo(null);
                  return true;
                }
                if ((keyval !== Gdk.KEY_Return && keyval !== Gdk.KEY_KP_Enter) || (state & Gdk.ModifierType.SHIFT_MASK) !== 0) return false;
                send();
                return true;
              });
              self.add_controller(keys);
              self.buffer.connect('changed', typed);
              self.buffer.connect('changed', () => setEmpty(self.buffer.text.trim() === ''));
              // brouillon de la discussion affichée (pas pendant la modification d'un message)
              let shown = chatId.peek();
              self.buffer.connect('changed', () => {
                if (!restoring && shown !== null && store.editing.peek() === null) store.setDraft(shown, self.buffer.text);
              });
              // Ctrl+V : fichiers ou image du presse-papier en pièces jointes, sinon collage du texte
              self.connect('paste-clipboard', () => {
                if (pasteAttachments(self, addFiles, toast)) GObject.signal_stop_emission_by_name(self, 'paste-clipboard');
              });
              // « Répondre » d'une notification : focus dans la zone (même discussion déjà ouverte)
              onCleanup(
                store.focusRequests.subscribe(() => {
                  GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                    self.grab_focus();
                    return GLib.SOURCE_REMOVE;
                  });
                }),
              );
              // autre discussion : son brouillon (ou rien), focus dans la zone
              onCleanup(
                chatId.subscribe(() => {
                  shown = chatId.peek();
                  picker.close();
                  // brouillon remis sans annoncer « écrit… » au contact
                  setText(shown === null ? '' : (store.drafts.peek().get(shown) ?? ''));
                  self.grab_focus();
                }),
              );
            }}
          />
        </Gtk.ScrolledWindow>
        {/* zone vide sans pièce jointe : micro (message vocal) ; sinon Envoyer */}
        {/* programmer l'envoi du texte saisi (pas de pièce jointe, pas pendant une modification) */}
        <Gtk.Box
          valign={Gtk.Align.END}
          visible={createMemo(() => !empty() && attachments().length === 0 && store.editing() === null)}
          $={(self: Gtk.Box) => {
            self.append(scheduleButton(scheduleText));
          }}
        />
        <Gtk.Stack valign={Gtk.Align.END} visibleChildName={createMemo(() => (empty() && attachments().length === 0 && store.editing() === null ? 'mic' : 'send'))} transitionType={Gtk.StackTransitionType.CROSSFADE}>
          <Gtk.Button $type="named" name="send" iconName="mail-send-symbolic" tooltipText="Envoyer" sensitive={sending((s) => !s)} cssClasses={['circular', 'suggested-action']} onClicked={send} />
          <Gtk.Button $type="named" name="mic" iconName="audio-input-microphone-symbolic" tooltipText="Enregistrer un message vocal" sensitive={sending((s) => !s)} cssClasses={['circular', 'suggested-action']} onClicked={startRecording} />
        </Gtk.Stack>
      </Gtk.Box>
    </Gtk.Box>
  );
}

export function ConversationPage({ store, pictures, toast, panels }: { store: Store; pictures: Pictures; toast: (text: string) => void; panels?: (split: Adw.OverlaySplitView) => void }): JSX.Element {
  const chat = createMemo(() => {
    const id = store.current();
    // nom et type suivis : la liste des discussions est mise à jour en direct
    const c = id === null ? undefined : store.chats().find((x) => x.id === id);
    return id === null ? null : { id, name: c?.name ?? store.nameHint(id) ?? id.split('@')[0] ?? id, group: c?.group ?? id.endsWith('@g.us'), ephemeral: c?.ephemeral ?? 0 };
  });
  const items = createMemo(() => itemsOf(store.messages(), chat()?.group ?? false));
  const loader = new MediaLoader(store.client);
  /** fenêtre défilante de la conversation (défilement vers un message cité) */
  let scroller: Gtk.ScrolledWindow | null = null;
  /** Message `id` à l'écran (s'il est chargé), brièvement mis en évidence. */
  const scrollToMessage = (box: Gtk.Box, id: string, flash = true): boolean => {
    let target: Gtk.Widget | null = null;
    for (let c = box.get_first_child(); c !== null; c = c.get_next_sibling()) if (c.name === `m:${id}`) target = c;
    if (target === null || scroller === null) return false;
    const [ok, bounds] = target.compute_bounds(box);
    if (!ok) return false;
    const adj = scroller.vadjustment;
    adj.value = Math.max(0, bounds.get_y() + bounds.get_height() / 2 - adj.pageSize / 2);
    if (!flash) return true;
    const bubbleBox = findBubble(target);
    bubbleBox?.add_css_class('flash');
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
      bubbleBox?.remove_css_class('flash');
      return GLib.SOURCE_REMOVE;
    });
    return true;
  };
  /** panneau de recherche dans la discussion ouvert */
  const [searching, setSearching] = createState(false);
  /** panneau des résumés (IA) ouvert ; un seul panneau à droite à la fois */
  const [summarizing, setSummarizing] = createState(false);
  onCleanup(
    searching.subscribe(() => {
      if (searching.peek()) setSummarizing(false);
    }),
  );
  onCleanup(
    summarizing.subscribe(() => {
      if (summarizing.peek()) setSearching(false);
    }),
  );
  const summariesKey = createMemo(() => summaryKey(store.client.account, store.current() ?? ''));
  /** boîte des bulles (défilement vers un message trouvé par la recherche) */
  let conversation: Gtk.Box | null = null;
  /** ajout de pièces jointes du composer (renseigné à sa création) */
  let dropFiles: ((files: Gio.File[]) => void) | null = null;
  // sélection de messages : vidée au changement de discussion, messages disparus retirés
  const [selection, setSelection] = createState<ReadonlySet<string>>(new Set());
  const clearSelection = (): void => setSelection(new Set());
  onCleanup(store.current.subscribe(clearSelection));
  onCleanup(
    store.messages.subscribe(() => {
      const sel = selection.peek();
      if (sel.size === 0) return;
      const live = new Set(store.messages.peek().map((m) => m.id));
      if ([...sel].some((id) => !live.has(id))) setSelection(new Set([...sel].filter((id) => live.has(id))));
    }),
  );
  const toggleSelect = (m: Message): void => {
    const next = new Set(selection.peek());
    if (next.has(m.id)) next.delete(m.id);
    else next.add(m.id);
    setSelection(next);
  };
  /**
   * Traduit des messages l'un après l'autre (vocaux : transcription d'abord) ; modèle de
   * transcription absent : téléchargement proposé, puis nouvel essai.
   */
  const translateAll = (parent: Gtk.Widget, list: readonly Message[], mode: 'translate' | 'transcribe', lang?: string | null): void => {
    // langue choisie à la main : retenue pour les vocaux suivants de la discussion
    if (lang !== undefined) for (const id of new Set(list.map((m) => m.chatId))) setChatVoiceLanguage(id, lang);
    const todo = list.filter((m) => !m.deleted && m.kind !== 'call' && (m.kind === 'audio' ? m.media !== null : m.text.trim() !== ''));
    if (todo.length === 0) {
      toast('Rien à traduire dans ces messages');
      return;
    }
    void (async (): Promise<void> => {
      for (const [i, m] of todo.entries()) {
        const media = m.media;
        try {
          // oxlint-disable-next-line no-await-in-loop -- une traduction à la fois (outil de l'utilisateur)
          await translateMessage(m, { ...(m.kind === 'audio' && media !== null ? { file: () => loader.file(m, media) } : {}), translate: mode === 'translate', ...(lang === undefined ? {} : { lang }) });
        } catch (error) {
          if (error instanceof MissingModel) {
            // modèle téléchargé : reprise à partir de ce vocal (les précédents sont déjà traduits)
            offerWhisperDownload(parent, error.model, toast, () => translateAll(parent, todo.slice(i), mode, lang));
            return;
          }
        }
      }
    })();
  };
  /** Épingle le message pour `duration` secondes, ou le désépingle (null). */
  const pinMessage = (m: Message, duration: number | null): void => {
    store.client.messageAction(m.chatId, m.id, duration === null ? { action: 'pin', value: false } : { action: 'pin', value: true, duration }).then(
      () => toast(duration === null ? 'Message désépinglé' : 'Message épinglé'),
      (error: unknown) => toast(`Épinglage impossible : ${errorMessage(error)}`),
    );
  };
  /** messages sélectionnés, dans l'ordre de la discussion */
  const selected = (): Message[] => store.messages.peek().filter((m) => selection.peek().has(m.id));
  return (
    <Adw.NavigationPage title={chat((c) => c?.name ?? 'WhatsApp')} tag="conversation">
      <Adw.ToolbarView>
        <Adw.HeaderBar $type="top">
          {/* clic sur le nom : fiche du contact ou du groupe */}
          <Gtk.Button
            $type="title"
            cssClasses={['flat', 'chat-title']}
            sensitive={chat((c) => c !== null)}
            tooltipText={chat((c) => (c?.group === true ? 'Infos du groupe' : 'Infos du contact'))}
            onClicked={(b: Gtk.Button) => {
              const c = chat.peek();
              if (c === null) return;
              openChatInfo(b, store, pictures, c.id, c.name, { toast, search: () => setSearching(true), gallery: () => openGallery(b, store, loader, c.id, c.name, toast) });
            }}
          >
          <Gtk.Box spacing={10}>
            <Adw.Avatar
              visible={chat((c) => c !== null)}
              size={32}
              text={chat((c) => avatarText(c?.name ?? ''))}
              showInitials={chat((c) => /\p{L}/u.test(c?.name ?? ''))}
              $={(self: Adw.Avatar) =>
                bindAvatar(
                  self,
                  createMemo(() => {
                    const c = chat();
                    return c === null ? null : pictures.texture(c.id)();
                  }),
                )
              }
            />
            <Gtk.Box orientation={Gtk.Orientation.VERTICAL} valign={Gtk.Align.CENTER}>
              <Gtk.Box spacing={4}>
                <Gtk.Label label={chat((c) => c?.name ?? 'WhatsApp')} ellipsize={Pango.EllipsizeMode.END} xalign={0} cssClasses={['heading']} />
                {/* messages éphémères : minuterie de la discussion */}
                <Gtk.Image
                  iconName="alarm-symbolic"
                  visible={chat((c) => (c?.ephemeral ?? 0) > 0)}
                  tooltipText={chat((c) => `Messages éphémères : ${ephemeralText(c?.ephemeral ?? 0)}`)}
                  cssClasses={['dim-label']}
                  $={(self: Gtk.Image) => {
                    const sync = (): void => {
                      self.update_property([Gtk.AccessibleProperty.LABEL], [`Messages éphémères : ${ephemeralText(chat.peek()?.ephemeral ?? 0)}`]);
                    };
                    sync();
                    onCleanup(chat.subscribe(sync));
                  }}
                />
              </Gtk.Box>
              {/* présence : écrit…, en ligne, vu à … */}
              <Gtk.Label
                visible={createMemo(() => chat() !== null && presenceLine(store.presence(), chat()?.group ?? false) !== '')}
                label={createMemo(() => presenceLine(store.presence(), chat()?.group ?? false))}
                ellipsize={Pango.EllipsizeMode.END}
                xalign={0}
                cssClasses={createMemo(() => ['caption', (store.presence()?.typing.length ?? 0) > 0 ? 'accent' : 'dim-label'])}
              />
            </Gtk.Box>
          </Gtk.Box>
          </Gtk.Button>
          <Gtk.Button
            $type="end"
            iconName="folder-pictures-symbolic"
            tooltipText="Médias, documents et audio de la discussion"
            visible={chat((c) => c !== null)}
            onClicked={(b: Gtk.Button) => {
              const c = chat.peek();
              if (c !== null) openGallery(b, store, loader, c.id, c.name, toast);
            }}
          />
          <Gtk.ToggleButton
            $type="end"
            iconName="view-list-bullet-symbolic"
            tooltipText="Résumés (IA) de la discussion"
            visible={createMemo(() => chat() !== null && (summarizing() || (summaries().get(summariesKey())?.length ?? 0) > 0))}
            active={summarizing}
            onToggled={(b: Gtk.ToggleButton) => setSummarizing(b.active)}
          />
          <Gtk.ToggleButton
            $type="end"
            iconName="system-search-symbolic"
            tooltipText="Rechercher dans la discussion (Ctrl+F)"
            visible={chat((c) => c !== null)}
            active={searching}
            onToggled={(b: Gtk.ToggleButton) => setSearching(b.active)}
          />
        </Adw.HeaderBar>
        <Gtk.Stack visibleChildName={chat((c) => (c === null ? 'none' : 'chat'))} transitionType={Gtk.StackTransitionType.CROSSFADE}>
          <Adw.StatusPage $type="named" name="none" iconName="chat-message-new-symbolic" title="WhatsApp pour GNOME" description="Choisissez une discussion" />
          {/* panneau à droite (recherche, résumés) : à côté de la conversation, ou par-dessus si la
              place manque (repliée par la fenêtre : `panels`) */}
          <Adw.OverlaySplitView
            $type="named"
            name="chat"
            sidebarPosition={Gtk.PackType.END}
            $={(self: Adw.OverlaySplitView) => {
              panels?.(self);
              // largeur choisie en tirant le bord du panneau (retenue)
              const setWidth = (wanted: number): void => {
                // place gardée pour la conversation (sinon la fenêtre déborderait de l'écran)
                const room = self.get_width();
                const w = room > 0 && !self.collapsed ? Math.min(wanted, Math.max(280, room - 400)) : wanted;
                // ordre : jamais min > max (valeur corrigée par la vue, à-coup visible)
                if (w > self.maxSidebarWidth) {
                  self.maxSidebarWidth = w;
                  self.minSidebarWidth = w;
                } else {
                  self.minSidebarWidth = w;
                  self.maxSidebarWidth = w;
                }
              };
              setWidth(settings().sidePanelWidth);
              self.sidebarWidthFraction = 1;
              // glissement suivi sur la vue entière (elle ne bouge pas) : la poignée se déplace avec
              // le panneau, ses coordonnées propres faisaient trembler la largeur ; une mise en page
              // par image au plus
              const drag = new Gtk.GestureDrag({ propagationPhase: Gtk.PropagationPhase.CAPTURE });
              let startX = 0;
              let width = settings().sidePanelWidth;
              let pending: number | null = null;
              let tick = 0;
              drag.connect('drag-begin', (g: Gtk.GestureDrag, x: number) => {
                const edge = self.get_width() - self.minSidebarWidth;
                // hors de la poignée (bord gauche du panneau) : glissement laissé aux autres
                if (!self.showSidebar || Math.abs(x - edge) > 8) {
                  g.set_state(Gtk.EventSequenceState.DENIED);
                  return;
                }
                g.set_state(Gtk.EventSequenceState.CLAIMED);
                startX = x;
                width = self.minSidebarWidth;
              });
              drag.connect('drag-update', (_g: Gtk.GestureDrag, dx: number) => {
                pending = sidePanelWidth(self.get_width() - (startX + dx));
                if (tick !== 0) return;
                tick = self.add_tick_callback(() => {
                  tick = 0;
                  if (pending !== null) setWidth(pending);
                  width = self.minSidebarWidth;
                  pending = null;
                  return GLib.SOURCE_REMOVE;
                });
              });
              drag.connect('drag-end', () => {
                if (pending !== null) setWidth(pending);
                pending = null;
                width = self.minSidebarWidth;
                rememberSidePanelWidth(width);
              });
              self.add_controller(drag);
              // ouvert seulement à la demande (sinon affiché à chaque changement de « replié »)
              self.pinSidebar = true;
              const sync = (): void => {
                self.showSidebar = searching.peek() || summarizing.peek();
              };
              sync();
              onCleanup(searching.subscribe(sync));
              onCleanup(summarizing.subscribe(sync));
              // fermé en glissant ou par Échap (mode superposé) : état suivi ; ouvert autrement : refermé
              self.connect('notify::show-sidebar', () => {
                if (self.showSidebar) {
                  if (!searching.peek() && !summarizing.peek()) self.showSidebar = false;
                  return;
                }
                setSearching(false);
                setSummarizing(false);
              });
            }}
          >
          <Gtk.Box
            $type="content"
            hexpand
            orientation={Gtk.Orientation.VERTICAL}
            cssClasses={['chat-drop', 'wallpaper']}
            $={(self: Gtk.Box) => {
              // fichiers déposés n'importe où dans la conversation : pièces jointes
              attachDrop(self, (files) => dropFiles?.(files));
              // Échap : fin de la sélection ; Ctrl+F : recherche dans la discussion
              const keys = new Gtk.EventControllerKey({ propagationPhase: Gtk.PropagationPhase.CAPTURE });
              keys.connect('key-pressed', (_c: Gtk.EventControllerKey, keyval: number, _code: number, state: Gdk.ModifierType) => {
                if ((keyval === Gdk.KEY_f || keyval === Gdk.KEY_F) && (state & Gdk.ModifierType.CONTROL_MASK) !== 0) {
                  setSearching(true);
                  return true;
                }
                if (keyval !== Gdk.KEY_Escape || selection.peek().size === 0) return false;
                clearSelection();
                return true;
              });
              self.add_controller(keys);
            }}
          >
            {/* messages épinglés : bandeau en haut de la conversation */}
            {PinnedBar(store, (m) => {
              if (conversation !== null && scrollToMessage(conversation, m.id)) return;
              store.openAt(m.chatId, m.id, m.timestamp);
            })}
            <Gtk.ScrolledWindow
              vexpand
              // largeur minimale des bulles non imposée à la fenêtre : un contenu trop large est rogné,
              // jamais la fenêtre élargie au-delà de l'écran (panneaux de droite repoussés hors champ)
              hscrollbarPolicy={Gtk.PolicyType.EXTERNAL}
              $={(self: Gtk.ScrolledWindow) => {
                scroller = self;
                // collé en bas tant que l'utilisateur n'est pas remonté dans l'historique
                const adj = self.vadjustment;
                let stick = true;
                let upper = adj.upper;
                /** distance au bas à conserver quand une page plus ancienne est ajoutée en tête */
                let anchor: number | null = null;
                /** ouverture de la discussion (pas de chargement automatique pendant le premier placement) */
                let openedAt = GLib.get_monotonic_time();
                adj.connect('value-changed', () => {
                  // changement dû à la croissance du contenu (images chargées) : pas un geste de l'utilisateur
                  if (adj.upper !== upper) return;
                  stick = adj.value + adj.pageSize >= adj.upper - 40;
                  // près du haut : page précédente
                  const settled = GLib.get_monotonic_time() - openedAt > 1_000_000;
                  if (settled && adj.upper > adj.pageSize && adj.value < 400 && store.older.peek() === 'idle') void store.loadOlder();
                });
                // page ajoutée en tête : la position à l'écran reste la même
                let firstId = '';
                onCleanup(
                  store.messages.subscribe(() => {
                    const first = store.messages.peek()[0]?.id ?? '';
                    if (firstId !== '' && first !== firstId && !stick) anchor = adj.upper - adj.value;
                    firstId = first;
                  }),
                );
                // `changed` : fin d'une reconfiguration (upper et page_size cohérents) ; position
                // appliquée au tour suivant de la boucle, après l'allocation en cours
                let pending = 0;
                adj.connect('changed', () => {
                  upper = adj.upper;
                  if (anchor !== null && !stick) {
                    adj.value = adj.upper - anchor;
                    if (adj.upper - adj.value === anchor) anchor = null;
                    return;
                  }
                  if (!stick || pending !== 0) return;
                  pending = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                    pending = 0;
                    if (stick) adj.value = adj.upper - adj.pageSize;
                    upper = adj.upper;
                    return GLib.SOURCE_REMOVE;
                  });
                });
                // résultat de recherche : plus collé en bas ; message amené à l'écran une fois affiché
                let seek = 0;
                onCleanup(
                  store.scrollTarget.subscribe(() => {
                    const target = store.scrollTarget.peek();
                    if (target === null) return;
                    stick = false;
                    anchor = null;
                    // pas de chargement automatique de messages plus anciens pendant le placement
                    openedAt = GLib.get_monotonic_time() + 2_000_000;
                    if (seek !== 0) GLib.source_remove(seek);
                    let tries = 0;
                    let found = 0;
                    // replacé quelques fois après l'avoir trouvé (images chargées, mise en page)
                    seek = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
                      tries += 1;
                      if (found === 0) anchor = null;
                      stick = false;
                      if (conversation !== null && scrollToMessage(conversation, target.id, found === 0)) found += 1;
                      if (found < 4 && tries < 40) return GLib.SOURCE_CONTINUE;
                      seek = 0;
                      return GLib.SOURCE_REMOVE;
                    });
                  }),
                );
                onCleanup(
                  store.current.subscribe(() => {
                    stick = true;
                    anchor = null;
                    firstId = '';
                    openedAt = GLib.get_monotonic_time();
                  }),
                );
              }}
            >
              <Adw.Clamp maximumSize={860} tighteningThreshold={600}>
                <Gtk.Box orientation={Gtk.Orientation.VERTICAL} marginStart={12} marginEnd={12} marginTop={12} marginBottom={12}>
                  {/* messages plus anciens : bouton (discussion courte), chargement, ou début de la discussion */}
                  <Gtk.Stack
                    visibleChildName={createMemo(() => {
                      const st = store.older();
                      if (st === 'end') return 'end';
                      if (st === 'idle') return store.messages().length === 0 ? 'none' : 'more';
                      return 'loading';
                    })}
                    halign={Gtk.Align.CENTER}
                    marginBottom={6}
                  >
                    <Gtk.Box $type="named" name="none" />
                    <Gtk.Button $type="named" name="more" label="Messages plus anciens" tooltipText="Charger les messages plus anciens" cssClasses={['flat', 'caption']} onClicked={() => void store.loadOlder()} />
                    <Gtk.Box $type="named" name="loading" spacing={8}>
                      <Adw.Spinner />
                      <Gtk.Label label={store.older((s) => (s === 'phone' ? 'Demande au téléphone…' : 'Chargement…'))} cssClasses={['caption', 'dim-label']} />
                    </Gtk.Box>
                    <Gtk.Label $type="named" name="end" label="Début de la discussion" cssClasses={['caption', 'dim-label']} />
                  </Gtk.Stack>
                  <Gtk.Box
                    orientation={Gtk.Orientation.VERTICAL}
                    spacing={4}
                    cssClasses={['conversation']}
                    $={(self: Gtk.Box) => {
                      conversation = self;
                      // glisser d'un message à l'autre : sélection (comme Telegram Desktop)
                      attachDragSelect(self, () => scroller, () => selection.peek(), setSelection);
                      onCleanup(keyedBox(self, items, (it) => it.key, bubble({ loader, toast, chatName: () => chat.peek()?.name ?? '', photos: () => store.messages.peek().filter((x): x is Photo => x.kind === 'image' && x.media !== null && !x.deleted && !x.viewOnce), pictures, info: (m) => openMessageInfo(self, store, pictures, m, toast), edit: (m) => store.setEditing(m), remove: (parent, m, action) => confirmRemove(parent, store, m, action, toast), selection, toggleSelect, forward: (parent, m) => openForward(parent, store, pictures, [m], toast, clearSelection), translate: (parent, m, mode, lang) => translateAll(parent, [m], mode, lang), pinned: () => new Set(store.pins.peek().map((p) => p.id)), pin: (m, duration) => pinMessage(m, duration), me: () => store.status.peek().me?.id ?? null, vote: (m, options) => void store.client.messageAction(m.chatId, m.id, { action: 'vote', options: [...options] }).catch((error: unknown) => toast(`Vote impossible : ${errorMessage(error)}`)), reply: (m) => store.setReplyTo(m), react: (m, emoji) => void store.client.react(m.chatId, m.id, emoji).catch((error: unknown) => toast(`Réaction impossible : ${errorMessage(error)}`)), scrollTo: (id) => scrollToMessage(self, id) })));
                    }}
                  />
                </Gtk.Box>
              </Adw.Clamp>
            </Gtk.ScrolledWindow>
            <Adw.Clamp maximumSize={860} tighteningThreshold={600}>
              <Gtk.Stack visibleChildName={createMemo(() => (selection().size > 0 ? 'select' : isChannel(store.current() ?? '') ? 'channel' : 'compose'))} transitionType={Gtk.StackTransitionType.CROSSFADE}>
                {/* chaîne : lecture seule */}
                <Gtk.Label $type="named" name="channel" label="Chaîne : seuls ses administrateurs peuvent publier" marginTop={14} marginBottom={14} cssClasses={['dim-label', 'caption']} />
                <Gtk.Box $type="named" name="select" spacing={6} marginStart={12} marginEnd={12} marginTop={8} marginBottom={8} cssClasses={['selection-bar']}>
                  <Gtk.Button iconName="window-close-symbolic" tooltipText="Annuler la sélection (Échap)" cssClasses={['circular', 'flat']} onClicked={clearSelection} />
                  <Gtk.Label hexpand xalign={0} label={selection((s) => (s.size === 1 ? '1 message sélectionné' : `${s.size} messages sélectionnés`))} cssClasses={['heading']} />
                  <Gtk.Button
                    iconName="edit-copy-symbolic"
                    tooltipText="Copier les textes"
                    cssClasses={['circular', 'flat']}
                    onClicked={(b: Gtk.Button) => {
                      const list = selected().filter((m) => !m.deleted);
                      if (list.length === 0) return;
                      b.get_clipboard().set(copyText(list, chat.peek()?.name ?? ''));
                      toast(list.length === 1 ? 'Texte copié' : `${list.length} messages copiés`);
                      clearSelection();
                    }}
                  />
                  <Gtk.Button
                    iconName="preferences-desktop-locale-symbolic"
                    tooltipText="Traduire"
                    cssClasses={['circular', 'flat']}
                    onClicked={(b: Gtk.Button) => {
                      translateAll(b, selected(), 'translate');
                      clearSelection();
                    }}
                  />
                  <Gtk.Button
                    iconName="view-list-bullet-symbolic"
                    tooltipText="Résumer (IA)"
                    cssClasses={['circular', 'flat']}
                    onClicked={() => {
                      startSummary(summariesKey.peek(), chat.peek()?.name ?? '', selected(), (m) => (m.media === null ? Promise.reject(new Error('pas de média')) : loader.file(m, m.media)));
                      setSummarizing(true);
                      clearSelection();
                    }}
                  />
                  <Gtk.Button
                    iconName="mail-forward-symbolic"
                    tooltipText="Transférer"
                    cssClasses={['circular', 'flat']}
                    sensitive={createMemo(() => {
                      const s = selection();
                      return store.messages().some((m) => s.has(m.id) && !m.deleted);
                    })}
                    onClicked={(b: Gtk.Button) => openForward(b, store, pictures, forwardable(selected()), toast, clearSelection)}
                  />
                  <Gtk.Button iconName="user-trash-symbolic" tooltipText="Supprimer" cssClasses={['circular', 'flat', 'destructive-action']} onClicked={(b: Gtk.Button) => confirmRemoveMany(b, store, selected(), toast, clearSelection)} />
                </Gtk.Box>
                <Gtk.Box $type="named" name="compose" orientation={Gtk.Orientation.VERTICAL}>
              <Composer
                store={store}
                pictures={pictures}
                chatId={store.current}
                toast={toast}
                register={(add) => {
                  dropFiles = add;
                }}
              />
                </Gtk.Box>
              </Gtk.Stack>
            </Adw.Clamp>
          </Gtk.Box>
          <Gtk.Overlay $type="sidebar">
          <Gtk.Box orientation={Gtk.Orientation.VERTICAL} cssClasses={['side-panel']}>
            {/* recherche dans la discussion */}
            {ChatSearch(store, searching, () => setSearching(false))}
            {/* résumés (IA) de la discussion : discussion toujours visible */}
            {SummaryPanel(summariesKey, summarizing, () => setSummarizing(false))}
          </Gtk.Box>
          {/* poignée : bord gauche du panneau, à tirer pour l'élargir ou le réduire */}
          <Gtk.Box
            $type="overlay"
            widthRequest={8}
            halign={Gtk.Align.START}
            cssClasses={['side-resize']}
            tooltipText="Tirer pour redimensionner le panneau"
            $={(self: Gtk.Box) => {
              self.set_cursor_from_name('col-resize');
            }}
          />
          </Gtk.Overlay>
          </Adw.OverlaySplitView>
        </Gtk.Stack>
      </Adw.ToolbarView>
    </Adw.NavigationPage>
  );
}

