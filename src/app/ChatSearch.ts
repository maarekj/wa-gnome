// Recherche dans la discussion ouverte : panneau à droite (saisie et résultats) ; un clic amène
// le message dans la conversation.
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';
import { createState, onCleanup, type Accessor } from 'gnim';
import type { SearchHit } from '../shared/api.ts';
import { errorMessage } from '../shared/errors.ts';
import { fmtDateTime, snippetMarkup } from '../shared/format.ts';
import type { Store } from '../shared/store.ts';
import { keyedListBox } from './KeyedBox.ts';

/** Résultats au plus dans une discussion. */
const LIMIT = 200;

const keyOf = (h: SearchHit): string => h.id;

/** Ligne d'un résultat : date, auteur, extrait (mots trouvés en gras). */
function resultRow(hit: SearchHit): Gtk.Widget {
  const row = new Gtk.ListBoxRow({ name: hit.id });
  const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2, marginTop: 8, marginBottom: 8, marginStart: 10, marginEnd: 10 });
  const who = hit.fromMe ? 'Vous' : (hit.senderName ?? hit.chatName);
  const top = new Gtk.Box({ spacing: 6 });
  top.append(new Gtk.Label({ label: who, xalign: 0, hexpand: true, ellipsize: Pango.EllipsizeMode.END, cssClasses: ['caption-heading'] }));
  top.append(new Gtk.Label({ label: fmtDateTime(hit.timestamp), cssClasses: ['caption', 'dim-label'] }));
  box.append(top);
  box.append(new Gtk.Label({ useMarkup: true, label: snippetMarkup(hit.snippet), xalign: 0, wrap: true, wrapMode: Pango.WrapMode.WORD_CHAR, lines: 3, ellipsize: Pango.EllipsizeMode.END, cssClasses: ['dim-label'] }));
  row.set_child(box);
  return row;
}

/**
 * Panneau de recherche (à placer à droite de la conversation) ; `open` le montre ou le cache,
 * `close` est appelé par Échap ou le bouton de fermeture.
 */
export function ChatSearch(store: Store, open: Accessor<boolean>, close: () => void): Gtk.Widget {
  const [hits, setHits] = createState<readonly SearchHit[]>([]);
  const entry = new Gtk.SearchEntry({ placeholderText: 'Rechercher dans la discussion', hexpand: true });
  const closeButton = new Gtk.Button({ iconName: 'window-close-symbolic', tooltipText: 'Fermer la recherche (Échap)', cssClasses: ['flat', 'circular'] });
  closeButton.connect('clicked', close);
  const top = new Gtk.Box({ spacing: 6, marginTop: 8, marginBottom: 8, marginStart: 8, marginEnd: 8 });
  top.append(entry);
  top.append(closeButton);
  const status = new Gtk.Label({ wrap: true, justify: Gtk.Justification.CENTER, cssClasses: ['dim-label'], marginTop: 24, marginStart: 12, marginEnd: 12 });
  const list = new Gtk.ListBox({ selectionMode: Gtk.SelectionMode.SINGLE, cssClasses: ['navigation-sidebar'] });
  onCleanup(keyedListBox(list, hits, keyOf, resultRow));
  list.connect('row-activated', (_l: Gtk.ListBox, row: Gtk.ListBoxRow) => {
    const hit = hits.peek().find((h) => h.id === row.name);
    if (hit !== undefined) store.openAt(hit.chatId, hit.id, hit.timestamp);
  });
  const inner = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
  inner.append(status);
  inner.append(list);
  const panel = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, widthRequest: 320, cssClasses: ['chat-search'] });
  panel.append(top);
  panel.append(new Gtk.Separator());
  panel.append(new Gtk.ScrolledWindow({ child: inner, vexpand: true, hscrollbarPolicy: Gtk.PolicyType.NEVER }));

  let timer = 0;
  let generation = 0;
  const run = (): void => {
    if (timer !== 0) GLib.source_remove(timer);
    timer = 0;
    const q = entry.text.trim();
    const chatId = store.current.peek();
    const gen = (generation += 1);
    // panneau fermé : relancée à son ouverture
    if (!open.peek()) return;
    if (q.length < 2 || chatId === null) {
      setHits([]);
      status.label = q === '' ? 'Saisissez un mot pour chercher dans les messages de cette discussion' : '';
      return;
    }
    timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
      timer = 0;
      void (async (): Promise<void> => {
        try {
          const found = await store.client.search(q, LIMIT, chatId);
          if (gen !== generation) return;
          setHits(found);
          status.label = found.length === 0 ? 'Aucun message trouvé' : found.length === 1 ? '1 message' : `${found.length >= LIMIT ? 'Plus de ' : ''}${found.length} messages`;
        } catch (error) {
          if (gen === generation) status.label = `Recherche impossible : ${errorMessage(error)}`;
        }
      })();
      return GLib.SOURCE_REMOVE;
    });
  };
  entry.connect('search-changed', run);
  // Échap : saisie vidée, panneau fermé
  entry.connect('stop-search', () => {
    entry.text = '';
    close();
  });
  // Entrée : premier résultat
  entry.connect('activate', () => {
    const first = list.get_row_at_index(0);
    if (first !== null) first.activate();
  });
  // autre discussion : recherche relancée sur celle-ci
  onCleanup(store.current.subscribe(run));
  // caché hors de l'animation : un révélateur replié garde sinon la largeur du panneau
  const revealer = new Gtk.Revealer({ child: panel, transitionType: Gtk.RevealerTransitionType.SLIDE_LEFT, revealChild: open.peek(), visible: open.peek() });
  revealer.connect('notify::child-revealed', () => {
    if (!revealer.childRevealed && !open.peek()) revealer.visible = false;
  });
  const sync = (): void => {
    if (open.peek()) revealer.visible = true;
    revealer.revealChild = open.peek();
    if (open.peek()) {
      run();
      GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        entry.grab_focus();
        return GLib.SOURCE_REMOVE;
      });
    }
  };
  onCleanup(open.subscribe(sync));
  run();
  return revealer;
}
