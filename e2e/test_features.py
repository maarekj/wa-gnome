"""Fonctions : nouvelle discussion, recherche, réponse depuis une notification."""

import json
import re
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


def _recording(app, at_least: int) -> None:
    """Enregistrement en cours depuis au moins `at_least` s : durée « m:ss » affichée (n'importe
    laquelle à partir de là ; une valeur précise ne dure qu'une seconde, un parcours de l'arbre
    d'accessibilité peut durer plus sous charge). Les durées des vocaux déjà affichés sont ignorées."""
    before = set(app.labels())

    def elapsed() -> bool:
        for t in app.labels():
            m = re.fullmatch(r'(\d+):(\d\d)', t)
            if m and t not in before and int(m[1]) * 60 + int(m[2]) >= at_least:
                return True
        return False

    wait_until(elapsed, 15, f'enregistrement depuis {at_least} s')


def test_message_vocal(run_app):
    fake, app = run_app()
    app.open_chat('Alice Martin')
    # zone de saisie vide : micro ; enregistrement (son de test, pas de micro réel)
    app.click('button', 'Enregistrer un message vocal')
    _recording(app, 2)
    app.click('button', 'Envoyer le vocal')
    call = fake.wait_call('sendMedia')
    upload = call['args'][1]
    assert upload['mimetype'].startswith('audio/ogg')
    assert upload['voice']['seconds'] >= 2


def test_message_vocal_annule(run_app):
    fake, app = run_app()
    app.open_chat('Alice Martin')
    app.click('button', 'Enregistrer un message vocal')
    _recording(app, 1)
    app.click('button', 'Annuler le vocal')
    app.find('button', 'Enregistrer un message vocal')
    assert fake.calls('sendMedia') == []


def test_brouillon_garde_par_discussion(run_app):
    fake, app = run_app()
    app.open_chat('Alice Martin')
    composer = app.composer()
    composer.text = 'Message pas encore envoyé'
    print('COMPOSER', repr(app.composer().text))
    app.open_chat('Famille')
    # brouillon dans la liste, zone vide dans l'autre discussion
    try:
        app.text_visible('Brouillon :')
    except AssertionError:
        app.screenshot('/tmp/opencode/br.png')
        print('LABELS', [t for t in app.labels() if 'rouillon' in t or 'Alice' in t or 'chalet' in t])
        raise
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


def test_diagnostic(run_app):
    _, app = run_app()
    # menu principal › Diagnostic (Préférences, Raccourcis, Déconnecter, Diagnostic)
    app.point(app.find(None, 'Menu principal'))
    for _ in range(3):
        app.key('Down')
    app.key('Return')
    assert app.text_visible('Version web annoncée')
    assert app.text_visible('faux démon')
    app.click('button', 'Copier le diagnostic')
    assert app.text_visible('Diagnostic copié')


def test_lire_la_suite(run_app):
    fake, app = run_app()
    # très long message : début seulement, puis en entier sur « Lire la suite » (comme WhatsApp)
    fake.incoming('33600000005@s.whatsapp.net', 'Début du long message. ' + 'Suite du texte. ' * 120 + 'Fin cachée du message.')
    app.open_chat('Claire (longue discussion)')
    assert app.text_visible('Lire la suite')
    # (l'aperçu de la liste contient aussi le texte entier : on compte les libellés)
    before = len(app.all('label', None, contains='Fin cachée du message.'))
    app.click('button', 'Lire la suite')
    wait_until(lambda: len(app.all('label', None, contains='Fin cachée du message.')) > before, 5, 'message entier')
    app.text_gone('Lire la suite', 5)


def _bubble_menu(app, text: str) -> None:
    """Menu d'une bulle (clic droit sur son texte, dans la conversation : libellé le plus à droite)."""
    label = max(app.all('label', text), key=lambda n: n.get_extents(Atspi.CoordType.WINDOW).x)
    app.point(label, '3')


# menu d'un message reçu (texte) : entrées d'un menu surgissant absentes de l'arbre
# d'accessibilité, choisies au clavier : 0 Répondre, 1 Transférer, 2 Réagir, 3 Copier le texte,
# 4 Traduire, 5 Épingler, 6 Sélectionner, 7 Supprimer pour moi
def _choose(app, index: int, sub: int | None = None) -> None:
    for _ in range(index):
        app.key('Down')
    if sub is not None:
        app.key('Right')
        for _ in range(sub):
            app.key('Down')
    app.key('Return')


def test_repondre_a_un_message(run_app):
    fake, app = run_app()
    app.open_chat('Claire (longue discussion)')
    _bubble_menu(app, 'Message n° 150')
    _choose(app, 0)
    # bandeau de réponse, puis envoi avec la citation
    assert app.text_visible('Message n° 150')
    app.send('Réponse citée')
    call = fake.wait_call('send')
    assert call['args'][1] == 'Réponse citée'
    assert call['args'][2] is not None


def test_reagir_a_un_message(run_app):
    fake, app = run_app()
    app.open_chat('Claire (longue discussion)')
    _bubble_menu(app, 'Message n° 150')
    _choose(app, 2, 0)
    call = fake.wait_call('react')
    assert call['args'][2] == '👍'


def test_transferer_un_message(run_app):
    fake, app = run_app()
    app.open_chat('Claire (longue discussion)')
    _bubble_menu(app, 'Message n° 150')
    _choose(app, 1)
    app.text_visible('Choisissez une ou plusieurs discussions')
    app.type('voisins')
    app.click('check box')
    app.click('button', 'Transférer')
    call = fake.wait_call('messageAction')
    assert call['args'][2]['action'] == 'forward'


def test_supprimer_un_message_pour_moi(run_app):
    fake, app = run_app()
    app.open_chat('Claire (longue discussion)')
    _bubble_menu(app, 'Message n° 150')
    _choose(app, 7)
    app.text_visible('Supprimer pour moi ?')
    app.click(None, 'Supprimer')
    call = fake.wait_call('messageAction')
    assert call['args'][2] == {'action': 'delete-for-me'}


def test_modifier_un_message_envoye(run_app):
    fake, app = run_app()
    app.open_chat('Claire (longue discussion)')
    app.send('Texte avec une fote')
    fake.wait_call('send')
    app.text_visible('Texte avec une fote')
    # mon message récent : 0 Répondre, 1 Transférer, 2 Infos du message, 3 Modifier
    _bubble_menu(app, 'Texte avec une fote')
    _choose(app, 3)
    assert app.text_visible('Modification du message')
    app.send('Texte avec une faute')
    call = fake.wait_call('messageAction')
    assert call['args'][2] == {'action': 'edit', 'text': 'Texte avec une faute'}


def test_archiver_depuis_la_liste(run_app):
    fake, app = run_app()
    # menu de la discussion (clic droit) : première entrée « Archiver la discussion »
    app.point(app.find('label', 'Voisins'), '3')
    app.key('Return')
    call = fake.wait_call('chatAction')
    assert call['args'][1] == {'action': 'archive', 'value': True}
    app.text_visible('2')
    app.click('button', None, contains='Archivées')
    assert app.text_visible('Voisins')


def test_filtre_par_liste(run_app):
    _, app = run_app()
    # « Groupes » : seuls les groupes restent (Famille), Alice disparaît
    app.click('toggle button', 'Groupes')
    app.text_gone('Alice Martin', 5)
    assert app.has('label', 'Famille')
    app.click('toggle button', 'Toutes')
    assert app.text_visible('Alice Martin')


def test_visionneuse_des_photos(run_app):
    _, app = run_app()
    app.open_chat('Alice Martin')
    # dernière photo de la discussion (la plus basse), puis précédente et fermeture
    frame = max(app.all('image', 'Ouvrir l’image'), key=lambda n: n.get_extents(Atspi.CoordType.WINDOW).y)
    app.point(frame)
    app.find('button', 'Enregistrer sous…')
    app.click('button', 'Photo précédente')
    app.key('Escape')
    wait_until(lambda: not app.has('button', 'Enregistrer sous…'), 5, 'visionneuse fermée')


# menu d'une discussion (clic droit, entrées au clavier, la première déjà choisie) :
# 0 Archiver, 1 Mode silencieux ›, 2 Épingler la discussion, 3 Marquer comme non lue…
def test_mode_silencieux_d_une_discussion(run_app):
    fake, app = run_app()
    app.point(app.find('label', 'Claire (longue discussion)'), '3')
    _choose(app, 1, 0)
    call = fake.wait_call('chatAction')
    assert call['args'][1]['action'] == 'mute'
    assert call['args'][1]['until'] > 0
    # icône du mode silencieux sur la ligne (Voisins l'avait déjà)
    wait_until(lambda: len(app.all('image', 'Mode silencieux')) >= 2, 5, 'icône du mode silencieux')


def test_epingler_une_discussion(run_app):
    fake, app = run_app()
    app.point(app.find('label', 'Claire (longue discussion)'), '3')
    _choose(app, 2)
    call = fake.wait_call('chatAction')
    assert call['args'][1] == {'action': 'pin', 'value': True}
    # deuxième discussion épinglée (Alice l'était déjà) : icône sur sa ligne
    wait_until(lambda: len(app.all('image', 'Épinglée')) >= 2, 5, 'icône épinglée')


def test_palette_de_commandes(run_app):
    fake, app = run_app()
    app.key('ctrl+p')
    # sans saisie : discussions récentes, puis toutes les actions
    assert app.text_visible('Discussions récentes')
    assert app.text_visible('Raccourcis clavier')
    # discussion trouvée, ouverte par Entrée
    app.type('clai')
    app.text_visible('Discussions')
    app.key('Return')
    wait_until(lambda: len(app.all('label', 'Claire (longue discussion)')) >= 2, 10, 'discussion ouverte')
    # action de la discussion ouverte : épingler
    app.key('ctrl+p')
    app.type('epingler')
    assert app.text_visible('Épingler la discussion')
    app.key('Return')
    call = fake.wait_call('chatAction')
    assert call['args'][1] == {'action': 'pin', 'value': True}
    # action de l'application (mot-clé) : préférences
    app.key('ctrl+p')
    app.type('reglages')
    app.text_visible('Préférences')
    app.key('Return')
    assert app.text_visible('Outil de traduction')


def test_palette_sur_les_messages_selectionnes(run_app):
    _, app = run_app()
    app.open_chat('Claire (longue discussion)')
    end = lambda: max(app.all('label', 'Message n° 150'), key=lambda n: n.get_extents(Atspi.CoordType.WINDOW).x)  # noqa: E731
    # résumé de la sélection depuis la palette (outil simulé)
    app.drag(app.find('label', 'Message n° 148'), end())
    assert app.text_visible('3 messages sélectionnés')
    app.key('ctrl+p')
    app.type('resum')
    assert app.text_visible('Résumer les 3 messages sélectionnés (IA)')
    app.key('Return')
    assert app.text_visible('Résumé de test (3 messages')
    # traduction d'une nouvelle sélection depuis la palette
    app.drag(app.find('label', 'Message n° 148'), end())
    assert app.text_visible('3 messages sélectionnés')
    app.key('ctrl+p')
    app.type('tradu')
    assert app.text_visible('Traduire les 3 messages sélectionnés')
    app.key('Return')
    assert app.text_visible('[français] Message n° 150')


def test_auteur_d_un_message_de_groupe(run_app):
    _, app = run_app()

    def lowest(description, role):
        """Nœud le plus bas de la conversation (le plus récent, à l'écran ; les plus anciens sont aussi « showing »)."""
        nodes = [n for n in app.root.findChildren(lambda n: n.showing and n.roleName == role and n.description == description)]
        return max(nodes, key=lambda n: n.get_extents(Atspi.CoordType.WINDOW).y) if nodes else None

    contact_info = lambda: app.root.findChild(lambda n: n.showing and n.description == 'Infos du contact', retry=False, requireResult=False)  # noqa: E731
    app.open_chat('Famille')
    # clic sur le nom de l'auteur : sa discussion
    app.point(wait_until(lambda: lowest('Écrire à ~ Bob', 'button'), 5, 'nom de l’auteur'))
    wait_until(contact_info, 5, 'discussion avec ~ Bob')
    assert app.text_visible('Photo à vue unique')
    # retour au groupe ; clic sur la photo de l'auteur
    app.open_chat('Famille')
    app.point(wait_until(lambda: lowest('Écrire à ~ Bob', 'image'), 5, 'photo de l’auteur'))
    wait_until(contact_info, 5, 'discussion avec ~ Bob')


def test_mention_cliquable(run_app):
    _, app = run_app()
    app.open_chat('Famille')
    label = app.find('label', '@Vous tu prends le pain ? Et @Bob les boissons')
    # clic au milieu de « @Bob » (position estimée d'après la longueur du texte, une seule ligne)
    content = label.name or ''
    middle = (content.index('@Bob') + 2) / len(content)
    e = label.get_extents(Atspi.CoordType.WINDOW)
    dx, dy = conftest._OFFSET or (0, 0)
    subprocess.run(['xdotool', 'mousemove', str(int(e.x + e.width * middle) + dx), str(e.y + e.height // 2 + dy), 'click', '1'], check=True, timeout=5)
    wait_until(lambda: app.root.findChild(lambda n: n.showing and n.description == 'Infos du contact', retry=False, requireResult=False), 5, 'discussion avec ~ Bob')
    assert app.text_visible('Photo à vue unique')


def test_onglets_des_discussions(run_app):
    fake, app = run_app()
    described = lambda d: app.root.findChild(lambda n: n.showing and n.description == d, retry=False, requireResult=False)  # noqa: E731
    tabs = lambda: sorted(n.name for n in app.root.findChildren(lambda n: n.showing and n.roleName == 'page tab'))  # noqa: E731
    # clic dans la liste : onglet temporaire, remplacé par le suivant
    app.open_chat('Famille')
    app.open_chat('Alice Martin')
    wait_until(lambda: tabs() == ['Alice Martin'], 5, 'onglet temporaire remplacé')
    # second clic : onglet gardé, le suivant s'ajoute
    app.point(app.find('label', 'Alice Martin'))
    app.open_chat('Famille')
    wait_until(lambda: tabs() == ['Alice Martin', 'Famille'], 5, 'deux onglets')
    # envoi : onglet gardé aussi
    app.point(app.composer())
    app.type('Bonjour')
    app.key('Return')
    fake.wait_call('send')
    app.open_chat('Voisins')
    wait_until(lambda: tabs() == ['Alice Martin', 'Famille', 'Voisins'], 5, 'trois onglets')
    app.open_chat('Famille')
    # Ctrl+Tab : onglet suivant
    app.key('ctrl+Tab')
    wait_until(lambda: app.opened_chat() == 'Voisins', 5, 'Voisins active')
    # clic sur un onglet
    app.point(app.find('page tab', 'Alice Martin'))
    wait_until(lambda: described('Infos du contact'), 5, 'Alice active')
    # Ctrl+W : onglet actif fermé, le voisin devient actif
    app.key('ctrl+w')
    wait_until(lambda: tabs() == ['Famille', 'Voisins'], 5, 'onglet fermé')
    wait_until(lambda: app.opened_chat() == 'Famille', 5, 'Famille active')
    # Voisins est resté temporaire : remplacé
    app.open_chat('~ Bob')
    wait_until(lambda: tabs() == ['Famille', '~ Bob'], 5, 'temporaire remplacé')
    # relance : onglets, onglet actif et onglet temporaire restaurés
    app.stop()
    app2 = conftest.App(fake, 'Alice Martin')
    try:
        tabs2 = lambda: sorted(n.name for n in app2.root.findChildren(lambda n: n.showing and n.roleName == 'page tab'))  # noqa: E731
        wait_until(lambda: tabs2() == ['Famille', '~ Bob'], 10, 'onglets restaurés')
        wait_until(lambda: app2.opened_chat() == '~ Bob', 10, '~ Bob active')
        app2.open_chat('Claire (longue discussion)')
        wait_until(lambda: tabs2() == ['Claire (longue discussion)', 'Famille'], 5, 'temporaire restauré puis remplacé')
    finally:
        app2.stop()


def test_groupe_reserve_aux_administrateurs(run_app):
    fake, app = run_app()
    app.open_chat('Voisins')
    assert app.text_visible('Seuls les administrateurs peuvent envoyer des messages')
    assert not app.root.findChild(lambda n: n.showing and n.roleName == 'button' and n.name == 'Enregistrer un message vocal', retry=False, requireResult=False)
    # autre groupe : zone de saisie
    app.open_chat('Famille')
    app.composer()
    assert app.text_gone('Seuls les administrateurs peuvent envoyer des messages')
    # groupe quitté (dans les archivées)
    app.click('button', None, contains='Archivées')
    app.open_chat('Ancien club de foot')
    assert app.text_visible('Vous ne faites plus partie de ce groupe')
