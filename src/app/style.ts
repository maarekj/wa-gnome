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
.day-separator {
  background: alpha(currentColor, 0.06);
  border-radius: 999px;
  padding: 2px 10px;
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
