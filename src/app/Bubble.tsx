// Bulles des messages : texte, médias, citation, menu, sondage, traduction, réactions.
import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';
import { createState, onCleanup, type Accessor } from 'gnim';
import {
  DELETED_TEXT,
  editability,
  PIN_DURATIONS,
  type Poll,
  viewOnceLabel,
  isMissedCall,
  isVideoCall,
  type Media,
  type Presence,
  type MessageStatus,
  previewOf,
  type Message,
  QUICK_REACTIONS,
  REVOKE_WINDOW_S,
  type Quoted,
} from '../shared/api.ts';
import { errorMessage } from '../shared/errors.ts';
import { dayKey, emojiOnly, esc, fmtDay, fmtTime, MENTION_LINK, mentionMarkup, readMoreCut, waMarkup } from '../shared/format.ts';
import { typingText } from '../shared/store.ts';
import { avatarText } from './ChatList.tsx';
import { settings } from './Preferences.ts';
import { hideTranslation, languageName, translationOf, watchTranslation } from './Translate.ts';
import { ReactionsRow } from './Reactions.ts';
import { bindAvatar, type Pictures } from './pictures.ts';
import { displaySize, type Loaded, type MediaLoader, openViewer, type Photo, thumbnailTexture } from './media.ts';
import { MediaFrame } from './MediaFrame.ts';
import { AudioView, DocumentView, VideoView } from './MediaViews.ts';
import { asWidget, openLinks } from './widgets.ts';

/** Élément de la conversation : séparateur de jour ou message. */
export type Item = { kind: 'day'; key: string; label: string } | { kind: 'message'; key: string; message: Message; showSender: boolean; group: boolean };

/**
 * Messages groupés par jour ; nom de l'auteur affiché au premier message d'une suite (groupes).
 * `previous` : éléments du calcul précédent, repris tels quels s'ils n'ont pas changé (même
 * objet : les liaisons de la bulle ne sont pas réveillées).
 */
export function itemsOf(messages: readonly Message[], group: boolean, previous?: ReadonlyMap<string, Item>): Item[] {
  const items: Item[] = [];
  let day = '';
  let before: Message | null = null;
  for (const m of messages) {
    const k = dayKey(m.timestamp);
    if (k !== day) {
      day = k;
      before = null;
      const key = `day:${k}`;
      const old = previous?.get(key);
      const label = fmtDay(m.timestamp);
      // libellé relatif (« Aujourd'hui ») : repris seulement s'il n'a pas changé
      items.push(old?.kind === 'day' && old.label === label ? old : { kind: 'day', key, label });
    }
    const known = m.sender !== null || m.senderName !== null;
    const showSender = group && !m.fromMe && known && (before === null || before.fromMe || before.sender !== m.sender);
    // supprimé : clé différente, bulle reconstruite (média et citation retirés)
    const key = m.deleted ? `m:${m.id}:x` : `m:${m.id}`;
    const old = previous?.get(key);
    items.push(
      old?.kind === 'message' && old.message === m && old.showSender === showSender && old.group === group
        ? old
        : { kind: 'message', key, message: m, showSender, group },
    );
    before = m;
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

/** Transcription et traduction d'un message (sous son texte), mises à jour en direct. */
export function TranslationView(m: Message): Gtk.Widget {
  const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2, cssClasses: ['translation'], visible: false });
  // contenu construit à la première traduction de ce message (rien pour les autres bulles)
  let fill: (() => void) | null = null;
  const sync = (): void => {
    if (fill === null && translationOf(m) === undefined) return;
    fill ??= buildTranslation(m, box);
    fill();
  };
  sync();
  onCleanup(watchTranslation(m, sync));
  return box;
}

/** Libellés de la traduction dans `box` ; renvoie leur mise à jour. */
export function buildTranslation(m: Message, box: Gtk.Box): () => void {
  const transcript = new Gtk.Label({
    xalign: 0,
    wrap: true,
    wrapMode: Pango.WrapMode.WORD_CHAR,
    selectable: true,
    maxWidthChars: 60,
    cssClasses: ['transcript'],
  });
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
  return sync;
}

/** Couleurs des noms des participants (lisibles en thème clair et sombre). */
export const SENDER_COLORS = [
  '#d63d6e',
  '#1f7aec',
  '#c75000',
  '#9141c2',
  '#0a8f55',
  '#d13438',
  '#0f8394',
  '#a06a00',
  '#5b5fc7',
  '#b5338a',
  '#3d8a1f',
  '#e0662c',
] as const;

/** Couleur du nom d'un participant : stable, choisie d'après son identifiant. */
export function senderColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (Math.imul(h, 31) + (id.codePointAt(i) ?? 0)) >>> 0;
  return SENDER_COLORS[h % SENDER_COLORS.length] ?? SENDER_COLORS[0];
}

/** Bulle d'un message (pour la mise en évidence) : premier descendant de classe `bubble` ou `sticker`. */
export function findBubble(w: Gtk.Widget): Gtk.Widget | null {
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
export function withAuthor(ctx: BubbleContext, w: Gtk.Widget, m: Message, live: Accessor<Item>): Gtk.Widget {
  const name = m.senderName ?? m.sender?.split('@')[0] ?? '';
  const avatar = new Adw.Avatar({
    size: 28,
    text: avatarText(name),
    showInitials: /\p{L}/u.test(name),
    valign: Gtk.Align.START,
    marginTop: 2,
  });
  if (m.sender !== null) bindAvatar(avatar, ctx.pictures.texture(m.sender, true));
  // clic sur la photo : discussion avec l'auteur (photo visible seulement au premier message)
  const click = new Gtk.GestureClick();
  click.connect('released', () => {
    if (avatar.opacity > 0) ctx.openAuthor(m);
  });
  avatar.add_controller(click);
  const first = (): boolean => {
    const it = live.peek();
    return it.kind === 'message' && it.showSender;
  };
  // photo cachée (messages suivants d'une suite) : ni infobulle ni clic
  const sync = (): void => {
    const shown = first();
    avatar.opacity = shown ? 1 : 0;
    avatar.tooltipText = shown ? `Écrire à ${name}` : '';
    avatar.cursor = shown ? Gdk.Cursor.new_from_name('pointer', null) : null;
  };
  sync();
  onCleanup(live.subscribe(sync));
  const row = new Gtk.Box({ name: w.name, spacing: 6, halign: Gtk.Align.START, marginEnd: w.marginEnd });
  w.name = '';
  w.marginEnd = 0;
  row.append(avatar);
  row.append(w);
  return row;
}

/** Contexte du rendu des bulles. */
export interface BubbleContext {
  readonly loader: MediaLoader;
  readonly toast: (text: string) => void;
  readonly chatName: () => string;
  /** compte de la discussion */
  readonly account: string;
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
  /** ouvre la discussion avec l'auteur d'un message de groupe */
  readonly openAuthor: (m: Message) => void;
  /** ouvre la discussion avec une personne (mention @) */
  readonly openPerson: (id: string, name: string) => void;
}

/** Nom affiché de l'auteur d'un message. */
const authorName = (m: Message): string => m.senderName ?? m.sender?.split('@')[0] ?? '';

/**
 * Nom de l'auteur en tête de bulle (groupe) : couleur propre à chaque participant ; clic : sa
 * discussion. `msg` : message à jour (nom appris après coup).
 */
function SenderName(ctx: BubbleContext, msg: () => Message, visible: Accessor<boolean>, refresh?: Accessor<unknown>): Gtk.Widget {
  const label = new Gtk.Label({ useMarkup: true, xalign: 0, cssClasses: ['caption-heading'] });
  const button = new Gtk.Button({ child: label, halign: Gtk.Align.START, cssClasses: ['flat', 'sender-link'] });
  const sync = (): void => {
    const m = msg();
    label.label = `<span foreground="${senderColor(m.sender ?? '')}">${esc(authorName(m))}</span>`;
    button.tooltipText = `Écrire à ${authorName(m)}`;
  };
  sync();
  button.visible = visible.peek();
  onCleanup(
    visible.subscribe(() => {
      button.visible = visible.peek();
    }),
  );
  if (refresh !== undefined) onCleanup(refresh.subscribe(sync));
  button.connect('clicked', () => ctx.openAuthor(msg()));
  return button;
}

/** Messages transférables (pas ceux supprimés pour tous). */
export const forwardable = (list: readonly Message[]): Message[] => list.filter((m) => !m.deleted);

/**
 * Ligne d'un message, sur toute la largeur : surlignée si sélectionnée ; en mode sélection, un clic
 * n'importe où sur la ligne coche ou décoche (capturé avant l'image, la citation ou le texte).
 * Le nom `m:<id>` passe à la ligne (défilement vers un message cité).
 */
export function selectableRow(ctx: BubbleContext, row: Gtk.Widget, id: string, msg: () => Message): Gtk.Widget {
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
export const STATUS_TEXT: Readonly<Record<MessageStatus, string>> = {
  pending: 'En attente d’envoi',
  sent: 'Envoyé',
  delivered: 'Reçu',
  read: 'Lu',
  played: 'Écouté',
  error: 'Échec de l’envoi',
};

/** Ma réaction sur un message, ou null. */
export const myReaction = (m: Pick<Message, 'reactions'>): string | null => m.reactions.find((r) => r.mine)?.emoji ?? null;

/** Aperçu d'une citation : auteur et début du texte (ou genre du média). */
export const quotePreview = (q: Pick<Quoted, 'kind' | 'text'>): string => previewOf(q).replaceAll('\n', ' ');

/** Transferts à partir desquels WhatsApp affiche « Transféré à plusieurs reprises ». */
export const FORWARDED_MANY = 5;

/** Mention « Transféré » en tête de bulle (comme WhatsApp). */
export function ForwardedMark(score: number): Gtk.Widget {
  const many = score >= FORWARDED_MANY;
  const box = new Gtk.Box({ spacing: 4, cssClasses: ['forwarded', 'dim-label'] });
  box.append(new Gtk.Image({ iconName: 'mail-forward-symbolic', pixelSize: 14 }));
  box.append(new Gtk.Label({ label: many ? 'Transféré à plusieurs reprises' : 'Transféré', xalign: 0, cssClasses: ['caption'] }));
  return box;
}

/** Bloc de citation dans une bulle ; clic : message cité à l'écran. */
export function QuoteBlock(ctx: BubbleContext, q: Quoted): Gtk.Widget {
  const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, cssClasses: ['quote', ...(q.fromMe ? ['mine'] : [])], tooltipText: 'Voir le message cité' });
  box.append(
    new Gtk.Label({
      label: q.senderName ?? '',
      xalign: 0,
      ellipsize: Pango.EllipsizeMode.END,
      cssClasses: ['caption-heading', 'accent'],
      visible: q.senderName !== null,
    }),
  );
  box.append(
    new Gtk.Label({
      label: quotePreview(q),
      xalign: 0,
      ellipsize: Pango.EllipsizeMode.END,
      lines: 2,
      wrap: true,
      wrapMode: Pango.WrapMode.WORD_CHAR,
      maxWidthChars: 40,
      cssClasses: ['caption'],
    }),
  );
  box.set_cursor_from_name('pointer');
  const click = new Gtk.GestureClick();
  click.connect('released', () => {
    if (!ctx.scrollTo(q.id)) ctx.toast('Message cité plus ancien que ceux affichés');
  });
  box.add_controller(click);
  return box;
}

/** Actions `msg.*` du menu d'une bulle. */
export function installActions(ctx: BubbleContext, widget: Gtk.Widget, msg: () => Message): void {
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
  for (const [name, action] of [
    ['revoke', 'revoke'],
    ['delete-for-me', 'delete-for-me'],
  ] as const) {
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
  for (const [name, mode] of [
    ['translate', 'translate'],
    ['transcribe', 'transcribe'],
  ] as const) {
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
}

/** Menu d'une bulle (clic droit, appui long) : répondre, copier le texte. */
export function attachBubbleMenu(ctx: BubbleContext, widget: Gtk.Widget, msg: () => Message): void {
  // actions créées à la première ouverture du menu (pas pour chaque bulle affichée)
  let installed = false;
  const install = (): void => {
    if (installed) return;
    installed = true;
    installActions(ctx, widget, msg);
  };
  const openMenu = (model: Gio.Menu, x: number, y: number): void => {
    install();
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
export function mediaView(ctx: BubbleContext, m: Message): Gtk.Widget | null {
  if (m.media === null) return null;
  const mm = { ...m, media: m.media };
  const views: Partial<Record<Message['kind'], (c: BubbleContext, msg: typeof mm) => Gtk.Widget>> = {
    document: DocumentView,
    audio: AudioView,
    video: VideoView,
  };
  return views[m.kind]?.(ctx, mm) ?? null;
}

/** Types affichés comme image. */
export const isPicture = (m: Message): m is Message & { media: Media } => m.media !== null && (m.kind === 'image' || m.kind === 'sticker');

/** Image d'un message : miniature tout de suite, image complète une fois téléchargée ; clic : aperçu. */
export function MessagePicture(ctx: BubbleContext, m: Message & { media: Media }): Gtk.Widget {
  const sticker = m.kind === 'sticker';
  const [w, h] = displaySize(m.media.width, m.media.height, sticker ? 160 : 300);
  const label = sticker ? 'Autocollant' : 'Ouvrir l’image';
  // image accessible (lecteur d'écran, tests) : rôle et nom
  const frame = new MediaFrame({ cssClasses: ['message-media'], tooltipText: label, accessibleRole: Gtk.AccessibleRole.IMG });
  frame.update_property([Gtk.AccessibleProperty.LABEL], [label]);
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
  // pleine taille chargée à l'affichage seulement (hors écran : vignette), libérée en sortant
  let token = 0;
  frame.connect('map', () => {
    token += 1;
    if (loaded === null) void load();
  });
  frame.connect('unmap', () => {
    token += 1;
    const gone = token;
    // court délai : un défilement rapide aller-retour ne recharge pas tout
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 5000, () => {
      if (token === gone && !frame.get_mapped() && loaded !== null) {
        loaded = null;
        frame.setPaintable(thumbnailTexture(m.media));
      }
      return GLib.SOURCE_REMOVE;
    });
  });
  if (!sticker) {
    frame.set_cursor_from_name('pointer');
    const click = new Gtk.GestureClick();
    click.connect('released', () => {
      if (loaded === null) {
        void load();
        return;
      }
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
export function DeletedBubble(ctx: BubbleContext, m: Message, msg: () => Message, live: Accessor<Item>): Gtk.Widget {
  return asWidget(
    <Gtk.Box
      name={`m:${m.id}`}
      orientation={Gtk.Orientation.VERTICAL}
      halign={m.fromMe ? Gtk.Align.END : Gtk.Align.START}
      marginStart={m.fromMe ? 64 : 0}
      marginEnd={m.fromMe ? 0 : 64}
    >
      <Gtk.Box
        orientation={Gtk.Orientation.VERTICAL}
        spacing={2}
        cssClasses={['bubble', m.fromMe ? 'outgoing' : 'incoming', 'deleted']}
        $={(self: Gtk.Box) => {
          attachBubbleMenu(ctx, self, msg);
        }}
      >
        {SenderName(
          ctx,
          () => m,
          live((it) => it.kind === 'message' && it.showSender),
        )}
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
export function ViewOnceView(m: Message): Gtk.Widget {
  const box = new Gtk.Box({ spacing: 10, marginTop: 4, marginBottom: 2, cssClasses: ['view-once'] });
  box.append(
    new Gtk.Image({
      iconName: m.kind === 'video' ? 'camera-video-symbolic' : m.kind === 'audio' ? 'audio-input-microphone-symbolic' : 'camera-photo-symbolic',
      pixelSize: 22,
    }),
  );
  const texts = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, valign: Gtk.Align.CENTER });
  texts.append(new Gtk.Label({ label: viewOnceLabel(m.kind), xalign: 0, cssClasses: ['heading'] }));
  texts.append(
    new Gtk.Label({ label: m.fromMe ? 'Envoyée depuis votre téléphone' : 'À ouvrir sur votre téléphone', xalign: 0, cssClasses: ['caption', 'dim-label'] }),
  );
  box.append(texts);
  return box;
}

/** Récapitulatif des votes d'un sondage : chaque option, son nombre de votes et les votants. */
export function openPollVotes(parent: Gtk.Widget, pictures: Pictures, me: string | null, m: Message): void {
  const poll = m.poll;
  if (poll === null) return;
  const page = new Adw.PreferencesPage();
  const head = new Adw.PreferencesGroup({ title: esc(m.text), description: poll.voters === 1 ? '1 personne a voté' : `${poll.voters} personnes ont voté` });
  page.add(head);
  // options les plus choisies d'abord (ordre du sondage à égalité)
  for (const o of poll.options.toSorted((a, b) => b.count - a.count)) {
    const group = new Adw.PreferencesGroup({ title: esc(o.name), description: o.count === 0 ? 'Aucun vote' : o.count === 1 ? '1 vote' : `${o.count} votes` });
    for (const v of o.voters) {
      const row = new Adw.ActionRow({ title: esc(v.name), ...(v.id === null ? { subtitle: 'Votre vote' } : {}) });
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
export function PollView(ctx: BubbleContext, msg: () => Message, live: Accessor<Item>): Gtk.Widget {
  const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6, widthRequest: 280, cssClasses: ['poll'] });
  const render = (): void => {
    for (let c = box.get_first_child(); c !== null; c = box.get_first_child()) box.remove(c);
    const m = msg();
    const poll = m.poll;
    if (poll === null) return;
    box.append(new Gtk.Label({ label: m.text, xalign: 0, wrap: true, wrapMode: Pango.WrapMode.WORD_CHAR, cssClasses: ['heading'] }));
    box.append(
      new Gtk.Label({
        label: poll.multiple ? 'Choisissez une ou plusieurs options' : 'Choisissez une option',
        xalign: 0,
        cssClasses: ['caption', 'dim-label'],
      }),
    );
    const max = Math.max(1, ...poll.options.map((o) => o.count));
    for (const o of poll.options) {
      const row = new Gtk.Button({ cssClasses: ['flat', 'poll-option'] });
      const lines = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4 });
      const top = new Gtk.Box({ spacing: 8 });
      top.append(
        new Gtk.Image({
          iconName: o.mine ? (poll.multiple ? 'checkbox-checked-symbolic' : 'radio-checked-symbolic') : poll.multiple ? 'checkbox-symbolic' : 'radio-symbolic',
          cssClasses: o.mine ? ['accent'] : [],
        }),
      );
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
    foot.append(
      new Gtk.Label({
        label: poll.voters === 0 ? 'Aucun vote' : poll.voters === 1 ? '1 personne a voté' : `${poll.voters} personnes ont voté`,
        xalign: 0,
        hexpand: true,
        cssClasses: ['caption', 'dim-label'],
      }),
    );
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
export function CallLine(m: Message): Gtk.Widget {
  const missed = isMissedCall(m);
  const box = new Gtk.Box({
    name: `m:${m.id}`,
    spacing: 6,
    halign: Gtk.Align.CENTER,
    marginTop: 4,
    marginBottom: 4,
    cssClasses: ['call-line', ...(missed ? ['missed'] : [])],
  });
  box.append(new Gtk.Image({ iconName: isVideoCall(m) ? 'camera-video-symbolic' : 'call-start-symbolic' }));
  const who = m.senderName === null ? '' : ` · ${m.senderName}`;
  box.append(new Gtk.Label({ label: `${m.text}${who} · ${fmtTime(m.timestamp)}`, cssClasses: ['caption'] }));
  return box;
}

export function bubble(ctx: BubbleContext) {
  return (item: Item, live: Accessor<Item>): Gtk.Widget => {
    if (item.kind === 'day')
      return asWidget(<Gtk.Label label={item.label} halign={Gtk.Align.CENTER} marginTop={12} marginBottom={4} cssClasses={['day-separator', 'caption']} />);
    const m = item.message;
    const msg = (): Message => {
      const it = live.peek();
      return it.kind === 'message' ? it.message : m;
    };
    // groupe, message reçu : photo de l'auteur à gauche
    const author = (w: Gtk.Widget): Gtk.Widget => (item.group && !m.fromMe ? withAuthor(ctx, w, m, live) : w);
    if (m.deleted) return selectableRow(ctx, author(DeletedBubble(ctx, m, msg, live)), m.id, msg);
    if (m.kind === 'call') return CallLine(m);
    const picture = m.viewOnce
      ? ViewOnceView(m)
      : m.kind === 'poll' && m.poll !== null
        ? PollView(ctx, msg, live)
        : isPicture(m)
          ? MessagePicture(ctx, m)
          : mediaView(ctx, m);
    // autocollant : sans bulle, comme dans WhatsApp
    const bare = picture !== null && m.kind === 'sticker';
    // émojis seuls (sans citation ni « Transféré ») : en grand, sans fond de bulle, comme WhatsApp
    const plain = picture === null && m.quoted === null && m.forwarded === 0;
    const emojiClasses = (): string[] => (plain ? bigEmoji(msg()) : []);
    /** « Lire la suite » cliqué : texte entier */
    const [expanded, setExpanded] = createState(false);
    const classes = bare ? ['sticker'] : ['bubble', m.fromMe ? 'outgoing' : 'incoming', ...(picture === null ? [] : ['with-media'])];
    return selectableRow(
      ctx,
      author(
        asWidget(
          <Gtk.Box
            name={`m:${m.id}`}
            orientation={Gtk.Orientation.VERTICAL}
            halign={m.fromMe ? Gtk.Align.END : Gtk.Align.START}
            marginStart={m.fromMe ? 64 : 0}
            marginEnd={m.fromMe ? 0 : 64}
          >
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
              {SenderName(
                ctx,
                msg,
                live((it) => it.kind === 'message' && it.showSender),
                live,
              )}
              {m.forwarded === 0 ? null : ForwardedMark(m.forwarded)}
              {m.quoted === null ? null : QuoteBlock(ctx, m.quoted)}
              {picture}
              <Gtk.Label
                visible={live(() => (picture === null || msg().text !== '') && msg().kind !== 'poll')}
                // mise en forme WhatsApp (gras, italique, code, citations, listes)
                useMarkup
                label={live(() =>
                  msg().kind === 'text' || picture !== null
                    ? mentionMarkup(waMarkup(expanded() ? msg().text : (readMoreCut(msg().text) ?? msg().text)), msg().mentions, true)
                    : esc(previewOf(msg())),
                )}
                cssClasses={live(() => (msg().kind === 'text' || picture !== null ? ['body', ...emojiClasses()] : ['body', 'dim-label']))}
                wrap
                wrapMode={Pango.WrapMode.WORD_CHAR}
                xalign={0}
                selectable
                // sous une image : la légende prend la largeur de l'image au lieu d'élargir la bulle
                maxWidthChars={picture === null ? 60 : 1}
                // texte long : largeur minimale donnée (sinon GTK la calcule en coupant le texte à chaque
                // caractère : des dizaines de ms par long message). Un texte long occupe de toute façon
                // la largeur maximale ; un court garde la sienne.
                widthChars={picture === null && m.text.length > 100 ? 20 : -1}
                // mention @ : discussion de la personne ; liens : ouverts dans le navigateur par défaut
                $={(self: Gtk.Label) => {
                  self.connect('activate-link', (_l: Gtk.Label, uri: string) => {
                    if (!uri.startsWith(MENTION_LINK)) return false;
                    const id = uri.slice(MENTION_LINK.length);
                    ctx.openPerson(id, msg().mentions.find((x) => x.id === id)?.name ?? id.split('@')[0] ?? '');
                    return true;
                  });
                  openLinks(self);
                }}
              />
              {/* très long message : début seulement, comme WhatsApp */}
              <Gtk.Button
                label="Lire la suite"
                visible={live(() => !expanded() && (msg().kind === 'text' || picture !== null) && readMoreCut(msg().text) !== null)}
                halign={Gtk.Align.START}
                cssClasses={['flat', 'read-more']}
                onClicked={() => setExpanded(true)}
              />
              {TranslationView(m)}
              <Gtk.Box spacing={4} halign={Gtk.Align.END}>
                <Gtk.Label
                  label="Modifié"
                  visible={live(() => msg().edited)}
                  tooltipText="Message modifié par son auteur"
                  cssClasses={['caption', 'dim-label', 'edited-mark']}
                />
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
        ),
      ),
      m.id,
      msg,
    );
  };
}
