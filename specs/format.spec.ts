// Mise en forme WhatsApp → balisage Pango.
import { emojiOnly, linkAt, markdownMarkup, mentionMarkup, mentionQuery, readMoreCut, waMarkup } from '../src/shared/format.ts';

describe('« Lire la suite »', () => {
  it('message court : en entier', () => {
    expect(readMoreCut('bonjour', 10)).toBeNull();
    expect(readMoreCut('a'.repeat(12), 10)).toBeNull();
  });
  it('long message : coupé à un espace', () => {
    expect(readMoreCut('mot '.repeat(10), 20)).toBe('mot mot mot mot mot…');
  });
  it('sans espace : à la limite, sans couper un émoji', () => {
    expect(readMoreCut('x'.repeat(9) + '😀'.repeat(5), 10)).toBe(`${'x'.repeat(9)}…`);
  });
});

describe('waMarkup', () => {
  it('gras, italique, barré, code', () => {
    expect(waMarkup('*a* _b_ ~c~ `d`')).toBe('<b>a</b> <i>b</i> <s>c</s> <span font_family="monospace" background="#8080804d">d</span>');
  });
  it('imbrication', () => {
    expect(waMarkup('*gras _et italique_*')).toBe('<b>gras <i>et italique</i></b>');
  });
  it('marqueurs non collés au mot ou au milieu d’un mot : texte brut', () => {
    expect(waMarkup('2 * 3 * 4')).toBe('2 * 3 * 4');
    expect(waMarkup('nom_de_fichier.txt')).toBe('nom_de_fichier.txt');
    expect(waMarkup('**')).toBe('**');
    expect(waMarkup('*a\nb*')).toBe('*a\nb*');
  });
  it('échappe le texte et n’interprète rien dans le code', () => {
    expect(waMarkup('<a> & `*x*`')).toBe('&lt;a&gt; &amp; <span font_family="monospace" background="#8080804d">*x*</span>');
  });
  it('ponctuation autour des marqueurs', () => {
    expect(waMarkup('(*oui*), _non_.')).toBe('(<b>oui</b>), <i>non</i>.');
  });
  it('citation, puces, liste numérotée', () => {
    expect(waMarkup('> cité *fort*')).toBe('<span foreground="#80808099">▍</span> <span fgalpha="75%">cité <b>fort</b></span>');
    expect(waMarkup('* un\n- deux\n1. trois')).toBe('•  un\n•  deux\n1. trois');
  });
  it('bloc de code', () => {
    expect(waMarkup('avant\n```\n*x* <y>\n```\naprès')).toBe('avant\n<span font_family="monospace" background="#8080804d">*x* &lt;y&gt;</span>\naprès');
    expect(waMarkup('```non fermé')).toBe('```non fermé');
  });
});

describe('liens', () => {
  it('adresses web et e-mail, ponctuation finale exclue', () => {
    expect(linkAt('voir https://exemple.fr/a_b?x=1.', 5)).toEqual({ text: 'https://exemple.fr/a_b?x=1', href: 'https://exemple.fr/a_b?x=1' });
    expect(linkAt('(www.exemple.fr)', 1)).toEqual({ text: 'www.exemple.fr', href: 'https://www.exemple.fr' });
    expect(linkAt('https://fr.wikipedia.org/wiki/Paris_(France)', 0)?.text).toBe('https://fr.wikipedia.org/wiki/Paris_(France)');
    expect(linkAt('écris à moi@exemple.fr.', 8)).toEqual({ text: 'moi@exemple.fr', href: 'mailto:moi@exemple.fr' });
    expect(linkAt('xhttps://a.fr', 1)).toBeNull();
  });
  it('dans le balisage : lien Pango, rien d’interprété dedans, pas dans le code', () => {
    expect(waMarkup('*va* sur https://a.fr/x_y_z')).toBe('<b>va</b> sur <a href="https://a.fr/x_y_z" title="https://a.fr/x_y_z">https://a.fr/x_y_z</a>');
    expect(waMarkup('`https://a.fr`')).not.toContain('<a ');
    // marqueur d'adresse suivi de ponctuation : ne ferme pas l'italique qui l'entoure
    expect(waMarkup('_voir https://a.fr/x_/y fin_')).toBe('<i>voir <a href="https://a.fr/x_/y" title="https://a.fr/x_/y">https://a.fr/x_/y</a> fin</i>');
    expect(linkAt('moi@exemple.fr-', 0)?.text).toBe('moi@exemple.fr');
    expect(waMarkup('https://a.fr/?a=1&b=<2>')).toContain('href="https://a.fr/?a=1&amp;b="');
  });
});

describe('émojis seuls', () => {
  it('compte les émojis, 0 dès qu’il y a du texte', () => {
    expect(emojiOnly('😂')).toBe(1);
    expect(emojiOnly('👍🏽 ❤️')).toBe(2);
    expect(emojiOnly('👨‍👩‍👧')).toBe(1);
    expect(emojiOnly('🇫🇷🇮🇱')).toBe(2);
    expect(emojiOnly('ok 👍')).toBe(0);
    expect(emojiOnly('12')).toBe(0);
    expect(emojiOnly('')).toBe(0);
    expect(emojiOnly('©')).toBe(0);
    expect(emojiOnly('™')).toBe(0);
    expect(emojiOnly('❤️')).toBe(1);
  });
});

describe('markdownMarkup', () => {
  it('mise en ligne, listes, citations, titres', () => {
    expect(markdownMarkup('**Décision** : *dimanche* à `12h30`')).toBe('<b>Décision</b> : <i>dimanche</i> à <tt>12h30</tt>');
    expect(markdownMarkup('- un\n  - deux\n1. trois')).toBe('•  un\n    •  deux\n1.  trois');
    expect(markdownMarkup('> On part à 8 h')).toBe('<span alpha="70%">▎ <i>On part à 8 h</i></span>');
    // citation sous une puce (indentée)
    expect(markdownMarkup('  > pain ?')).toBe('    <span alpha="70%">▎ <i>pain ?</i></span>');
    expect(markdownMarkup('## Sujets')).toBe('<span weight="bold" size="large">Sujets</span>');
    expect(markdownMarkup('[site](https://exemple.fr)')).toBe('<a href="https://exemple.fr">site</a>');
  });
  it('contenu échappé, astérisques isolés et identifiants laissés', () => {
    expect(markdownMarkup('a < b & <b>c</b>')).toBe('a &lt; b &amp; &lt;b&gt;c&lt;/b&gt;');
    expect(markdownMarkup('3 * 4 * 5 et nom_de_fichier_test')).toBe('3 * 4 * 5 et nom_de_fichier_test');
    expect(markdownMarkup('```\n<x>\n```')).toBe('<tt>&lt;x&gt;</tt>');
  });
});

describe('mentions', () => {
  it('saisie en cours après @, nom affiché à la place du numéro', () => {
    expect(mentionQuery('salut @al')).toEqual({ query: 'al', at: 6 });
    expect(mentionQuery('@')).toEqual({ query: '', at: 0 });
    expect(mentionQuery('mail@exemple')).toBeNull();
    expect(mentionMarkup('@336 &amp; @99', [{ token: '336', name: '~ Bob <b>', me: false }])).toBe('<span weight="bold" foreground="#1c71d8">@Bob &lt;b&gt;</span> &amp; @99');
    // ni dans un lien, ni un numéro plus long
    const link = waMarkup('https://x.fr/@336 @3361 <b>');
    expect(mentionMarkup(link, [{ token: '336', name: 'Bob', me: false }])).toBe(link);
    expect(mentionMarkup('<b>@336</b>', [{ token: '336', name: 'Bob', me: true }])).toBe('<b><span weight="bold" foreground="#e66100">@Bob</span></b>');
  });
});
