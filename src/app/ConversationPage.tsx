// Discussion ouverte : messages (bulles, séparateurs de jour) et zone de saisie.
import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';
import { createMemo, createState, onCleanup, type Accessor } from 'gnim';
import { DELETED_TEXT, editability, type Media, type Presence, type MessageStatus, previewOf, type Message, QUICK_REACTIONS, REVOKE_WINDOW_S, type Quoted, uploadKind } from '../shared/api.ts';
import { errorMessage } from '../shared/errors.ts';
import { dayKey, esc, fmtDay, fmtTime, waMarkup } from '../shared/format.ts';
import { type Store, typingText } from '../shared/store.ts';
import { type Attachment, attachDrop, attachmentChip, fromFile, fromTexture, pasteAttachments, pickFiles } from './Attachments.ts';
import { avatarText, isChannel } from './ChatList.tsx';
import { openMessageInfo } from './MessageInfo.ts';
import { ChatSearch } from './ChatSearch.ts';
import { attachDragSelect } from './DragSelect.ts';
import { openGallery } from './Gallery.ts';
import { confirmRemoveMany, copyText, openForward } from './Selection.ts';
import { ReactionsRow } from './Reactions.ts';
import { keyedBox } from './KeyedBox.ts';
import { bindAvatar, type Pictures } from './pictures.ts';
import { displaySize, type Loaded, MediaLoader, openViewer, type Photo, thumbnailTexture } from './media.ts';
import { MediaFrame } from './MediaFrame.ts';
import { AudioView, DocumentView, VideoView } from './MediaViews.ts';
import { asWidget } from './widgets.ts';

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
    const picture = isPicture(m) ? MessagePicture(ctx, m) : mediaView(ctx, m);
    // autocollant : sans bulle, comme dans WhatsApp
    const bare = picture !== null && m.kind === 'sticker';
    const classes = bare ? ['sticker'] : ['bubble', m.fromMe ? 'outgoing' : 'incoming', ...(picture === null ? [] : ['with-media'])];
    return selectableRow(ctx, author(asWidget(
      <Gtk.Box name={`m:${m.id}`} orientation={Gtk.Orientation.VERTICAL} halign={m.fromMe ? Gtk.Align.END : Gtk.Align.START} marginStart={m.fromMe ? 64 : 0} marginEnd={m.fromMe ? 0 : 64}>
        <Gtk.Box
          orientation={Gtk.Orientation.VERTICAL}
          spacing={2}
          cssClasses={classes}
          $={(self: Gtk.Box) => {
            attachBubbleMenu(ctx, self, msg);
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
            visible={live(() => picture === null || msg().text !== '')}
            // mise en forme WhatsApp (gras, italique, code, citations, listes)
            useMarkup
            label={live(() => (msg().kind === 'text' || picture !== null ? waMarkup(msg().text) : esc(previewOf(msg()))))}
            cssClasses={live(() => (msg().kind === 'text' || picture !== null ? ['body'] : ['body', 'dim-label']))}
            wrap
            wrapMode={Pango.WrapMode.WORD_CHAR}
            xalign={0}
            selectable
            // sous une image : la légende prend la largeur de l'image au lieu d'élargir la bulle
            maxWidthChars={picture === null ? 60 : 1}
          />
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
function Composer({ store, chatId, toast, register }: { store: Store; chatId: Accessor<string | null>; toast: (text: string) => void; register: (add: (files: Gio.File[]) => void) => void }): JSX.Element {
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

  const addFiles = (files: Gio.File[], textures: Gdk.Texture[] = []): void => {
    for (const t of textures) setAttachments([...attachments.peek(), fromTexture(t)]);
    for (const f of files) {
      fromFile(f)
        .then((a) => setAttachments([...attachments.peek(), a]))
        .catch((error: unknown) => toast(`Fichier ignoré : ${errorMessage(error)}`));
    }
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
        store.setEditing(null);
        buffer.set_text('', -1);
        return;
      }
      setSending(true);
      const edit = async (): Promise<void> => {
        try {
          await store.client.messageAction(editing.chatId, editing.id, { action: 'edit', text });
          store.setEditing(null);
          buffer.set_text('', -1);
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
      if (files.length === 0) await store.send(id, text, replyTo);
      buffer.set_text('', -1);
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
            if (store.editing.peek() !== null) {
              store.setEditing(null);
              view?.buffer.set_text('', -1);
            }
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
              if (editedText !== null && view.buffer.text === editedText) view.buffer.set_text('', -1);
              editedText = null;
              return;
            }
            editedText = m.text;
            store.setReplyTo(null);
            view.buffer.set_text(m.text, -1);
            view.buffer.place_cursor(view.buffer.get_end_iter());
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
          onClicked={() => {
            store.setEditing(null);
            view?.buffer.set_text('', -1);
          }}
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
      <Gtk.Box spacing={6}>
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
              const keys = new Gtk.EventControllerKey();
              keys.connect('key-pressed', (_c: Gtk.EventControllerKey, keyval: number, _code: number, state: Gdk.ModifierType) => {
                if (keyval === Gdk.KEY_Escape && store.editing.peek() !== null) {
                  store.setEditing(null);
                  self.buffer.set_text('', -1);
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
              // nouvelle discussion : saisie vidée, focus dans la zone
              onCleanup(
                chatId.subscribe(() => {
                  self.buffer.set_text('', -1);
                  self.grab_focus();
                }),
              );
            }}
          />
        </Gtk.ScrolledWindow>
        <Gtk.Button iconName="mail-send-symbolic" tooltipText="Envoyer" valign={Gtk.Align.END} sensitive={sending((s) => !s)} cssClasses={['circular', 'suggested-action']} onClicked={send} />
      </Gtk.Box>
    </Gtk.Box>
  );
}

export function ConversationPage({ store, pictures, toast }: { store: Store; pictures: Pictures; toast: (text: string) => void }): JSX.Element {
  const chat = createMemo(() => {
    const id = store.current();
    // nom et type suivis : la liste des discussions est mise à jour en direct
    const c = id === null ? undefined : store.chats().find((x) => x.id === id);
    return id === null ? null : { id, name: c?.name ?? store.nameHint(id) ?? id.split('@')[0] ?? id, group: c?.group ?? id.endsWith('@g.us') };
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
  /** messages sélectionnés, dans l'ordre de la discussion */
  const selected = (): Message[] => store.messages.peek().filter((m) => selection.peek().has(m.id));
  return (
    <Adw.NavigationPage title={chat((c) => c?.name ?? 'WhatsApp')} tag="conversation">
      <Adw.ToolbarView>
        <Adw.HeaderBar $type="top">
          <Gtk.Box $type="title" spacing={10}>
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
              <Gtk.Label label={chat((c) => c?.name ?? 'WhatsApp')} ellipsize={Pango.EllipsizeMode.END} xalign={0} cssClasses={['heading']} />
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
            iconName="system-search-symbolic"
            tooltipText="Rechercher dans la discussion (Ctrl+F)"
            visible={chat((c) => c !== null)}
            active={searching}
            onToggled={(b: Gtk.ToggleButton) => setSearching(b.active)}
          />
        </Adw.HeaderBar>
        <Gtk.Stack visibleChildName={chat((c) => (c === null ? 'none' : 'chat'))} transitionType={Gtk.StackTransitionType.CROSSFADE}>
          <Adw.StatusPage $type="named" name="none" iconName="chat-message-new-symbolic" title="WhatsApp pour GNOME" description="Choisissez une discussion" />
          <Gtk.Box $type="named" name="chat">
          <Gtk.Box
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
            <Gtk.ScrolledWindow
              vexpand
              hscrollbarPolicy={Gtk.PolicyType.NEVER}
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
                      onCleanup(keyedBox(self, items, (it) => it.key, bubble({ loader, toast, chatName: () => chat.peek()?.name ?? '', photos: () => store.messages.peek().filter((x): x is Photo => x.kind === 'image' && x.media !== null && !x.deleted), pictures, info: (m) => openMessageInfo(self, store, pictures, m, toast), edit: (m) => store.setEditing(m), remove: (parent, m, action) => confirmRemove(parent, store, m, action, toast), selection, toggleSelect, forward: (parent, m) => openForward(parent, store, pictures, [m], toast, clearSelection), reply: (m) => store.setReplyTo(m), react: (m, emoji) => void store.client.react(m.chatId, m.id, emoji).catch((error: unknown) => toast(`Réaction impossible : ${errorMessage(error)}`)), scrollTo: (id) => scrollToMessage(self, id) })));
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
          {/* recherche dans la discussion : panneau à droite */}
          {ChatSearch(store, searching, () => setSearching(false))}
          </Gtk.Box>
        </Gtk.Stack>
      </Adw.ToolbarView>
    </Adw.NavigationPage>
  );
}

