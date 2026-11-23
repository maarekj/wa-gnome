// Discussion ouverte : messages (bulles, séparateurs de jour) et zone de saisie.
import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import type Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';
import { createMemo, createState, onCleanup } from 'gnim';
import { type ChatAction, ephemeralText, isMuted, type Message, READ_ONLY_TEXT } from '../shared/api.ts';
import { errorMessage } from '../shared/errors.ts';
import { type Store } from '../shared/store.ts';
import { attachDrop } from './Attachments.ts';
import { avatarText, isChannel } from './ChatList.tsx';
import { openMessageInfo } from './MessageInfo.ts';
import { ChatSearch } from './ChatSearch.ts';
import { rememberSidePanelWidth, setChatVoiceLanguage, settings, sidePanelWidth, WHISPER_MODELS, type WhisperModel } from './Preferences.ts';
import { DownloadCancelled } from './Whisper.ts';
import { startSummary, SummaryPanel, summaries, summaryKey } from './Summary.ts';
import { downloadWhisper, MissingModel, translateMessage } from './Translate.ts';
import { attachDragSelect } from './DragSelect.ts';
import { openGallery } from './Gallery.ts';
import { openChatInfo } from './ChatInfoDialog.ts';
import { confirmRemoveMany, copyText, openForward } from './Selection.ts';
import { keyedBox } from './KeyedBox.ts';
import { type Command, provideCommands } from './CommandPalette.ts';
import { tabBar } from './Tabs.ts';
import { playbackBar } from './PlaybackBar.ts';
import { PERF, perfCount, perfMark } from './Perf.ts';
import { bindAvatar, type Pictures } from './pictures.ts';
import { MediaLoader, type Photo } from './media.ts';
import { bubble, findBubble, forwardable, type Item, itemsOf, presenceLine, quotePreview } from './Bubble.tsx';
import { Composer } from './Composer.tsx';

/** « le message sélectionné », « les 3 messages sélectionnés » */
const countLabel = (n: number): string => (n === 1 ? 'le message sélectionné' : `les ${n} messages sélectionnés`);

/** Éléments affichés à l'ouverture d'une discussion, puis ajoutés par image (voir `items`). */
const FIRST_ITEMS = 6;
/** durée visée d'une image de l'affichage progressif (µs) : le lot suivant s'y adapte */
const GROW_BUDGET = 40_000;

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
      const next = store.pins
        .peek()
        .map((p) => p.id)
        .join(',');
      if (next !== ids) index = 0;
      ids = next;
      show();
    }),
  );
  show();
  return bar;
}

/** Suppression d'un message, après confirmation (comme WhatsApp). */
function confirmRemove(parent: Gtk.Widget, store: Store, m: Message, action: 'revoke' | 'delete-for-me', toast: (t: string) => void): void {
  const forAll = action === 'revoke';
  const dialog = new Adw.AlertDialog({
    heading: forAll ? 'Supprimer pour tous ?' : 'Supprimer pour moi ?',
    body: forAll
      ? 'Le message sera remplacé par « Ce message a été supprimé » pour tous les participants.'
      : 'Le message sera supprimé de cet ordinateur et de vos autres appareils. Les autres participants le verront toujours.',
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

export function ConversationPage({
  store,
  pictures,
  toast,
  panels,
  selectAccount,
}: {
  store: Store;
  pictures: Pictures;
  toast: (text: string) => void;
  panels?: (split: Adw.OverlaySplitView) => void;
  /** affiche un autre compte et renvoie son store (barre du lecteur : vocal d'un autre compte) */
  selectAccount?: (account: string) => Store | null;
}): JSX.Element {
  const chat = createMemo(() => {
    const id = store.current();
    // nom et type suivis : la liste des discussions est mise à jour en direct
    const c = id === null ? undefined : store.chats().find((x) => x.id === id);
    return id === null
      ? null
      : { id, name: c?.name ?? store.nameHint(id) ?? id.split('@')[0] ?? id, group: c?.group ?? id.endsWith('@g.us'), ephemeral: c?.ephemeral ?? 0 };
  });
  /** groupe où seuls les administrateurs écrivent (et je n'en suis pas un) */
  const readOnly = createMemo(() => {
    const id = store.current();
    return id === null ? null : (store.chats().find((c) => c.id === id)?.readOnly ?? null);
  });
  // groupe ou non seulement : un changement de la liste des discussions ne recalcule rien ici
  const group = createMemo(() => chat()?.group ?? false);
  let previousItems = new Map<string, Item>();
  const allItems = createMemo(() => {
    const list = itemsOf(store.messages(), group(), previousItems);
    previousItems = new Map(list.map((it) => [it.key, it]));
    return list;
  });
  // ouverture : les derniers messages d'abord (une image), puis le reste par lots, une image
  // chacun (la mise en page de longs messages coûte : l'écran n'en montre que quelques-uns)
  const [shownCount, setShownCount] = createState(FIRST_ITEMS);
  const items = createMemo(() => {
    const all = allItems();
    const n = shownCount();
    return n >= all.length ? all : all.slice(all.length - n);
  });
  /** tous les messages chargés affichés (recherche, citation : message cherché dans la page) */
  const showAll = (): void => setShownCount(Number.POSITIVE_INFINITY);
  onCleanup(
    store.current.subscribe(() => {
      setShownCount(FIRST_ITEMS);
    }),
  );
  const loader = new MediaLoader(store.client);
  /** fenêtre défilante de la conversation (défilement vers un message cité) */
  let scroller: Gtk.ScrolledWindow | null = null;
  /** Message `id` à l'écran (s'il est chargé), brièvement mis en évidence. */
  const scrollToMessage = (box: Gtk.Box, id: string, flash = true): boolean => {
    // affichage progressif en cours : tout afficher, puis viser le message une fois mis en page
    if (Number.isFinite(shownCount.peek()) && store.messages.peek().some((m) => m.id === id)) {
      showAll();
      let frames = 0;
      box.add_tick_callback(() => {
        frames += 1;
        if (frames < 3) return GLib.SOURCE_CONTINUE;
        scrollToMessage(box, id, flash);
        return GLib.SOURCE_REMOVE;
      });
      return true;
    }
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
          await translateMessage(m, {
            ...(m.kind === 'audio' && media !== null ? { file: () => loader.file(m, media) } : {}),
            translate: mode === 'translate',
            ...(lang === undefined ? {} : { lang }),
          });
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
  /** Résumé par IA des messages sélectionnés, dans le panneau de droite. */
  const summarize = (): void => {
    startSummary(summariesKey.peek(), chat.peek()?.name ?? '', selected(), (m) =>
      m.media === null ? Promise.reject(new Error('pas de média')) : loader.file(m, m.media),
    );
    setSummarizing(true);
    clearSelection();
  };
  // palette de commandes : actions de la discussion ouverte
  onCleanup(
    provideCommands(() => {
      const c = chat.peek();
      const full = c === null ? undefined : store.chat(c.id);
      const parent = scroller;
      if (c === null || parent === null) return [];
      const act = (action: ChatAction) => (): void => {
        store.chatAction(c.id, action).catch((error: unknown) => toast(errorMessage(error)));
      };
      // messages sélectionnés : traduire, transcrire (vocaux), résumer
      const chosen = selected();
      const forSelection: Command[] =
        chosen.length === 0
          ? []
          : [
              {
                title: `Traduire ${countLabel(chosen.length)}`,
                icon: 'preferences-desktop-locale-symbolic',
                keywords: 'traduction sélection',
                run: () => {
                  translateAll(parent, chosen, 'translate');
                  clearSelection();
                },
              },
              ...(chosen.some((m) => m.kind === 'audio')
                ? [
                    {
                      title: 'Transcrire les vocaux sélectionnés',
                      icon: 'audio-input-microphone-symbolic',
                      keywords: 'transcription vocal audio texte sélection',
                      run: () => {
                        translateAll(parent, chosen, 'transcribe');
                        clearSelection();
                      },
                    },
                  ]
                : []),
              {
                title: `Résumer ${countLabel(chosen.length)} (IA)`,
                icon: 'view-list-bullet-symbolic',
                keywords: 'résumé ia synthèse sélection',
                run: summarize,
              },
            ];
      return [
        ...forSelection,
        { title: 'Rechercher dans la discussion', icon: 'system-search-symbolic', accel: '<Control>f', run: () => setSearching(true) },
        {
          title: 'Médias, liens et documents',
          icon: 'image-x-generic-symbolic',
          keywords: 'galerie photos fichiers',
          run: () => openGallery(parent, store, loader, c.id, c.name, toast),
        },
        {
          title: c.group ? 'Infos du groupe' : 'Infos du contact',
          icon: 'contact-new-symbolic',
          keywords: 'fiche membres',
          run: () =>
            openChatInfo(parent, store, pictures, c.id, c.name, {
              toast,
              search: () => setSearching(true),
              gallery: () => openGallery(parent, store, loader, c.id, c.name, toast),
            }),
        },
        full?.archived === true
          ? { title: 'Désarchiver la discussion', icon: 'folder-symbolic', run: act({ action: 'archive', value: false }) }
          : { title: 'Archiver la discussion', icon: 'folder-symbolic', run: act({ action: 'archive', value: true }) },
        (full?.pinned ?? 0) > 0
          ? { title: 'Désépingler la discussion', icon: 'view-pin-symbolic', run: act({ action: 'pin', value: false }) }
          : { title: 'Épingler la discussion', icon: 'view-pin-symbolic', run: act({ action: 'pin', value: true }) },
        full !== undefined && isMuted(full)
          ? { title: 'Réactiver les notifications', icon: 'notifications-symbolic', keywords: 'silencieux', run: act({ action: 'mute', until: null }) }
          : {
              title: 'Mode silencieux (8 heures)',
              icon: 'notifications-disabled-symbolic',
              keywords: 'muet notifications',
              run: act({ action: 'mute', until: Date.now() + 8 * 3_600_000 }),
            },
        { title: 'Marquer comme non lue', icon: 'mail-unread-symbolic', run: act({ action: 'unread', value: true }) },
      ];
    }),
  );
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
              openChatInfo(b, store, pictures, c.id, c.name, {
                toast,
                search: () => setSearching(true),
                gallery: () => openGallery(b, store, loader, c.id, c.name, toast),
              });
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
                      return c === null ? null : pictures.texture(c.id, true)();
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
        {/* onglets des discussions ouvertes */}
        <Gtk.Box $type="top">{tabBar(store, pictures)}</Gtk.Box>
        {/* vocal en cours (toutes discussions confondues) */}
        <Gtk.Box $type="top">{playbackBar(store, selectAccount)}</Gtk.Box>
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
                    // messages chargés pas encore affichés (affichage progressif) : eux d'abord
                    if (settled && adj.upper > adj.pageSize && adj.value < 400 && Number.isFinite(shownCount.peek())) showAll();
                    else if (settled && adj.upper > adj.pageSize && adj.value < 400 && store.older.peek() === 'idle') {
                      // remonté jusqu'aux anciens messages : l'onglet temporaire devient un onglet normal
                      store.keepTab(store.current.peek());
                      void store.loadOlder();
                    }
                  });
                  // page ajoutée en tête (ou lot de l'affichage progressif) : la position à l'écran reste la même
                  let firstId = '';
                  onCleanup(
                    items.subscribe(() => {
                      const first = items.peek()[0]?.key ?? '';
                      if (firstId !== '' && first !== firstId && !stick) anchor = adj.upper - adj.value;
                      firstId = first;
                    }),
                  );
                  // mesure : images dessinées avec le dernier message sous le bas de la vue alors qu'elle
                  // y est collée (position réelle du contenu, pas celle de l'ajustement)
                  if (PERF) {
                    self.connect('map', () => {
                      self.get_frame_clock()?.connect('after-paint', () => {
                        if (!stick || conversation === null) return;
                        const [ok, bounds] = conversation.compute_bounds(self);
                        if (ok && bounds.get_y() + bounds.get_height() > self.get_height() + 1) perfCount('décalée');
                      });
                    });
                  }
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
                      <Gtk.Button
                        $type="named"
                        name="more"
                        label="Messages plus anciens"
                        tooltipText="Charger les messages plus anciens"
                        cssClasses={['flat', 'caption']}
                        onClicked={() => {
                          store.keepTab(store.current.peek());
                          void store.loadOlder();
                        }}
                      />
                      <Gtk.Box $type="named" name="loading" spacing={8}>
                        <Adw.Spinner />
                        <Gtk.Label
                          label={store.older((s) => (s === 'phone' ? 'Demande au téléphone…' : 'Chargement…'))}
                          cssClasses={['caption', 'dim-label']}
                        />
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
                        attachDragSelect(
                          self,
                          () => scroller,
                          () => selection.peek(),
                          setSelection,
                          () => store.focusComposer(),
                        );
                        // lots suivants : à l'image d'après (la précédente est dessinée)
                        // taille du lot adaptée à la durée de l'image précédente (longs messages : lots petits)
                        let grow = 0;
                        let step = FIRST_ITEMS;
                        const scheduleGrow = (): void => {
                          if (grow !== 0 || shownCount.peek() >= allItems.peek().length) {
                            if (grow === 0 && Number.isFinite(shownCount.peek()) && allItems.peek().length > 0) {
                              showAll();
                              perfMark('complète');
                            }
                            return;
                          }
                          // lot précédent posé à l'instant : sa mise en page et son dessin se font dans
                          // l'image en cours ; mesurés au début de la suivante
                          const placedAt = GLib.get_monotonic_time();
                          grow = self.add_tick_callback(() => {
                            grow = 0;
                            const spent = GLib.get_monotonic_time() - placedAt;
                            // lot ajusté à la durée visée, au plus doublé d'une fois à l'autre
                            step = Math.max(1, Math.min(step * 2, 50, Math.round((step * GROW_BUDGET) / Math.max(spent, 1))));
                            setShownCount(shownCount.peek() + step);
                            return GLib.SOURCE_REMOVE;
                          });
                        };
                        onCleanup(
                          store.current.subscribe(() => {
                            step = FIRST_ITEMS;
                          }),
                        );
                        onCleanup(items.subscribe(scheduleGrow));
                        onCleanup(() => {
                          if (grow !== 0) self.remove_tick_callback(grow);
                        });
                        onCleanup(
                          keyedBox(
                            self,
                            items,
                            (it) => it.key,
                            bubble({
                              loader,
                              toast,
                              chatName: () => chat.peek()?.name ?? '',
                              account: store.client.account,
                              photos: () =>
                                store.messages.peek().filter((x): x is Photo => x.kind === 'image' && x.media !== null && !x.deleted && !x.viewOnce),
                              pictures,
                              info: (m) => openMessageInfo(self, store, pictures, m, toast),
                              edit: (m) => store.setEditing(m),
                              remove: (parent, m, action) => confirmRemove(parent, store, m, action, toast),
                              selection,
                              toggleSelect,
                              forward: (parent, m) => openForward(parent, store, pictures, [m], toast, clearSelection),
                              openPerson: (id, name) => store.startChat(id, name),
                              openAuthor: (m) => {
                                if (m.sender !== null && !m.fromMe) store.startChat(m.sender, m.senderName ?? m.sender.split('@')[0] ?? '');
                              },
                              translate: (parent, m, mode, lang) => translateAll(parent, [m], mode, lang),
                              pinned: () => new Set(store.pins.peek().map((p) => p.id)),
                              pin: (m, duration) => pinMessage(m, duration),
                              me: () => store.status.peek().me?.id ?? null,
                              vote: (m, options) =>
                                void store.client
                                  .messageAction(m.chatId, m.id, { action: 'vote', options: [...options] })
                                  .catch((error: unknown) => toast(`Vote impossible : ${errorMessage(error)}`)),
                              reply: (m) => store.setReplyTo(m),
                              react: (m, emoji) =>
                                void store.client.react(m.chatId, m.id, emoji).catch((error: unknown) => toast(`Réaction impossible : ${errorMessage(error)}`)),
                              scrollTo: (id) => scrollToMessage(self, id),
                            }),
                          ),
                        );
                        // éléments insérés au-dessus (lot de l'affichage progressif, page plus ancienne,
                        // premier remplissage) : défilement décalé d'autant, dans la même image. Le contenu
                        // affiché ne bouge pas (rattrapé après coup, une image serait dessinée décalée).
                        // Après keyedBox : abonné ensuite, appelé après sa mise à jour des enfants.
                        let top: Gtk.Widget | null = self.get_first_child();
                        onCleanup(
                          items.subscribe(() => {
                            const before = top;
                            top = self.get_first_child();
                            const sw = scroller;
                            // ancien premier retiré (message supprimé, autre discussion) : rien d'inséré au-dessus
                            if (sw === null || top === before || !self.get_mapped() || (before !== null && before.get_parent() !== self)) return;
                            let added = 0;
                            const width = self.get_width();
                            for (let c = top; c !== null && c !== before; c = c.get_next_sibling()) {
                              if (!c.visible) continue;
                              const [, natural] = c.measure(Gtk.Orientation.VERTICAL, width);
                              added += natural + self.spacing;
                            }
                            const v = sw.vadjustment;
                            if (added > 0) v.configure(v.value + added, v.lower, v.upper + added, v.stepIncrement, v.pageIncrement, v.pageSize);
                          }),
                        );
                      }}
                    />
                  </Gtk.Box>
                </Adw.Clamp>
              </Gtk.ScrolledWindow>
              <Adw.Clamp maximumSize={860} tighteningThreshold={600}>
                <Gtk.Stack
                  visibleChildName={createMemo(() => (selection().size > 0 ? 'select' : isChannel(store.current() ?? '') ? 'channel' : 'compose'))}
                  transitionType={Gtk.StackTransitionType.CROSSFADE}
                >
                  {/* chaîne : lecture seule */}
                  <Gtk.Label
                    $type="named"
                    name="channel"
                    label="Chaîne : seuls ses administrateurs peuvent publier"
                    marginTop={14}
                    marginBottom={14}
                    cssClasses={['dim-label', 'caption']}
                  />
                  <Gtk.Box
                    $type="named"
                    name="select"
                    spacing={6}
                    marginStart={12}
                    marginEnd={12}
                    marginTop={8}
                    marginBottom={8}
                    cssClasses={['selection-bar']}
                  >
                    <Gtk.Button
                      iconName="window-close-symbolic"
                      tooltipText="Annuler la sélection (Échap)"
                      cssClasses={['circular', 'flat']}
                      onClicked={clearSelection}
                    />
                    <Gtk.Label
                      hexpand
                      xalign={0}
                      label={selection((s) => (s.size === 1 ? '1 message sélectionné' : `${s.size} messages sélectionnés`))}
                      cssClasses={['heading']}
                    />
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
                    <Gtk.Button iconName="view-list-bullet-symbolic" tooltipText="Résumer (IA)" cssClasses={['circular', 'flat']} onClicked={summarize} />
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
                    <Gtk.Button
                      iconName="user-trash-symbolic"
                      tooltipText="Supprimer"
                      cssClasses={['circular', 'flat', 'destructive-action']}
                      onClicked={(b: Gtk.Button) => confirmRemoveMany(b, store, selected(), toast, clearSelection)}
                    />
                  </Gtk.Box>
                  <Gtk.Box $type="named" name="compose" orientation={Gtk.Orientation.VERTICAL}>
                    {/* groupe réservé aux administrateurs, ou quitté : pas de zone de saisie (comme WhatsApp) */}
                    <Gtk.Label
                      label={readOnly((r) => (r === null ? '' : READ_ONLY_TEXT[r]))}
                      visible={readOnly((r) => r !== null)}
                      cssClasses={['dim-label', 'read-only-chat']}
                      wrap
                      justify={Gtk.Justification.CENTER}
                    />
                    <Gtk.Box orientation={Gtk.Orientation.VERTICAL} visible={readOnly((r) => r === null)}>
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
