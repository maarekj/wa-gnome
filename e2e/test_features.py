"""Fonctions : nouvelle discussion, recherche, réponse depuis une notification."""

from conftest import GROUP, Atspi, wait_until


def test_nouvelle_discussion_avec_un_contact(run_app):
    fake, app = run_app()
    app.key('ctrl+n')
    app.text_visible('Marc Dubois')
    app.type('elo')
    app.text_gone('Marc Dubois', 5)
    app.key('Return')
    # discussion vide ouverte au nom du contact ; premier message envoyé
    wait_until(lambda: app.has('label', 'Élodie Bernard'), 5, 'discussion ouverte')
    app.send('Bonjour Élodie')
    call = fake.wait_call('send')
    assert call['args'][:2] == ['33600000020@s.whatsapp.net', 'Bonjour Élodie']
    # elle apparaît dans la liste au premier message
    wait_until(lambda: len(app.all('label', 'Élodie Bernard')) >= 2, 10, 'discussion dans la liste')


def test_recherche_globale_puis_ouverture_sur_le_message(run_app):
    _, app = run_app()
    # recherche de la barre latérale : seul champ éditable affiché sans discussion ouverte
    search = wait_until(lambda: app.root.findChild(lambda n: n.showing and n.getState().contains(Atspi.StateType.EDITABLE), retry=False, requireResult=False), 5, 'champ de recherche')
    app.point(search)
    app.type('cafe')
    app.text_visible('Messages')
    app.point(app.find('label', None, contains='Café'))
    # discussion ouverte au milieu, sur le message trouvé
    assert app.text_visible('On se retrouve au Café de la Gare')
    wait_until(lambda: app.has('label', 'Claire (longue discussion)'), 5, 'discussion de Claire')


def test_recherche_dans_la_discussion(run_app):
    _, app = run_app()
    app.open_chat('Claire (longue discussion)')
    app.key('ctrl+f')
    app.type('gare')
    assert app.text_visible('1 message')
    app.key('Return')
    assert app.text_visible('On se retrouve au Café de la Gare')


def test_repondre_depuis_une_notification(run_app):
    fake, app = run_app()
    app.open_chat('Alice Martin')
    fake.incoming(GROUP, 'Qui ramène le pain ?')
    # bouton « Répondre » de la notification (action de l'application)
    app.action('reply-chat', f"'{GROUP}'")
    assert app.text_visible('Qui ramène le pain ?')
    # zone de saisie active : la frappe y va directement
    app.type('Moi')
    wait_until(lambda: app.composer().text == 'Moi', 5, 'saisie dans la zone de réponse')
