// Discussion ouverte : messages (bulles, séparateurs de jour) et zone de saisie.
import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';
import { createMemo, createState, onCleanup, type Accessor } from 'gnim';
import { type Media, previewOf, type Message } from '../shared/api.ts';
import { errorMessage } from '../shared/errors.ts';
import { dayKey, fmtDay, fmtTime } from '../shared/format.ts';
import type { Store } from '../shared/store.ts';
import { keyedBox } from './KeyedBox.ts';
import { displaySize, type Loaded, MediaLoader, openViewer, thumbnailTexture } from './media.ts';
import { MediaFrame } from './MediaFrame.ts';
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

/** Types affichés comme image (les autres médias gardent leur libellé : #6). */
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
    const picture = isPicture(m) ? MessagePicture(ctx, m) : null;
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

function Composer({ store, chatId, toast }: { store: Store; chatId: Accessor<string | null>; toast: (text: string) => void }): JSX.Element {
  const [sending, setSending] = createState(false);
  let view: Gtk.TextView | null = null;
  const send = (): void => {
    const id = chatId.peek();
    const buffer = view?.buffer;
    if (id === null || buffer === undefined || sending.peek()) return;
    const text = buffer.text.trim();
    if (text === '') return;
    setSending(true);
    store
      .send(id, text)
      .then(() => buffer.set_text('', -1))
      .catch((error: unknown) => toast(`Envoi impossible : ${errorMessage(error)}`))
      .finally(() => {
        setSending(false);
        view?.grab_focus();
      });
  };
  return (
    <Gtk.Box spacing={6} marginStart={12} marginEnd={12} marginTop={6} marginBottom={12} cssClasses={['composer']}>
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
  );
}

export function ConversationPage({ store, toast }: { store: Store; toast: (text: string) => void }): JSX.Element {
  const chat = createMemo(() => {
    const id = store.current();
    // nom et type suivis : la liste des discussions est mise à jour en direct
    const c = id === null ? undefined : store.chats().find((x) => x.id === id);
    return id === null ? null : { id, name: c?.name ?? id.split('@')[0] ?? id, group: c?.group ?? id.endsWith('@g.us') };
  });
  const items = createMemo(() => itemsOf(store.messages(), chat()?.group ?? false));
  const loader = new MediaLoader(store.client);
  return (
    <Adw.NavigationPage title={chat((c) => c?.name ?? 'WhatsApp')} tag="conversation">
      <Adw.ToolbarView>
        <Adw.HeaderBar $type="top" />
        <Gtk.Stack visibleChildName={chat((c) => (c === null ? 'none' : 'chat'))} transitionType={Gtk.StackTransitionType.CROSSFADE}>
          <Adw.StatusPage $type="named" name="none" iconName="chat-message-new-symbolic" title="WhatsApp pour GNOME" description="Choisissez une discussion" />
          <Gtk.Box $type="named" name="chat" orientation={Gtk.Orientation.VERTICAL}>
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
              <Composer store={store} chatId={store.current} toast={toast} />
            </Adw.Clamp>
          </Gtk.Box>
        </Gtk.Stack>
      </Adw.ToolbarView>
    </Adw.NavigationPage>
  );
}

