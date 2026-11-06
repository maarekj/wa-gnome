// Discussion ouverte : messages (bulles, séparateurs de jour) et zone de saisie.
import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import type Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';
import { createMemo, createState, onCleanup, type Accessor } from 'gnim';
import { type Media, previewOf, type Message, uploadKind } from '../shared/api.ts';
import { errorMessage } from '../shared/errors.ts';
import { dayKey, fmtDay, fmtTime } from '../shared/format.ts';
import type { Store } from '../shared/store.ts';
import { type Attachment, attachDrop, attachmentChip, fromFile, fromTexture, pasteAttachments, pickFiles } from './Attachments.ts';
import { avatarText } from './ChatList.tsx';
import { keyedBox } from './KeyedBox.ts';
import { bindAvatar, type Pictures } from './pictures.ts';
import { displaySize, type Loaded, MediaLoader, openViewer, thumbnailTexture } from './media.ts';
import { MediaFrame } from './MediaFrame.ts';
import { AudioView, DocumentView, VideoView } from './MediaViews.ts';
import { asWidget } from './widgets.ts';

/** Élément de la conversation : séparateur de jour ou message. */
export type Item = { kind: 'day'; key: string; label: string } | { kind: 'message'; key: string; message: Message; showSender: boolean };

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
    items.push({ kind: 'message', key: `m:${m.id}`, message: m, showSender });
    previous = m;
  }
  return items;
}

/** Contexte du rendu des bulles. */
interface BubbleContext {
  readonly loader: MediaLoader;
  readonly toast: (text: string) => void;
  readonly chatName: () => string;
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
      if (loaded !== null) openViewer(frame, ctx.chatName(), m, m.media, loaded, ctx.toast);
    });
    frame.add_controller(click);
  }
  return frame;
}

function bubble(ctx: BubbleContext) {
  return (item: Item, live: Accessor<Item>): Gtk.Widget => {
    if (item.kind === 'day') return asWidget(<Gtk.Label label={item.label} halign={Gtk.Align.CENTER} marginTop={12} marginBottom={4} cssClasses={['day-separator', 'caption']} />);
    const m = item.message;
    const msg = (): Message => {
      const it = live.peek();
      return it.kind === 'message' ? it.message : m;
    };
    const picture = isPicture(m) ? MessagePicture(ctx, m) : mediaView(ctx, m);
    // autocollant : sans bulle, comme dans WhatsApp
    const bare = picture !== null && m.kind === 'sticker';
    const classes = bare ? ['sticker'] : ['bubble', m.fromMe ? 'outgoing' : 'incoming', ...(picture === null ? [] : ['with-media'])];
    return asWidget(
      <Gtk.Box halign={m.fromMe ? Gtk.Align.END : Gtk.Align.START} marginStart={m.fromMe ? 64 : 0} marginEnd={m.fromMe ? 0 : 64}>
        <Gtk.Box orientation={Gtk.Orientation.VERTICAL} spacing={2} cssClasses={classes}>
          <Gtk.Label
            visible={live((it) => it.kind === 'message' && it.showSender)}
            label={live(() => msg().senderName ?? msg().sender?.split('@')[0] ?? '')}
            xalign={0}
            cssClasses={['caption-heading', 'accent']}
          />
          {picture}
          <Gtk.Label
            visible={live(() => picture === null || msg().text !== '')}
            label={live(() => (msg().kind === 'text' || picture !== null ? msg().text : previewOf(msg())))}
            cssClasses={live(() => (msg().kind === 'text' || picture !== null ? ['body'] : ['body', 'dim-label']))}
            wrap
            wrapMode={Pango.WrapMode.WORD_CHAR}
            xalign={0}
            selectable
            // sous une image : la légende prend la largeur de l'image au lieu d'élargir la bulle
            maxWidthChars={picture === null ? 60 : 1}
          />
          <Gtk.Label label={live(() => fmtTime(msg().timestamp))} halign={Gtk.Align.END} cssClasses={['caption', 'dim-label']} />
        </Gtk.Box>
      </Gtk.Box>,
    );
  };
}

/** Composer : `register` reçoit la fonction d'ajout de fichiers (dépôt sur toute la conversation). */
function Composer({ store, chatId, toast, register }: { store: Store; chatId: Accessor<string | null>; toast: (text: string) => void; register: (add: (files: Gio.File[]) => void) => void }): JSX.Element {
  const [sending, setSending] = createState(false);
  const [attachments, setAttachments] = createState<readonly Attachment[]>([]);
  // « document » : fichiers envoyés tels quels (pas de compression des photos par WhatsApp)
  const [asDocument, setAsDocument] = createState(false);
  let view: Gtk.TextView | null = null;

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
    if (text === '' && files.length === 0) return;
    setSending(true);
    const run = async (): Promise<void> => {
      // le texte sert de légende au premier fichier (comme WhatsApp)
      for (const [i, f] of files.entries()) {
        // oxlint-disable-next-line no-await-in-loop -- envois dans l'ordre choisi
        await store.client.sendFile(id, { bytes: f.bytes, mimetype: f.mimetype, name: f.name, caption: i === 0 ? text : '', asDocument: asDocument.peek() });
        setAttachments(attachments.peek().filter((x) => x.id !== f.id));
      }
      if (files.length === 0) await store.send(id, text);
      buffer.set_text('', -1);
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
        // autre discussion : pièces jointes abandonnées
        onCleanup(
          chatId.subscribe(() => {
            setAttachments([]);
            setAsDocument(false);
          }),
        );
      }}
    >
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
                if ((keyval !== Gdk.KEY_Return && keyval !== Gdk.KEY_KP_Enter) || (state & Gdk.ModifierType.SHIFT_MASK) !== 0) return false;
                send();
                return true;
              });
              self.add_controller(keys);
              // Ctrl+V : fichiers ou image du presse-papier en pièces jointes, sinon collage du texte
              self.connect('paste-clipboard', () => {
                if (pasteAttachments(self, addFiles, toast)) GObject.signal_stop_emission_by_name(self, 'paste-clipboard');
              });
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
    return id === null ? null : { id, name: c?.name ?? id.split('@')[0] ?? id, group: c?.group ?? id.endsWith('@g.us') };
  });
  const items = createMemo(() => itemsOf(store.messages(), chat()?.group ?? false));
  const loader = new MediaLoader(store.client);
  /** ajout de pièces jointes du composer (renseigné à sa création) */
  let dropFiles: ((files: Gio.File[]) => void) | null = null;
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
            <Gtk.Label label={chat((c) => c?.name ?? 'WhatsApp')} ellipsize={Pango.EllipsizeMode.END} cssClasses={['heading']} />
          </Gtk.Box>
        </Adw.HeaderBar>
        <Gtk.Stack visibleChildName={chat((c) => (c === null ? 'none' : 'chat'))} transitionType={Gtk.StackTransitionType.CROSSFADE}>
          <Adw.StatusPage $type="named" name="none" iconName="chat-message-new-symbolic" title="WhatsApp pour GNOME" description="Choisissez une discussion" />
          <Gtk.Box
            $type="named"
            name="chat"
            orientation={Gtk.Orientation.VERTICAL}
            cssClasses={['chat-drop']}
            $={(self: Gtk.Box) => {
              // fichiers déposés n'importe où dans la conversation : pièces jointes
              attachDrop(self, (files) => dropFiles?.(files));
            }}
          >
            <Gtk.ScrolledWindow
              vexpand
              hscrollbarPolicy={Gtk.PolicyType.NEVER}
              $={(self: Gtk.ScrolledWindow) => {
                // collé en bas tant que l'utilisateur n'est pas remonté dans l'historique
                const adj = self.vadjustment;
                let stick = true;
                let upper = adj.upper;
                adj.connect('value-changed', () => {
                  // changement dû à la croissance du contenu (images chargées) : pas un geste de l'utilisateur
                  if (adj.upper !== upper) return;
                  stick = adj.value + adj.pageSize >= adj.upper - 40;
                });
                // `changed` : fin d'une reconfiguration (upper et page_size cohérents) ; position
                // appliquée au tour suivant de la boucle, après l'allocation en cours
                let pending = 0;
                adj.connect('changed', () => {
                  upper = adj.upper;
                  if (!stick || pending !== 0) return;
                  pending = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                    pending = 0;
                    if (stick) adj.value = adj.upper - adj.pageSize;
                    upper = adj.upper;
                    return GLib.SOURCE_REMOVE;
                  });
                });
                onCleanup(
                  store.current.subscribe(() => {
                    stick = true;
                  }),
                );
              }}
            >
              <Adw.Clamp maximumSize={860} tighteningThreshold={600}>
                <Gtk.Box
                  orientation={Gtk.Orientation.VERTICAL}
                  spacing={4}
                  marginStart={12}
                  marginEnd={12}
                  marginTop={12}
                  marginBottom={12}
                  cssClasses={['conversation']}
                  $={(self: Gtk.Box) => {
                    onCleanup(keyedBox(self, items, (it) => it.key, bubble({ loader, toast, chatName: () => chat.peek()?.name ?? '' })));
                  }}
                />
              </Adw.Clamp>
            </Gtk.ScrolledWindow>
            <Adw.Clamp maximumSize={860} tighteningThreshold={600}>
              <Composer
                store={store}
                chatId={store.current}
                toast={toast}
                register={(add) => {
                  dropFiles = add;
                }}
              />
            </Adw.Clamp>
          </Gtk.Box>
        </Gtk.Stack>
      </Adw.ToolbarView>
    </Adw.NavigationPage>
  );
}

