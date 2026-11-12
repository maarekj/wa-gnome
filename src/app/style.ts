// Feuille de style de l'application (chargée au démarrage).
export const STYLESHEET = `
.bubble {
  border-radius: 12px;
  padding: 6px 10px 4px 10px;
}
.bubble.incoming {
  background: alpha(currentColor, 0.07);
}
.bubble.outgoing {
  background: alpha(var(--accent-bg-color), 0.18);
}
.bubble.with-media {
  padding: 4px 4px 4px 4px;
}
.bubble.with-media > label {
  margin: 0 6px;
}
.sticker > label.caption {
  background: alpha(currentColor, 0.07);
  border-radius: 999px;
  padding: 0 8px;
}
.message-media.media-error {
  opacity: 0.5;
}
.document {
  padding: 6px 4px 2px 6px;
}
.audio {
  padding: 4px 4px 0 4px;
}
.speed {
  min-width: 36px;
  padding: 2px 6px;
}
.video-play {
  background: alpha(black, 0.55);
  color: white;
  border-radius: 999px;
  padding: 14px;
}
.video-duration {
  background: alpha(black, 0.55);
  color: white;
  border-radius: 999px;
  padding: 1px 8px;
}
.quote {
  border-left: 3px solid var(--accent-color);
  background: alpha(currentColor, 0.06);
  border-radius: 6px;
  padding: 4px 8px;
  margin-bottom: 2px;
}
.quote.mine {
  border-left-color: alpha(currentColor, 0.5);
}
.bubble.with-media > .quote {
  margin: 2px 2px 4px 2px;
}
.reply-banner {
  border-left: 3px solid var(--accent-color);
  background: alpha(currentColor, 0.05);
  border-radius: 8px;
  padding: 4px 4px 4px 10px;
}
.selected-message > .bubble,
.selected-message > .sticker {
  outline: 2px solid var(--accent-color);
  outline-offset: 2px;
  background-image: linear-gradient(alpha(var(--accent-bg-color), 0.18), alpha(var(--accent-bg-color), 0.18));
}
.message-line.selected-message {
  background-color: alpha(var(--accent-bg-color), 0.12);
  border-radius: 8px;
}
.accent-swatch {
  border-radius: 9999px;
  padding: 0;
  min-width: 34px;
  min-height: 34px;
  box-shadow: inset 0 0 0 1px alpha(currentColor, 0.15);
}
.accent-swatch.system {
  background: linear-gradient(135deg, #3584e4 0%, #3584e4 50%, #2190a4 50%, #2190a4 100%);
}
.accent-swatch .check {
  color: white;
  opacity: 0;
}
.accent-swatch:checked .check {
  opacity: 1;
}
.accent-swatch:checked {
  outline: 2px solid alpha(currentColor, 0.6);
  outline-offset: 2px;
}
.gallery-tile {
  border-radius: 6px;
}
.recording-bar {
  min-height: 46px;
  padding: 4px 0;
}
.recording-dot {
  color: var(--destructive-color);
}
.bubble.emoji-only {
  background: none;
  box-shadow: none;
}
.bubble.emoji-only > box:last-child {
  background: alpha(var(--view-bg-color), 0.85);
  border-radius: 999px;
  padding: 0 6px;
}
.body.emoji-1 {
  font-size: 48px;
  line-height: 1.1;
}
.body.emoji-3 {
  font-size: 34px;
  line-height: 1.1;
}
.translation {
  margin-top: 4px;
  padding-top: 4px;
  border-top: 1px solid alpha(currentColor, 0.12);
}
.bubble.with-media > .translation {
  margin: 4px 6px 0 6px;
}
.transcript {
  font-style: italic;
}
.chat-title {
  padding: 2px 10px;
}
.chat-search {
  border-left: 1px solid var(--border-color);
  background: var(--sidebar-bg-color);
}
.side-resize:hover {
  background: alpha(var(--accent-bg-color), 0.35);
}
.summary-card {
  padding: 10px 12px;
}
.selection-bar {
  min-height: 46px;
}
.forwarded label {
  font-style: italic;
}
.bubble.flash {
  outline: 2px solid var(--accent-color);
  outline-offset: 2px;
}
.reactions {
  margin: -6px 10px 2px 10px;
}
.reaction-chip {
  min-height: 22px;
  padding: 0 7px;
  border-radius: 999px;
  background: var(--window-bg-color);
  box-shadow: 0 0 0 1px alpha(currentColor, 0.12);
  font-size: 0.9em;
}
.reaction-chip.mine {
  background: alpha(var(--accent-bg-color), 0.2);
  box-shadow: 0 0 0 1px alpha(var(--accent-bg-color), 0.5);
}
.reaction-chip.filter:checked {
  background: alpha(var(--accent-bg-color), 0.2);
}
.reaction-pick {
  font-size: 1.3em;
  padding: 2px 6px;
}
.reaction-pick.mine {
  background: alpha(var(--accent-bg-color), 0.2);
}
.reaction-emoji {
  font-size: 1.4em;
}
.reaction-people {
  background: none;
}
.ticks {
  opacity: 0.65;
  font-weight: 900;
  font-size: 0.95em;
  /* chevauchement léger : deux coches lisibles quelle que soit la police */
  letter-spacing: -0.25em;
  margin-right: 3px;
}
.ticks.read,
.ticks.played {
  opacity: 1;
  color: #1d9bf0;
}
.ticks.error {
  opacity: 1;
  color: var(--error-color);
  letter-spacing: 0;
}
.ticks.pending {
  letter-spacing: 0;
  font-size: 0.75em;
}
.ticks.info-ticks {
  font-size: 1em;
  letter-spacing: -0.25em;
  margin-right: 6px;
}
.info-preview {
  background: alpha(currentColor, 0.04);
  border-radius: 12px;
  padding: 16px;
}
.ticks.delivered {
  opacity: 0.65;
}
.deleted-text {
  font-style: italic;
}
.edited-mark {
  font-style: italic;
}
.day-separator {
  background: alpha(currentColor, 0.06);
  border-radius: 999px;
  padding: 2px 10px;
}
/* appel qui sonne, en surimpression */
.call-banner {
  padding: 12px 14px;
  box-shadow: 0 6px 24px alpha(black, 0.25);
}
.call-banner .ringing {
  color: var(--success-color);
}
/* statuts : cercle autour de la photo (accentué s'il y a du nouveau), cadre, texte */
.status-ring {
  border-radius: 999px;
  outline: 2px solid var(--accent-bg-color);
  outline-offset: 2px;
}
.status-ring.seen {
  outline-color: alpha(currentColor, 0.25);
}
.status-frame {
  background: black;
  border-radius: 12px;
  margin: 8px 10px;
}
.status-text {
  font-size: 22pt;
  font-weight: bold;
}
/* bandeau des messages épinglés */
.pinned-bar {
  border-radius: 0;
  padding: 6px 14px;
  background: var(--headerbar-bg-color);
  border-bottom: 1px solid var(--border-color);
}
/* ligne d'un appel ; manqué : en rouge, comme sur le téléphone */
.call-line {
  background: alpha(currentColor, 0.06);
  border-radius: 999px;
  padding: 3px 12px;
}
.call-line.missed {
  color: var(--error-color);
}
.unread-badge {
  background: var(--accent-bg-color);
  color: var(--accent-fg-color);
  border-radius: 999px;
  min-width: 20px;
  padding: 0 6px;
  font-size: 0.8em;
  font-weight: bold;
}
.unread-badge.muted {
  background: alpha(currentColor, 0.15);
  color: alpha(currentColor, 0.8);
}
.unread-badge.dot {
  min-width: 10px;
  min-height: 10px;
  padding: 0;
}
.list-filters flowboxchild.filter-cell {
  padding: 0;
  background: none;
}
.filter-chip {
  padding: 2px 12px;
  min-height: 24px;
  font-size: 0.9em;
}
.archived-entry {
  padding: 8px 0;
}
.attachment {
  background: alpha(currentColor, 0.06);
  border-radius: 10px;
  padding: 4px 4px 4px 6px;
}
.chat-drop.drop-target {
  outline: 2px dashed var(--accent-color);
  outline-offset: -6px;
  border-radius: 12px;
  background: alpha(var(--accent-bg-color), 0.06);
}
.composer-entry {
  background: alpha(currentColor, 0.06);
  border-radius: 18px;
}
.composer-entry textview {
  background: transparent;
}
.qr-frame {
  padding: 12px;
  background: white;
}
`;
