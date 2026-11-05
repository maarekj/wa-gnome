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
.filter-chip {
  padding: 2px 12px;
  min-height: 24px;
  font-size: 0.9em;
}
.archived-entry {
  padding: 8px 0;
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
