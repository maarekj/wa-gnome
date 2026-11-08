"""Fonctions : nouvelle discussion, recherche, réponse depuis une notification."""

from conftest import GROUP, Atspi, wait_until


def test_echap_ferme_la_fenetre_nouvelle_discussion(run_app):
    _, app = run_app()
    app.key('ctrl+n')
    app.text_visible('Marc Dubois')
    app.type('ma')
    app.key('Escape')
    app.text_gone('Marc Dubois', 5)


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


def test_raccourcis_discussion_suivante_et_recherche(run_app):
    _, app = run_app()
    app.open_chat('Alice Martin')
    # Alt+Bas : discussion suivante de la liste (Famille), Alt+Haut : retour
    app.key('alt+Down')
    assert app.text_visible('Le chat du voisin')
    wait_until(lambda: len(app.all('label', 'Famille')) >= 2, 5, 'Famille ouverte')
    app.key('alt+Up')
    assert app.text_visible('Parfait, à tout à l’heure')
    # Ctrl+K : recherche de la barre latérale
    app.key('ctrl+k')
    app.type('bob')
    app.text_gone('Famille', 5)
    # Échap : recherche vidée et quittée, liste complète
    app.key('Escape')
    assert app.text_visible('Famille')


def test_fenetre_des_raccourcis(run_app):
    _, app = run_app()
    app.key('ctrl+question')
    assert app.text_visible('Discussion suivante')
    assert app.text_visible('Rechercher dans la discussion')


def test_raccourcis_inactifs_sous_une_fenetre(run_app):
    _, app = run_app()
    app.open_chat('Alice Martin')
    app.key('ctrl+n')
    app.text_visible('Marc Dubois')
    app.key('alt+Down')
    app.key('Escape')
    # toujours sur Alice : Alt+Bas n'a pas changé de discussion derrière la fenêtre
    assert app.text_visible('Parfait, à tout à l’heure')


def test_preferences_de_notification_enregistrees(run_app):
    import json

    fake, app = run_app()
    app.key('ctrl+comma')
    switch = wait_until(lambda: [n for n in app.all('switch', 'Afficher le contenu') + app.all('toggle button', 'Afficher le contenu') if n.actions][:1] or app.root.findChildren(lambda n: n.showing and n.name == 'Afficher le contenu' and 'toggle' in n.actions), 5, 'interrupteur')[0]
    switch.doActionNamed('toggle' if 'toggle' in switch.actions else 'click')
    path = fake.dir / 'data' / 'settings.json'
    wait_until(lambda: path.exists() and json.loads(path.read_text()).get('preview') is False, 5, 'réglage enregistré')


def test_galerie_des_medias(run_app):
    _, app = run_app()
    app.open_chat('Alice Martin')
    app.click('button', 'Médias, documents et audio de la discussion')
    assert app.text_visible('Photos et vidéos')
    # vignettes groupées par mois ; clic : visionneuse parmi les photos de la galerie
    tiles = wait_until(lambda: [n for n in app.root.findChildren(lambda n: n.showing and n.description == 'Ouvrir la photo') or app.all(None, 'Ouvrir la photo')], 10, 'vignettes')
    app.point(tiles[0])
    assert app.text_visible(' / 9')
    app.key('Escape')
    # onglet Documents : aucun dans cette discussion
    app.click(None, 'Documents')
    assert app.text_visible('Aucun document')


def test_selection_en_glissant(run_app):
    _, app = run_app()
    app.open_chat('Claire (longue discussion)')
    start = app.find('label', 'Message n° 148')
    # « Message n° 150 » : aussi l'aperçu dans la liste ; celui de la conversation est le plus à droite
    end = max(app.all('label', 'Message n° 150'), key=lambda n: n.get_extents(Atspi.CoordType.WINDOW).x)
    app.drag(start, end)
    # trois messages sélectionnés, barre de sélection affichée
    assert app.text_visible('3 messages sélectionnés')
    app.key('Escape')
    app.text_gone('messages sélectionnés', 5)
