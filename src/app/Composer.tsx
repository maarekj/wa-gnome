// Zone de saisie : texte, mentions, pièces jointes, vocal, émojis, réponse et modification.
import Gdk from 'gi://Gdk?version=4.0';
import type Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';
import { createMemo, createState, onCleanup, type Accessor } from 'gnim';
import { uploadKind } from '../shared/api.ts';
import { errorMessage } from '../shared/errors.ts';
import { fmtDateTime } from '../shared/format.ts';
import type { Store } from '../shared/store.ts';
import { type Attachment, attachmentChip, fromFile, fromTexture, pasteAttachments, pickFiles } from './Attachments.ts';
import { ScheduledBar, scheduleButton } from './Schedule.ts';
import { mentionPicker, type MentionPicker, resolveMentions } from './MentionPicker.ts';
import { fmtRecording, Recorder } from './Recorder.ts';
import { keyedBox } from './KeyedBox.ts';
import type { Pictures } from './pictures.ts';
import { quotePreview } from './Bubble.tsx';

/** Composer : `register` reçoit la fonction d'ajout de fichiers (dépôt sur toute la conversation). */
export function Composer({
  store,
  chatId,
  toast,
  register,
  pictures,
}: {
  store: Store;
  chatId: Accessor<string | null>;
  toast: (text: string) => void;
  register: (add: (files: Gio.File[]) => void) => void;
  pictures: Pictures;
}): JSX.Element {
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
        await store.client.sendFile(id, {
          bytes: rec.bytes,
          mimetype: 'audio/ogg; codecs=opus',
          name: 'vocal.ogg',
          caption: '',
          asDocument: false,
          voice: { seconds: rec.seconds, waveform: rec.waveform },
          ...(replyTo === undefined ? {} : { replyTo }),
        });
        store.setReplyTo(null);
      } catch (error) {
        toast(`Envoi du vocal impossible : ${errorMessage(error)}`);
      } finally {
        setSending(false);
      }
    })();
  };
  // autre discussion : enregistrement abandonné
  onCleanup(
    chatId.subscribe(() => {
      if (recorder !== null) cancelRecording();
    }),
  );

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
        await store.client.sendFile(id, {
          bytes: f.bytes,
          mimetype: f.mimetype,
          name: f.name,
          caption: i === 0 ? text : '',
          asDocument: asDocument.peek(),
          ...(i === 0 && replyTo !== undefined ? { replyTo } : {}),
        });
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
          <Gtk.Label
            label={store.editing((m) => (m === null || m.kind === 'text' ? 'Modification du message' : 'Modification de la légende'))}
            xalign={0}
            cssClasses={['caption-heading', 'accent']}
          />
          <Gtk.Label
            label={store.editing((m) => m?.text.replaceAll('\n', ' ') ?? '')}
            xalign={0}
            ellipsize={Pango.EllipsizeMode.END}
            cssClasses={['caption']}
          />
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
          <Gtk.Label
            label={store.replyTo((r) => (r === null ? '' : quotePreview(r)))}
            xalign={0}
            ellipsize={Pango.EllipsizeMode.END}
            cssClasses={['caption']}
          />
        </Gtk.Box>
        <Gtk.Button
          iconName="window-close-symbolic"
          tooltipText="Annuler la réponse (Échap)"
          valign={Gtk.Align.CENTER}
          cssClasses={['flat', 'circular']}
          onClicked={() => store.setReplyTo(null)}
        />
      </Gtk.Box>
      {/* messages programmés de la discussion (annulables) */}
      {ScheduledBar(store, toast)}
      <Gtk.Box spacing={6} visible={attachments((l) => l.length > 0)}>
        <Gtk.ScrolledWindow hexpand vscrollbarPolicy={Gtk.PolicyType.NEVER} propagateNaturalHeight>
          <Gtk.Box
            spacing={6}
            $={(self: Gtk.Box) => {
              onCleanup(
                keyedBox(
                  self,
                  attachments,
                  (a) => String(a.id),
                  (a) => attachmentChip(a, () => setAttachments(attachments.peek().filter((x) => x.id !== a.id))),
                ),
              );
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
        <Gtk.Button
          iconName="user-trash-symbolic"
          tooltipText="Annuler le vocal"
          valign={Gtk.Align.CENTER}
          cssClasses={['circular', 'flat']}
          onClicked={cancelRecording}
        />
        <Gtk.Image iconName="media-record-symbolic" cssClasses={['recording-dot']} />
        <Gtk.Label label={recording((r) => fmtRecording(r?.seconds ?? 0))} cssClasses={['numeric']} widthChars={5} xalign={0} />
        <Gtk.LevelBar hexpand valign={Gtk.Align.CENTER} heightRequest={6} value={recording((r) => r?.level ?? 0)} cssClasses={['recording-level']} />
        <Gtk.Button
          iconName="mail-send-symbolic"
          tooltipText="Envoyer le vocal"
          valign={Gtk.Align.CENTER}
          cssClasses={['circular', 'suggested-action']}
          onClicked={sendRecording}
        />
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
            // créé à la première ouverture (des milliers d'émojis à construire : pas au lancement)
            self.set_create_popup_func(() => {
              if (self.popover !== null) return;
              const chooser = new Gtk.EmojiChooser();
              chooser.connect('emoji-picked', (_c: Gtk.EmojiChooser, text: string) => {
                if (view === null) return;
                // texte sélectionné : remplacé par l'émoji (comme une frappe)
                view.buffer.delete_selection(true, true);
                view.buffer.insert_at_cursor(text, -1);
                view.grab_focus();
              });
              self.popover = chooser;
            });
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
        {/* zone de saisie : la liste des mentions (@) est rattachée au parent de ce ScrolledWindow */}
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
        <Gtk.Stack
          valign={Gtk.Align.END}
          visibleChildName={createMemo(() => (empty() && attachments().length === 0 && store.editing() === null ? 'mic' : 'send'))}
          transitionType={Gtk.StackTransitionType.CROSSFADE}
        >
          <Gtk.Button
            $type="named"
            name="send"
            iconName="mail-send-symbolic"
            tooltipText="Envoyer"
            sensitive={sending((s) => !s)}
            cssClasses={['circular', 'suggested-action']}
            onClicked={send}
          />
          <Gtk.Button
            $type="named"
            name="mic"
            iconName="audio-input-microphone-symbolic"
            tooltipText="Enregistrer un message vocal"
            sensitive={sending((s) => !s)}
            cssClasses={['circular', 'suggested-action']}
            onClicked={startRecording}
          />
        </Gtk.Stack>
      </Gtk.Box>
    </Gtk.Box>
  );
}
