// Mise en forme : échappement Pango, dates.
import GLib from 'gi://GLib';
import { HIT_END, HIT_START } from './api.ts';

/** Texte échappé pour le balisage Pango (titres d'Adw.ActionRow, etc.). */
export const esc = (s: string): string => GLib.markup_escape_text(s, -1);

/** Heure d'un message (`14:05`). */
export function fmtTime(seconds: number): string {
  return GLib.DateTime.new_from_unix_local(seconds)?.format('%H:%M') ?? '';
}

/** Date courte pour la liste : heure aujourd'hui, « Hier », jour de la semaine, sinon date. */
export function fmtShortDate(seconds: number, now = GLib.DateTime.new_now_local()): string {
  if (seconds <= 0) return '';
  const d = GLib.DateTime.new_from_unix_local(seconds);
  if (d === null) return '';
  const days = Math.round(dayIndex(now) - dayIndex(d));
  if (days <= 0) return d.format('%H:%M') ?? '';
  if (days === 1) return 'Hier';
  if (days < 7) return d.format('%A') ?? '';
  return d.format('%d/%m/%Y') ?? '';
}

/** Date et heure : l'heure seule aujourd'hui, sinon date courte (« Hier », jour, date) et heure. */
export function fmtDateTime(seconds: number, now = GLib.DateTime.new_now_local()): string {
  const d = GLib.DateTime.new_from_unix_local(seconds);
  if (d === null || seconds <= 0) return '';
  const time = d.format('%H:%M') ?? '';
  return Math.round(dayIndex(now) - dayIndex(d)) <= 0 ? time : `${fmtShortDate(seconds, now)} ${time}`;
}

/** Libellé du séparateur de jour dans une conversation. */
export function fmtDay(seconds: number, now = GLib.DateTime.new_now_local()): string {
  const d = GLib.DateTime.new_from_unix_local(seconds);
  if (d === null) return '';
  const days = Math.round(dayIndex(now) - dayIndex(d));
  if (days <= 0) return "Aujourd'hui";
  if (days === 1) return 'Hier';
  return d.format('%A %e %B %Y') ?? '';
}

/** Numéro du jour local (pour comparer deux dates au jour près). */
const dayIndex = (d: GLib.DateTime): number => {
  const local = GLib.DateTime.new_local(d.get_year(), d.get_month(), d.get_day_of_month(), 0, 0, 0);
  return (local?.to_unix() ?? 0) / 86_400;
};

/** Clé de jour (`2026-11-05`) pour grouper les messages. */
export const dayKey = (seconds: number): string => GLib.DateTime.new_from_unix_local(seconds)?.format('%F') ?? '';

// ---------------------------------------------------------------- mise en forme WhatsApp

/** Marqueurs en ligne → balise Pango. */
const INLINE: Readonly<Record<string, readonly [string, string]>> = {
  '*': ['<b>', '</b>'],
  _: ['<i>', '</i>'],
  '~': ['<s>', '</s>'],
};
/** Code (en ligne et bloc) : police à chasse fixe sur fond léger. */
const CODE_OPEN = '<span font_family="monospace" background="#8080804d">';
/** Barre de citation. */
const QUOTE_BAR = '<span foreground="#80808099">▍</span> ';

/** Espace, ponctuation ou bord de texte : un marqueur peut s'y ouvrir ou s'y fermer. */
const isBoundary = (c: string | undefined): boolean => c === undefined || /[\s\p{P}\p{S}]/u.test(c);
const isSpace = (c: string | undefined): boolean => c === undefined || /\s/u.test(c);

/** Fin d'un marqueur `c` ouvert en `i` (règles de WhatsApp), ou -1. */
function closing(s: string, i: number, c: string): number {
  if (!isBoundary(s[i - 1]) || isSpace(s[i + 1]) || s[i + 1] === c) return -1;
  for (let j = i + 2; j < s.length; j++) {
    // lien : ses « _ », « * », « ~ » ne ferment rien
    const link = c === '`' ? null : linkAt(s, j);
    if (link !== null) {
      j += link.text.length - 1;
      continue;
    }
    if (s[j] === c && !isSpace(s[j - 1]) && isBoundary(s[j + 1])) return j;
  }
  return -1;
}

/** Début d'adresse web ou e-mail. */
const URL_START = /^(?:https?:\/\/|www\.)[^\s<>"]+/iu;
const EMAIL = /^[\w.+-]+@[\w-]+(?:\.[\w-]+)+/u;

/**
 * Lien commençant en `i` (adresse web ou e-mail, en début de mot), ponctuation finale exclue
 * (« voir https://x.fr. » : le point n'en fait pas partie, parenthèse fermante si non ouverte).
 */
export function linkAt(s: string, i: number): { text: string; href: string } | null {
  if (i > 0 && /[\w@/.]/u.test(s[i - 1] ?? '')) return null;
  const rest = s.slice(i);
  const url = URL_START.exec(rest)?.[0];
  if (url !== undefined) {
    let text = url;
    for (;;) {
      const last = text.at(-1) ?? '';
      const unbalanced = last === ')' && (text.match(/\(/gu)?.length ?? 0) < (text.match(/\)/gu)?.length ?? 0);
      if (!/[.,;:!?'"»*_~]/u.test(last) && !unbalanced) break;
      text = text.slice(0, -1);
    }
    if (/^www\.$/iu.test(text) || text.length < 5) return null;
    return { text, href: /^www\./iu.test(text) ? `https://${text}` : text };
  }
  const mail = EMAIL.exec(rest)?.[0];
  if (mail !== undefined) {
    const text = mail.replace(/[.-]+$/u, '');
    return { text, href: `mailto:${text}` };
  }
  return null;
}

/** Lien Pango (adresse en infobulle). */
const anchor = (l: { text: string; href: string }): string => `<a href="${esc(l.href)}" title="${esc(l.href)}">${esc(l.text)}</a>`;

/** Une ligne : liens, gras, italique, barré (imbricables) et code en ligne (non interprété). */
function inline(s: string): string {
  let out = '';
  let plain = '';
  const flush = (): void => {
    out += esc(plain);
    plain = '';
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i] ?? '';
    // lien : jamais interprété (un « _ » d'adresse n'ouvre pas d'italique)
    const link = linkAt(s, i);
    if (link !== null) {
      flush();
      out += anchor(link);
      i += link.text.length - 1;
      continue;
    }
    const tag = INLINE[c];
    const end = tag !== undefined || c === '`' ? closing(s, i, c) : -1;
    if (end < 0) {
      plain += c;
      continue;
    }
    flush();
    const inner = s.slice(i + 1, end);
    out += tag === undefined ? `${CODE_OPEN}${esc(inner)}</span>` : `${tag[0]}${inline(inner)}${tag[1]}`;
    i = end;
  }
  flush();
  return out;
}

/** Ligne hors bloc de code : citation, puce, puis mise en forme en ligne. */
function line(l: string): string {
  const quote = /^>\s?(.*)$/u.exec(l);
  if (quote !== null) return `${QUOTE_BAR}<span fgalpha="75%">${line(quote[1] ?? '')}</span>`;
  const bullet = /^(\s*)[*-]\s+(.*)$/u.exec(l);
  if (bullet !== null) return `${esc(bullet[1] ?? '')}•  ${inline(bullet[2] ?? '')}`;
  return inline(l);
}

/** Longueur au-delà de laquelle un message n'est affiché qu'en partie (« Lire la suite »). */
export const READ_MORE = 1000;

/**
 * Début d'un très long message (coupé à un espace, « … » ajouté), comme WhatsApp ; null s'il
 * est assez court pour être affiché en entier.
 */
export function readMoreCut(text: string, limit = READ_MORE): string | null {
  // un peu de marge : pas de « Lire la suite » pour quelques mots de plus
  if (text.length <= limit * 1.2) return null;
  const space = text.lastIndexOf(' ', limit);
  const end = space > limit * 0.8 ? space : limit;
  // pas au milieu d'une paire de substitution (émoji)
  // caractère hors du plan de base (émoji) commençant juste avant la coupure : laissé entier hors du début
  const safe = (text.codePointAt(end - 1) ?? 0) > 0xff_ff ? end - 1 : end;
  return `${text.slice(0, safe).trimEnd()}…`;
}

/**
 * Texte d'un message → balisage Pango, avec la mise en forme de WhatsApp : `*gras*`, `_italique_`,
 * `~barré~`, `` `code` ``, bloc ```` ```code``` ````, `> citation`, listes `* ` / `- ` (puces) et
 * `1. ` (laissées telles quelles).
 */
export function waMarkup(text: string): string {
  return text
    .split('```')
    .map((part, k, parts) =>
      // morceaux impairs : dans un bloc de code (s'il est fermé)
      k % 2 === 1 && k < parts.length - 1 ? `${CODE_OPEN}${esc(part.replace(/^\n/u, '').replace(/\n$/u, ''))}</span>` : (k % 2 === 1 ? '```' : '') + part.split('\n').map((l) => line(l)).join('\n'),
    )
    .join('');
}

/** Extrait d'un résultat de recherche → balisage Pango, mots trouvés en gras (une seule ligne). */
export function snippetMarkup(snippet: string): string {
  return snippet
    .replaceAll('\n', ' ')
    .split(HIT_START)
    .map((part, i) => {
      if (i === 0) return esc(part);
      const [hit = '', rest = ''] = part.split(HIT_END);
      return `<b>${esc(hit)}</b>${esc(rest)}`;
    })
    .join('');
}

/** Émoji (pictogramme, avec variantes, couleurs de peau, séquences et drapeaux). */
// premier élément affiché en émoji : présentation émoji par défaut, ou forcée par U+FE0F
// (« © », « ™ », « ↔ » seuls restent du texte)
const EMOJI = /^(?:\p{Regional_Indicator}{2}|[#*0-9]\uFE0F?\u20E3|(?:\p{Emoji_Presentation}|\p{Extended_Pictographic}\uFE0F)\p{Emoji_Modifier}?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?)*)/u;

/** Nombre d'émojis si le texte n'est fait que d'émojis (espaces permis), 0 sinon. */
export function emojiOnly(text: string): number {
  let rest = text.replaceAll(/\s/gu, '');
  let n = 0;
  while (rest !== '') {
    const m = EMOJI.exec(rest);
    if (m === null) return 0;
    rest = rest.slice(m[0].length);
    n += 1;
  }
  return n;
}

/** Mise en ligne Markdown : `code`, **gras**, *italique* / _italique_, ~~barré~~, [lien](url). */
function mdInline(src: string): string {
  return src
    .split('`')
    .map((part, i) => {
      if (i % 2 === 1) return `<tt>${esc(part)}</tt>`;
      return esc(part)
        .replaceAll(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/gu, '<a href="$2">$1</a>')
        .replaceAll(/\*\*(?=\S)(.+?)(?<=\S)\*\*/gu, '<b>$1</b>')
        .replaceAll(/__(?=\S)(.+?)(?<=\S)__/gu, '<b>$1</b>')
        .replaceAll(/(?<![\w*])\*(?=\S)(.+?)(?<=\S)\*(?![\w*])/gu, '<i>$1</i>')
        .replaceAll(/(?<!\w)_(?=\S)(.+?)(?<=\S)_(?!\w)/gu, '<i>$1</i>')
        .replaceAll(/~~(?=\S)(.+?)(?<=\S)~~/gu, '<s>$1</s>');
    })
    .join('');
}

/**
 * Markdown (réponse d'une IA) → balisage Pango : titres, listes à puces et numérotées, citations,
 * blocs de code, séparateurs, mise en ligne. Texte échappé : aucun balisage ne vient du contenu.
 */
export function markdownMarkup(text: string): string {
  const out: string[] = [];
  let code: string[] | null = null;
  for (const raw of text.replaceAll('\r', '').split('\n')) {
    if (raw.trimStart().startsWith('```')) {
      if (code === null) code = [];
      else {
        out.push(`<tt>${esc(code.join('\n'))}</tt>`);
        code = null;
      }
      continue;
    }
    if (code !== null) {
      code.push(raw);
      continue;
    }
    const row = raw.trimEnd();
    const heading = /^(#{1,6})\s+(.*)$/u.exec(row);
    const bullet = /^(\s*)[-*+]\s+(.*)$/u.exec(row);
    const numbered = /^(\s*)(\d+)[.)]\s+(.*)$/u.exec(row);
    const quote = /^(\s*)>\s?(.*)$/u.exec(row);
    if (heading !== null && heading[2] !== undefined) out.push(`<span weight="bold"${(heading[1]?.length ?? 1) <= 2 ? ' size="large"' : ''}>${mdInline(heading[2])}</span>`);
    else if (/^\s*([-*_])(\s*\1){2,}\s*$/u.test(row)) out.push('<span alpha="40%">──────────</span>');
    else if (bullet !== null) out.push(`${'    '.repeat(Math.floor((bullet[1]?.length ?? 0) / 2))}•  ${mdInline(bullet[2] ?? '')}`);
    else if (numbered !== null) out.push(`${'    '.repeat(Math.floor((numbered[1]?.length ?? 0) / 2))}${numbered[2] ?? ''}.  ${mdInline(numbered[3] ?? '')}`);
    else if (quote === null) out.push(mdInline(row));
    else out.push(`${'    '.repeat(Math.floor((quote[1]?.length ?? 0) / 2))}<span alpha="70%">▎ <i>${mdInline(quote[2] ?? '')}</i></span>`);
  }
  if (code !== null) out.push(`<tt>${esc(code.join('\n'))}</tt>`);
  return out.join('\n');
}

/** Mentions dans un texte déjà balisé (`@33612…` → `@Alice` en évidence ; moi : accentué). */
export function mentionMarkup(markup: string, mentions: readonly { token: string; name: string; me: boolean }[]): string {
  let out = markup;
  for (const m of mentions) {
    const name = esc(m.name.replace(/^~\s*/u, ''));
    const token = esc(m.token).replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
    // après un espace ou une balise seulement (jamais dans un lien ni un attribut), nombre entier
    out = out.replaceAll(new RegExp(`(^|[\\s>])@${token}(?![\\p{L}\\p{N}])`, 'gu'), (_all, before: string) => `${before}<span weight="bold" foreground="${m.me ? '#e66100' : '#1c71d8'}">@${name}</span>`);
  }
  return out;
}

/** Mention en cours de saisie juste avant le curseur (`… @al`) : texte cherché et position du `@`. */
export function mentionQuery(before: string): { query: string; at: number } | null {
  const m = /(?:^|\s)@([\p{L}\p{N}._-]{0,30})$/u.exec(before);
  if (m === null) return null;
  const query = m[1] ?? '';
  return { query, at: before.length - query.length - 1 };
}
