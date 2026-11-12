"""Fonctions : nouvelle discussion, recherche, réponse depuis une notification."""

import json
import subprocess
import time
import urllib.request

import conftest
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


def test_fond_couleur_unie_enregistre(run_app):
    import json

    fake, app = run_app()
    app.key('ctrl+comma')
    app.click('toggle button', 'Menthe')
    path = fake.dir / 'data' / 'settings.json'
    wait_until(lambda: path.exists() and json.loads(path.read_text()).get('wallpaper') == 'color:menthe', 5, 'fond enregistré')


def test_selecteur_emoji(run_app):
    _, app = run_app()
    app.open_chat('Alice Martin')
    composer = app.composer()
    composer.text = 'Salut '
    # curseur en fin de texte
    app.point(composer)
    app.key('ctrl+End')
    app.point(app.find(None, 'Émojis'))
    # premier émoji de la grille au clavier (la fenêtre surgissante a ses propres coordonnées)
    app.text_visible('Émoticônes et personnes')
    app.key('Down')
    app.key('Return')
    wait_until(lambda: composer.text.startswith('Salut ') and len(composer.text) > len('Salut '), 5, 'émoji inséré')


def test_infos_du_groupe_et_du_contact(run_app):
    _, app = run_app()
    app.open_chat('Famille')
    app.point(wait_until(lambda: app.root.findChild(lambda n: n.showing and n.description == 'Infos du groupe', retry=False, requireResult=False), 5, 'bouton du titre'))
    assert app.text_visible('Groupe · 3 participants')
    assert app.text_visible('Organisation des repas du dimanche')
    assert app.text_visible('Créateur du groupe')
    app.key('Escape')
    app.open_chat('Alice Martin')
    app.point(wait_until(lambda: app.root.findChild(lambda n: n.showing and n.description == 'Infos du contact', retry=False, requireResult=False), 5, 'bouton du titre'))
    assert app.text_visible('En vacances jusqu’à lundi')
    assert app.text_visible('+33 6 00 00 00 01')
    assert app.text_visible('2 groupes en commun')


def test_lien_cliquable(run_app):
    _, app = run_app()
    app.open_chat('~ Bob')
    label = app.find('label', None, contains='https://exemple.fr/match_du_samedi')
    # clic sur l'adresse : sélection au clavier impossible ; on vise le milieu de l'adresse en
    # estimant la position d'après la longueur du texte (une seule ligne, chasse moyenne)
    content = label.name or ''
    start = content.index('https://')
    middle = (start + len('https://exemple.fr/match_du_samedi') // 2) / len(content)
    e = label.get_extents(Atspi.CoordType.WINDOW)
    dx, dy = conftest._OFFSET or (0, 0)
    subprocess.run(['xdotool', 'mousemove', str(int(e.x + e.width * middle) + dx), str(e.y + 10 + dy), 'click', '1'], check=True, timeout=5)
    assert app.logged('LIEN https://exemple.fr/match_du_samedi').endswith('match_du_samedi')


def test_message_vocal(run_app):
    fake, app = run_app()
    app.open_chat('Alice Martin')
    # zone de saisie vide : micro ; enregistrement (son de test, pas de micro réel)
    app.click('button', 'Enregistrer un message vocal')
    assert app.text_visible('0:02', 10)
    app.click('button', 'Envoyer le vocal')
    call = fake.wait_call('sendMedia')
    upload = call['args'][1]
    assert upload['mimetype'].startswith('audio/ogg')
    assert upload['voice']['seconds'] >= 2


def test_message_vocal_annule(run_app):
    fake, app = run_app()
    app.open_chat('Alice Martin')
    app.click('button', 'Enregistrer un message vocal')
    app.text_visible('0:01', 10)
    app.click('button', 'Annuler le vocal')
    app.find('button', 'Enregistrer un message vocal')
    assert fake.calls('sendMedia') == []


def test_brouillon_garde_par_discussion(run_app):
    fake, app = run_app()
    app.open_chat('Alice Martin')
    composer = app.composer()
    composer.text = 'Message pas encore envoyé'
    app.open_chat('Famille')
    # brouillon dans la liste, zone vide dans l'autre discussion
    assert app.text_visible('Brouillon :')
    wait_until(lambda: app.composer().text == '', 5, 'zone vide')
    app.open_chat('Alice Martin')
    wait_until(lambda: app.composer().text == 'Message pas encore envoyé', 5, 'brouillon retrouvé')
    assert fake.calls('send') == []
    # rouvrir une discussion avec un brouillon n'annonce pas « écrit… » au contact
    before = len([c for c in fake.calls('typing') if c['args'][1] == 'composing'])
    app.open_chat('Famille')
    app.open_chat('Alice Martin')
    wait_until(lambda: app.composer().text == 'Message pas encore envoyé', 5, 'brouillon retrouvé')
    assert len([c for c in fake.calls('typing') if c['args'][1] == 'composing']) == before


def test_emojis_seuls_en_grand(run_app):
    _, app = run_app()
    app.open_chat('Alice Martin')
    # 👍 seul : texte agrandi (hauteur du libellé bien plus grande qu'une ligne normale)
    big = app.find('label', '👍')
    normal = app.find('label', 'Parfait, à tout à l’heure')
    assert big.get_extents(Atspi.CoordType.WINDOW).height > 2 * normal.get_extents(Atspi.CoordType.WINDOW).height


def test_forme_onde_du_vocal(run_app):
    _, app = run_app()
    app.open_chat('Famille')
    # vocal de Bob : forme d'onde (curseur accessible), active une fois la lecture lancée
    wave = wait_until(lambda: [n for n in app.all('slider') if n.description == 'Position dans le vocal' or n.name == 'Position dans le vocal'][:1], 10, 'forme d’onde')[0]
    assert not wave.sensitive
    app.click('button', 'Lire')
    wait_until(lambda: wave.sensitive, 10, 'forme d’onde active')


def test_traduire_des_messages(run_app):
    _, app = run_app()
    app.open_chat('Claire (longue discussion)')
    app.drag(app.find('label', 'Message n° 148'), max(app.all('label', 'Message n° 150'), key=lambda n: n.get_extents(Atspi.CoordType.WINDOW).x))
    app.click('button', 'Traduire')
    assert app.text_visible('[français] Message n° 148')
    assert app.text_visible('[français] Message n° 150')
    assert app.text_visible('Traduit de l’anglais')


def test_transcrire_et_traduire_un_vocal(run_app):
    _, app = run_app()
    app.open_chat('Famille')
    app.drag(app.find('label', 'Menu du dimanche.pdf'), app.find('label', 'Le chat du voisin'))
    app.click('button', 'Traduire')
    assert app.text_visible('Bonjour, ceci est un vocal de test.')
    assert app.text_visible('[français] Le chat du voisin')


COLLEAGUE = '33600000101@s.whatsapp.net'


def test_plusieurs_comptes(run_app):
    fake, app = run_app()
    # ajout d'un compte : appairage par QR code
    app.point(app.find(None, 'Comptes'))
    app.click('button', 'Ajouter un compte')
    fake.wait_call('addAccount')
    assert app.text_visible('Connecter WhatsApp')
    app.find('button', 'Annuler l’ajout de ce compte')
    fake.pair()
    assert app.text_visible('Collègue de bureau', 15)
    # retour au premier compte par le sélecteur
    app.point(app.find(None, 'Comptes'))
    app.point(app.find(None, 'Moi'))
    assert app.text_visible('Alice Martin')
    app.text_gone('Collègue de bureau')
    # message reçu sur l'autre compte : « Répondre » de sa notification ouvre ce compte
    fake.incoming(COLLEAGUE, 'Tu as le dossier ?', 'compte1')
    app.action('reply-chat', f"'compte1/{COLLEAGUE}'")
    assert app.text_visible('Tu as le dossier ?')
    app.text_gone('Alice Martin')
    app.type('Oui')
    wait_until(lambda: app.composer().text == 'Oui', 5, 'saisie dans le compte ajouté')
    # retrait du compte (menu principal, 4e entrée) : retour au premier
    app.key('Escape')
    app.point(app.find(None, 'Menu principal'))
    for _ in range(3):
        app.key('Down')
    app.key('Return')
    app.click('button', 'Retirer')
    assert fake.wait_call('removeAccount')['args'] == ['compte1']
    assert app.text_visible('Alice Martin')


def test_appels_refus_avec_message_et_appel_manque(run_app):
    fake, app = run_app()
    app.open_chat('Alice Martin')
    # appel vocal : « Refuser avec un message » de la notification
    call = fake.call(conftest.ALICE)
    app.action('reject-call-message', f"'{call}'")
    assert fake.wait_call('rejectCall')['args'] == [call, 'Je ne peux pas répondre, je te rappelle']
    assert app.text_visible('Appel vocal refusé')
    assert app.text_visible('Je ne peux pas répondre, je te rappelle')
    # appel vidéo : surimpression dans la fenêtre, retirée quand l'appelant raccroche (manqué)
    video = fake.call(conftest.ALICE, video=True)
    assert app.text_visible('Alice Martin vous appelle')
    fake.end_call(video)
    assert app.text_visible('Appel vidéo manqué')
    app.text_gone('Alice Martin vous appelle')
    # « Refuser » de la surimpression
    call = fake.call(conftest.ALICE)
    app.click('button', 'Refuser')
    wait_until(lambda: len(fake.calls('rejectCall')) == 2, 5, 'second refus')
    assert fake.calls('rejectCall')[-1]['args'][0] == call
    app.text_gone('Alice Martin vous appelle')


def test_compteur_de_non_lus_barre_du_haut(run_app):
    fake, app = run_app()

    def label() -> int:
        out = subprocess.run(['gdbus', 'call', '--session', '--dest', app.app_id, '--object-path', '/StatusNotifierItem', '--method', 'org.freedesktop.DBus.Properties.Get', 'org.kde.StatusNotifierItem', 'XAyatanaLabel'], check=True, capture_output=True, text=True, timeout=5).stdout
        digits = ''.join(c for c in out if c.isdigit())
        return int(digits or 0)

    before = wait_until(lambda: label() or None, 10, 'compteur initial')
    # message reçu dans une discussion lue : une discussion non lue de plus
    fake.incoming(conftest.ALICE, 'Tu es là ?')
    wait_until(lambda: label() == before + 1, 10, 'compteur augmenté')


def test_vue_unique_et_messages_ephemeres(run_app):
    _, app = run_app()
    # aperçu de la liste puis bulle : photo à vue unique, à ouvrir sur le téléphone
    assert app.text_visible('Photo à vue unique')
    app.open_chat('~ Bob')
    assert app.text_visible('À ouvrir sur votre téléphone')
    # discussion éphémère : minuterie dans l'en-tête
    app.find(None, 'Messages éphémères : 7 jours')


def test_resume_des_messages_selectionnes(run_app):
    _, app = run_app()
    app.open_chat('Claire (longue discussion)')
    start = app.find('label', 'Message n° 148')
    end = max(app.all('label', 'Message n° 150'), key=lambda n: n.get_extents(Atspi.CoordType.WINDOW).x)
    app.drag(start, end)
    assert app.text_visible('3 messages sélectionnés')
    # « Résumer (IA) » de la barre de sélection : fenêtre du résumé (outil simulé)
    app.click('button', 'Résumer (IA)')
    # panneau à droite : la discussion reste affichée
    assert app.text_visible('Résumé de test (3 messages')
    assert app.text_visible('Message n° 150')
    app.find(None, 'Copier le résumé')
    # fermé puis rouvert par le bouton de l'en-tête : résumé toujours là
    app.click('button', 'Fermer les résumés')
    app.text_gone('Résumé de test', 5)
    app.point(app.find(None, 'Résumés (IA) de la discussion'))
    assert app.text_visible('Résumé de test (3 messages')


def test_messages_epingles(run_app):
    fake, app = run_app()
    app.open_chat('Famille')
    # bandeau du message épinglé (démonstration)
    app.find(None, 'Message épinglé : Qui vient dimanche midi ?')
    # épingler le dernier message (visible) : menu, « Épingler » › 7 jours ; entrées d'un menu
    # surgissant absentes de l'arbre d'accessibilité : au clavier (Répondre, Transférer, Réagir,
    # Copier le texte, Traduire, Épingler › 24 heures, 7 jours)
    label = max(app.all('label', 'Le chat du voisin'), key=lambda n: n.get_extents(Atspi.CoordType.WINDOW).x)
    app.point(label, '3')
    for _ in range(5):
        app.key('Down')
    app.key('Right')
    app.key('Down')
    app.key('Return')
    call = fake.wait_call('messageAction')
    assert call['args'][2] == {'action': 'pin', 'value': True, 'duration': 604800}
    app.find(None, 'Message épinglé : Vidéo · Le chat du voisin')
    assert app.text_visible('Message épinglé 1/2')


def test_mentions_dans_un_groupe(run_app):
    fake, app = run_app()
    app.open_chat('Famille')
    # mention reçue : par le nom (« @Vous », « @~ Bob » sans le ~)
    assert app.text_visible('@Vous tu prends le pain ? Et @Bob les boissons')
    # « @bo » : liste des membres, Tab insère « @Bob »
    app.point(app.composer())
    app.type('@bo')
    app.find(None, 'Mentionner Bob')
    app.key('Tab')
    wait_until(lambda: app.composer().text == '@Bob ', 5, 'mention insérée')
    app.type('ok')
    app.click('button', 'Envoyer')
    call = fake.wait_call('send')
    assert call['args'][0] == GROUP
    assert call['args'][1] == '@33600000002 ok'
    assert call['args'][3] == ['33600000002@s.whatsapp.net']


def test_statuts(run_app):
    fake, app = run_app()
    # entrée « Statuts » : deux personnes avec du nouveau
    app.click('button', None, contains='Statuts')
    app.point(app.find(None, 'Statuts de ~ Bob'))
    # statut texte de Bob affiché, puis marqué vu (accusé)
    assert app.text_visible('Allez l’équipe ! ⚽')
    seen = fake.wait_call('seeStatus')['args'][0]
    # c'est bien le statut de Bob (texte) qui est marqué vu
    raw = subprocess.run(['curl', '-s', '-H', 'Authorization: Bearer fake-token', f'{fake.url}/statuses'], check=True, capture_output=True, text=True, timeout=5).stdout
    bob = next(g for g in json.loads(raw) if g['name'] == '~ Bob')
    assert seen == bob['items'][0]['message']['id']
    assert bob['items'][0]['seen'] is True
    app.key('Escape')
    app.text_gone('Allez l’équipe', 5)


def test_messages_programmes(run_app):
    fake, app = run_app()
    app.open_chat('Alice Martin')
    composer = app.composer()
    composer.text = 'On se voit demain ?'
    wait_until(lambda: composer.text == 'On se voit demain ?', 5, 'texte saisi')
    # « Programmer l'envoi » › « Dans 1 heure » : bandeau, saisie vidée
    app.point(app.find(None, 'Programmer l’envoi'))
    app.click('button', 'Dans 1 heure')
    call = fake.wait_call('schedule')
    assert call['args'][:2] == [conftest.ALICE, 'On se voit demain ?']
    assert app.text_visible('Programmé ·')
    wait_until(lambda: app.composer().text == '', 5, 'saisie vidée')
    # annulé : bandeau retiré
    app.click('button', 'Annuler le message programmé')
    fake.wait_call('cancelScheduled')
    app.text_gone('Programmé ·', 5)
    # heure atteinte : envoyé par le démon (programmé par l'API, dans 2 s)
    body = json.dumps({'text': 'Rappel automatique', 'at': time.time() + 2}).encode()
    req = urllib.request.Request(f'{fake.url}/chats/{conftest.ALICE}/scheduled', data=body, method='POST', headers={'Authorization': 'Bearer fake-token', 'content-type': 'application/json'})
    urllib.request.urlopen(req, timeout=5).read()
    wait_until(lambda: any(c['args'][1] == 'Rappel automatique' for c in fake.calls('send')), 10, 'envoi à l’heure')
    assert app.text_visible('Rappel automatique')


def test_sondage_voter(run_app):
    fake, app = run_app()
    app.open_chat('Famille')
    assert app.text_visible('Quel jour pour le pique-nique ?')
    assert app.text_visible('1 personne a voté')
    app.click('button', 'Dimanche : 0 vote')
    call = fake.wait_call('messageAction')
    assert call['args'][2] == {'action': 'vote', 'options': ['Dimanche']}
    app.find('button', 'Dimanche : 1 vote (le vôtre)')
    assert app.text_visible('2 personnes ont voté')
    # récapitulatif : votants par option
    app.click('button', 'Voir les votes')
    assert app.text_visible('Votes du sondage')
    assert app.text_visible('Votre vote')
