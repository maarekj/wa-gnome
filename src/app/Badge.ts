// Compteur de non-lus hors de la fenêtre, tant que l'application tourne :
//  - icône de la barre du haut (StatusNotifierItem, extension AppIndicator de GNOME) avec le
//    nombre en libellé ; clic : fenêtre ;
//  - compteur des docks qui le gèrent (Dash to Dock, Dash to Panel : API Unity LauncherEntry).
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const ITEM_PATH = '/StatusNotifierItem';
const ITEM_XML = `<node>
  <interface name="org.kde.StatusNotifierItem">
    <property name="Category" type="s" access="read"/>
    <property name="Id" type="s" access="read"/>
    <property name="Title" type="s" access="read"/>
    <property name="Status" type="s" access="read"/>
    <property name="IconName" type="s" access="read"/>
    <property name="AttentionIconName" type="s" access="read"/>
    <property name="ToolTip" type="(sa(iiay)ss)" access="read"/>
    <property name="ItemIsMenu" type="b" access="read"/>
    <property name="Menu" type="o" access="read"/>
    <property name="XAyatanaLabel" type="s" access="read"/>
    <method name="Activate"><arg name="x" type="i" direction="in"/><arg name="y" type="i" direction="in"/></method>
    <method name="SecondaryActivate"><arg name="x" type="i" direction="in"/><arg name="y" type="i" direction="in"/></method>
    <method name="ContextMenu"><arg name="x" type="i" direction="in"/><arg name="y" type="i" direction="in"/></method>
    <method name="Scroll"><arg name="delta" type="i" direction="in"/><arg name="orientation" type="s" direction="in"/></method>
    <signal name="NewStatus"><arg name="status" type="s"/></signal>
    <signal name="NewToolTip"/>
    <signal name="NewIcon"/>
    <signal name="XAyatanaNewLabel"><arg name="label" type="s"/><arg name="guide" type="s"/></signal>
  </interface>
</node>`;

/** Infobulle de l'icône selon le nombre de discussions non lues. */
export const badgeTooltip = (count: number): string => (count === 0 ? 'Aucun message non lu' : count === 1 ? '1 discussion non lue' : `${count} discussions non lues`);

export class Badge {
  readonly #appId: string;
  readonly #activate: () => void;
  #count = 0;
  #item: Gio.DBusExportedObject | null = null;
  #watcher = 0;

  constructor(appId: string, activate: () => void) {
    this.#appId = appId;
    this.#activate = activate;
  }

  /** Icône exportée et inscrite auprès de la barre du haut (réinscrite si l'extension redémarre). */
  start(): void {
    if (this.#item !== null) return;
    const bus = Gio.DBus.session;
    const status = (): string => (this.#count > 0 ? 'NeedsAttention' : 'Active');
    const tooltip = (): string => badgeTooltip(this.#count);
    const label = (): string => (this.#count > 0 ? String(this.#count) : '');
    const item = Gio.DBusExportedObject.wrapJSObject(ITEM_XML, {
      Category: 'Communications',
      Id: this.#appId,
      Title: 'WhatsApp',
      get Status(): string {
        return status();
      },
      IconName: this.#appId,
      AttentionIconName: this.#appId,
      get ToolTip(): [string, [number, number, Uint8Array][], string, string] {
        return ['', [], 'WhatsApp', tooltip()];
      },
      ItemIsMenu: false,
      Menu: '/NO_DBUSMENU',
      get XAyatanaLabel(): string {
        return label();
      },
      Activate: (): void => this.#activate(),
      SecondaryActivate: (): void => this.#activate(),
      ContextMenu: (): void => this.#activate(),
      Scroll: (): void => {
        // défilement sur l'icône : rien
      },
    });
    item.export(bus, ITEM_PATH);
    this.#item = item;
    this.#watcher = Gio.bus_watch_name(Gio.BusType.SESSION, 'org.kde.StatusNotifierWatcher', Gio.BusNameWatcherFlags.NONE, () => this.#register(), null);
    this.#emitLauncher();
  }

  #register(): void {
    const name = Gio.DBus.session.get_unique_name();
    if (name === null) return;
    Gio.DBus.session.call('org.kde.StatusNotifierWatcher', '/StatusNotifierWatcher', 'org.kde.StatusNotifierWatcher', 'RegisterStatusNotifierItem', new GLib.Variant('(s)', [name]), null, Gio.DBusCallFlags.NONE, 5000, null, (conn: Gio.DBusConnection | null, res: Gio.AsyncResult) => {
      try {
        conn?.call_finish(res);
      } catch (error) {
        console.error(`icône de la barre du haut : ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  }

  /** Nombre de discussions non lues (tous comptes). */
  set(count: number): void {
    if (count === this.#count) return;
    this.#count = count;
    const item = this.#item;
    if (item === null) return;
    item.emit_signal('NewStatus', new GLib.Variant('(s)', [count > 0 ? 'NeedsAttention' : 'Active']));
    item.emit_signal('NewToolTip', new GLib.Variant('()', []));
    item.emit_signal('XAyatanaNewLabel', new GLib.Variant('(ss)', [count > 0 ? String(count) : '', '999']));
    item.emit_signal('NewIcon', new GLib.Variant('()', []));
    this.#emitLauncher();
  }

  /** Compteur des docks (Unity LauncherEntry) : signal sur le bus de session. */
  #emitLauncher(): void {
    try {
      Gio.DBus.session.emit_signal(
        null,
        `/${this.#appId.replaceAll('.', '/')}/LauncherEntry`,
        'com.canonical.Unity.LauncherEntry',
        'Update',
        new GLib.Variant('(sa{sv})', [`application://${this.#appId}.desktop`, { count: new GLib.Variant('x', this.#count), 'count-visible': new GLib.Variant('b', this.#count > 0) }]),
      );
    } catch (error) {
      console.error(`compteur du dock : ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  stop(): void {
    this.set(0);
    if (this.#watcher !== 0) Gio.bus_unwatch_name(this.#watcher);
    this.#watcher = 0;
    this.#item?.unexport();
    this.#item = null;
  }
}
