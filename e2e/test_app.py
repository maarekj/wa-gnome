"""Parcours principaux : appairage, discussion, envoi, réception, déconnexion."""

from conftest import ALICE, GROUP, wait_until


def test_appairage_par_qr_code(run_app):
    fake, app = run_app('qr', ready='Connecter WhatsApp')
    assert app.text_visible('Scannez ce code')
    # le téléphone scanne le code : la liste des discussions s'affiche
    fake.pair()
    assert app.text_visible('Alice Martin', 15)
    app.text_gone('Connecter WhatsApp')


def test_ouvrir_une_discussion(run_app):
    fake, app = run_app()
    app.open_chat('Alice Martin')
    assert app.text_visible('Parfait, à tout à l’heure')
    # la discussion est suivie (présence) : « en ligne » dans l'en-tête
    fake.wait_call('subscribe')
    assert app.text_visible('en ligne')


def test_envoyer_un_message(run_app):
    fake, app = run_app()
    app.open_chat('Alice Martin')
    app.send('Bonjour depuis les tests')
    call = fake.wait_call('send')
    assert call['args'][:2] == [ALICE, 'Bonjour depuis les tests']
    assert app.text_visible('Bonjour depuis les tests')
    # zone de saisie vidée après l'envoi
    wait_until(lambda: app.composer().text == '', 5, 'zone de saisie vidée')


def test_recevoir_un_message(run_app):
    fake, app = run_app()
    fake.incoming(GROUP, 'Message reçu pendant le test')
    # aperçu mis à jour dans la liste, pastille de non-lus
    assert app.text_visible('Message reçu pendant le test')
    wait_until(lambda: app.has('label', '2'), 5, 'pastille de non-lus')
    # ouverture : message affiché, discussion marquée lue
    app.open_chat('Famille')
    fake.wait_call('markRead')
    assert any(c['args'] == [GROUP] for c in fake.calls('markRead'))


def test_message_recu_dans_la_discussion_ouverte(run_app):
    fake, app = run_app()
    app.open_chat('Alice Martin')
    fake.incoming(ALICE, 'Tu es là ?')
    assert app.text_visible('Tu es là ?')


def test_deconnexion(run_app):
    fake, app = run_app()
    # menu principal : clic réel sur le bouton, puis 3e entrée au clavier (Préférences, Raccourcis
    # clavier, Déconnecter… ; les entrées d'un menu surgissant ne sont pas dans l'arbre d'accessibilité)
    app.point(app.find(None, 'Menu principal'))
    app.key('Down')
    app.key('Down')
    app.key('Return')
    app.click('button', 'Déconnecter')
    fake.wait_call('logout')
    # retour à l'appairage
    assert app.text_visible('Connecter WhatsApp', 15)
