"""Harnais des tests de bout en bout : un faux démon et l'application par test.

Lancé par `pnpm e2e` (écran virtuel, bus D-Bus et bus d'accessibilité privés : voir
scripts/e2e.ts). L'application est pilotée par l'accessibilité (dogtail) : les widgets sont
trouvés par rôle et nom (texte affiché ou infobulle). Les clics réels (lignes de liste) passent
par XTest (xdotool), avec un décalage fenêtre → écran mesuré une fois.
"""

from __future__ import annotations

import json
import os
import socket
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path

import pytest

# dogtail exige le réglage « accessibilité activée » : posé dans un GSettings en mémoire
# (GSETTINGS_BACKEND=memory, cf. scripts/e2e.ts), jamais dans le dconf de l'utilisateur
assert os.environ.get('GSETTINGS_BACKEND') == 'memory', 'lancer via `pnpm e2e` (GSettings en mémoire)'
import gi  # noqa: E402

gi.require_version('Gio', '2.0')
gi.require_version('Atspi', '2.0')
from gi.repository import Atspi, Gio  # noqa: E402

Gio.Settings.new('org.gnome.desktop.interface').set_boolean('toolkit-accessibility', True)

from dogtail import tree  # noqa: E402
from dogtail.config import config  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
WIDTH, HEIGHT = 1280, 800

config.logDebugToFile = False
config.logDebugToStdOut = False
config.searchCutoffCount = 10
config.searchBackoffDuration = 0.3
config.actionDelay = 0.3
config.defaultDelay = 0.3

# discussions de démonstration du faux démon (scripts/fake-daemon.ts)
ALICE = '33600000001@s.whatsapp.net'
BOB = '33600000002@s.whatsapp.net'
GROUP = '120363000000000001@g.us'


def free_port() -> int:
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def wait_until(check, timeout: float = 10, what: str = 'condition'):
    """Attend que `check()` renvoie une valeur vraie ; échec explicite après `timeout` s."""
    end = time.monotonic() + timeout
    last = None
    while time.monotonic() < end:
        try:
            last = check()
            if last:
                return last
        except Exception as e:  # noqa: BLE001 — nœud pas encore présent
            last = e
        time.sleep(0.2)
    raise AssertionError(f'délai dépassé : {what} (dernier résultat : {last!r})')


def xdotool(*args: str) -> None:
    subprocess.run(['xdotool', *args], check=True, timeout=10)


class Fake:
    """Faux démon (scripts/fake-daemon.ts) avec son port de pilotage."""

    def __init__(self, state: str = 'open') -> None:
        self.port = free_port()
        self.control = free_port()
        self.url = f'http://127.0.0.1:{self.port}'
        self.dir = Path(tempfile.mkdtemp(prefix='wa-e2e-'))
        args = ['node', str(ROOT / 'scripts' / 'fake-daemon.ts'), '--state', state, '--port', str(self.port), '--dir', str(self.dir / 'data'), '--control', str(self.control), '--no-replies']
        self.log_path = self.dir / 'fake.log'
        self._log = self.log_path.open('w')
        self.proc = subprocess.Popen(args, stdout=self._log, stderr=subprocess.STDOUT, text=True)
        try:
            wait_until(lambda: self._request('GET', '/calls') is not None, 15, 'démarrage du faux démon')
        except AssertionError:
            self.proc.kill()
            raise AssertionError(f'faux démon : {self.log_path.read_text()[-2000:]}') from None

    def _request(self, method: str, path: str, body: object | None = None):
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(f'http://127.0.0.1:{self.control}{path}', data=data, method=method, headers={'content-type': 'application/json'})
        with urllib.request.urlopen(req, timeout=2) as r:
            return json.loads(r.read() or b'null')

    def calls(self, method: str | None = None) -> list[dict]:
        """Appels reçus de l'application (méthode du démon et arguments)."""
        return [c for c in self._request('GET', '/calls') if method is None or c['method'] == method]

    def wait_call(self, method: str, timeout: float = 10) -> dict:
        return wait_until(lambda: (self.calls(method) or [None])[-1], timeout, f'appel {method}')

    def incoming(self, chat_id: str, text: str) -> None:
        """Message reçu dans une discussion."""
        self._request('POST', '/incoming', {'chatId': chat_id, 'text': text})

    def pair(self) -> None:
        """Appairage terminé (QR scanné) : connecté."""
        self._request('POST', '/pair', {})

    def stop(self) -> None:
        if self.proc.poll() is None:
            self.proc.terminate()
            self.proc.wait(5)
        self._log.close()


# décalage coordonnées « fenêtre » de l'accessibilité (GTK 4 sous X11) → écran, mesuré une fois
_OFFSET: tuple[int, int] | None = None


class App:
    """L'application, pilotée par l'accessibilité."""

    def __init__(self, fake: Fake, ready: str) -> None:
        self.fake = fake
        self.log_path = fake.dir / 'app.log'
        env = dict(os.environ)
        env.update(
            WA_GNOME_URL=fake.url,
            # jeton et réglages du faux démon : jamais ceux de l'utilisateur
            WA_GNOME_DATA_DIR=str(fake.dir / 'data'),
            XDG_CACHE_HOME=str(fake.dir / 'cache'),
            XDG_CONFIG_HOME=str(fake.dir / 'config'),
            # identifiant propre au test : actions D-Bus (boutons des notifications)
            WA_GNOME_APP_ID=f'io.github.maarekj.WaGnome.E2e{fake.port}',
        )
        self.app_id = env['WA_GNOME_APP_ID']
        self._log = self.log_path.open('w')
        self.proc = subprocess.Popen(['gjs', '-m', str(ROOT / 'dist' / 'app' / 'main.js')], env=env, stdout=self._log, stderr=subprocess.STDOUT)
        self.root = wait_until(self._find_app, 20, "démarrage de l'application")
        # fenêtre à la taille de l'écran, en haut à gauche (pas de gestionnaire de fenêtres)
        xdotool('search', '--sync', '--onlyvisible', '--name', 'WhatsApp', 'windowsize', str(WIDTH), str(HEIGHT), 'windowmove', '0', '0', 'windowfocus', '--sync')
        time.sleep(0.5)
        self.text_visible(ready, 20)
        self._calibrate()

    def _find_app(self):
        for a in tree.root.children:
            try:
                if a.name == 'gjs' and a.get_process_id() == self.proc.pid:
                    return a
            except Exception:  # noqa: BLE001
                continue
        return None

    def _checked(self, node) -> bool:
        st = node.getState()
        return st.contains(Atspi.StateType.CHECKED) or st.contains(Atspi.StateType.PRESSED)

    def _calibrate(self) -> None:
        """Décalage accessibilité → écran, mesuré sur le filtre « Non lues » (bascule) de la liste."""
        global _OFFSET
        if not self.has('toggle button', 'Non lues'):
            return  # écran d'appairage : pas de clic par coordonnées nécessaire
        unread = self.find('toggle button', 'Non lues')
        everything = self.find('toggle button', 'Toutes')
        e = unread.get_extents(Atspi.CoordType.WINDOW)
        cx, cy = e.x + e.width // 2, e.y + e.height // 2

        def works(dx: int, dy: int) -> bool:
            xdotool('mousemove', str(cx + dx), str(cy + dy), 'click', '1')
            time.sleep(0.3)
            if not self._checked(unread):
                return False
            # retour au filtre « Toutes »
            everything.doActionNamed('click')
            wait_until(lambda: not self._checked(unread), 3, 'filtre « Toutes » rétabli')
            return True

        # 17 px : ombre de la fenêtre Adwaita sous Xvfb
        candidates = ([_OFFSET] if _OFFSET is not None else []) + [(17, 17), (0, 0), (0, 17), (17, 0)]
        for dx, dy in candidates:
            if works(dx, dy):
                _OFFSET = (dx, dy)
                return
        raise AssertionError("calibrage impossible : filtre « Non lues » introuvable à l'écran")

    # ---------------------------------------------------------------- recherche

    def find(self, role: str | None = None, name: str | None = None, *, contains: str | None = None, timeout: float = 10, within=None):
        """Premier nœud visible du rôle et du nom (exact, ou contenant `contains`)."""
        scope = within or self.root

        def match(n) -> bool:
            if role is not None and n.roleName != role:
                return False
            if name is not None and n.name != name:
                return False
            if contains is not None and contains not in (n.name or ''):
                return False
            return n.showing

        return wait_until(lambda: scope.findChild(match, retry=False, requireResult=False), timeout, f'{role or "nœud"} « {name or contains} »')

    def has(self, role: str | None = None, name: str | None = None, *, contains: str | None = None) -> bool:
        try:
            self.find(role, name, contains=contains, timeout=0.5)
            return True
        except AssertionError:
            return False

    def all(self, role: str, name: str | None = None, *, contains: str | None = None) -> list:
        return self.root.findChildren(lambda n: n.roleName == role and n.showing and (name is None or n.name == name) and (contains is None or contains in (n.name or '')))

    def labels(self) -> list[str]:
        """Textes des libellés affichés."""
        return [n.name or '' for n in self.root.findChildren(lambda n: n.roleName == 'label' and n.showing)]

    def text_visible(self, text: str, timeout: float = 10) -> bool:
        """Un libellé affiché contient `text`."""
        return bool(wait_until(lambda: any(text in t for t in self.labels()), timeout, f'texte « {text} » affiché'))

    def text_gone(self, text: str, timeout: float = 10) -> bool:
        return bool(wait_until(lambda: not any(text in t for t in self.labels()), timeout, f'texte « {text} » disparu'))

    # ---------------------------------------------------------------- actions

    def click(self, role: str | None = None, name: str | None = None, *, contains: str | None = None, timeout: float = 10):
        """Active un widget par son action d'accessibilité, sinon par un clic réel en son centre."""
        node = self.find(role, name, contains=contains, timeout=timeout)
        if 'click' in node.actions:
            node.doActionNamed('click')
        else:
            self.point(node)
        return node

    def point(self, node, button: str = '1') -> None:
        """Clic réel (XTest) au centre du nœud."""
        e = node.get_extents(Atspi.CoordType.WINDOW)
        dx, dy = _OFFSET or (0, 0)
        xdotool('mousemove', str(e.x + e.width // 2 + dx), str(e.y + e.height // 2 + dy), 'click', button)
        time.sleep(0.2)

    def drag(self, start, end) -> None:
        """Glisser (bouton gauche, XTest) du centre du nœud `start` au centre de `end`, par petits pas."""
        dx, dy = _OFFSET or (0, 0)

        def center(node) -> tuple[int, int]:
            e = node.get_extents(Atspi.CoordType.WINDOW)
            return e.x + e.width // 2 + dx, e.y + e.height // 2 + dy

        (x0, y0), (x1, y1) = center(start), center(end)
        xdotool('mousemove', str(x0), str(y0), 'mousedown', '1')
        for i in range(1, 11):
            xdotool('mousemove', str(x0 + (x1 - x0) * i // 10), str(y0 + (y1 - y0) * i // 10))
            time.sleep(0.03)
        xdotool('mouseup', '1')
        time.sleep(0.3)

    def open_chat(self, name: str) -> None:
        """Ouvre une discussion de la barre latérale (clic sur son nom)."""
        self.point(self.find('label', name))
        wait_until(lambda: len(self.all('label', name)) >= 2, 10, f'discussion « {name} » ouverte')

    def composer(self):
        """Zone de saisie : la vue de texte éditable."""
        return wait_until(
            lambda: self.root.findChild(lambda n: n.roleName == 'text' and n.showing and n.getState().contains(Atspi.StateType.EDITABLE) and 'Message' in (n.description or n.name or ''), retry=False, requireResult=False)
            or self.root.findChild(lambda n: n.roleName == 'text' and n.showing and n.getState().contains(Atspi.StateType.EDITABLE), retry=False, requireResult=False),
            10,
            'zone de saisie',
        )

    def send(self, text: str) -> None:
        """Saisit `text` dans la zone de saisie puis l'envoie."""
        composer = self.composer()
        composer.text = text
        wait_until(lambda: composer.text == text, 5, 'texte saisi')
        self.click('button', 'Envoyer')

    def key(self, combo: str) -> None:
        """Touche ou raccourci xdotool (`Escape`, `ctrl+n`…)."""
        xdotool('key', '--clearmodifiers', combo)
        time.sleep(0.2)

    def type(self, text: str) -> None:
        subprocess.run(['xdotool', 'type', '--delay', '20', '--', text], check=True, timeout=30)
        time.sleep(0.2)

    def menu_item(self, name: str) -> None:
        self.find('menu item', name).doActionNamed('click')

    def action(self, name: str, parameter: str | None = None) -> None:
        """Active une action de l'application par D-Bus (comme GNOME Shell pour un bouton de notification)."""
        path = '/' + self.app_id.replace('.', '/')
        params = f'[<{parameter}>]' if parameter is not None else '[]'
        subprocess.run(['gdbus', 'call', '--session', '--dest', self.app_id, '--object-path', path, '--method', 'org.gtk.Actions.Activate', name, params, '{}'], check=True, capture_output=True, timeout=5)

    def screenshot(self, path: str) -> None:
        """Capture de l'écran virtuel (diagnostic d'un test)."""
        subprocess.run(['import', '-window', 'root', path], check=True, timeout=10)

    def stop(self) -> None:
        self.proc.terminate()
        try:
            self.proc.wait(5)
        except subprocess.TimeoutExpired:
            self.proc.kill()
        self._log.close()


@pytest.fixture
def run_app():
    """`run_app(state, ready)` : démarre un faux démon et l'application, attend le texte `ready`."""
    started: list = []

    def start(state: str = 'open', ready: str = 'Alice Martin') -> tuple[Fake, App]:
        fake = Fake(state)
        started.append(fake)
        app = App(fake, ready)
        started.append(app)
        return fake, app

    yield start
    for thing in reversed(started):
        thing.stop()
