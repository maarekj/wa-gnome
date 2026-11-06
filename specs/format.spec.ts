// Mise en forme WhatsApp → balisage Pango.
import { waMarkup } from '../src/shared/format.ts';

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
