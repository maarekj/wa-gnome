// Lecteur audio (GStreamer) : lecture, puis vitesse ×2 (la position avance deux fois plus vite).
import GLib from 'gi://GLib';
import Gst from 'gi://Gst?version=1.0';
import { AudioPlayer, type PlayerState } from '../src/app/AudioPlayer.ts';

Gst.init([]);
const file = GLib.build_filenamev([GLib.get_tmp_dir(), `wa-gnome-audio-${Date.now()}.wav`]);
const make = Gst.parse_launch(`audiotestsrc num-buffers=400 ! audioconvert ! wavenc ! filesink location=${file}`);
make.set_state(Gst.State.PLAYING);
make.get_bus()?.timed_pop_filtered(10_000_000_000, Gst.MessageType.EOS | Gst.MessageType.ERROR);
make.set_state(Gst.State.NULL);

const loop = GLib.MainLoop.new(null, false);
let last: PlayerState = { playing: false, position: 0, duration: 0 };
let failure = '';
const player = new AudioPlayer(GLib.filename_to_uri(file, null), (s) => {
  last = s;
}, (message) => {
  failure = message;
});
player.play();
let atSpeed = 0;
GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
  atSpeed = last.position;
  player.setSpeed(2);
  return GLib.SOURCE_REMOVE;
});
GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
  const advanced = last.position - atSpeed;
  print(`durée ${last.duration.toFixed(2)} s, position à 1 s : ${atSpeed.toFixed(2)}, avance en 1 s à ×2 : ${advanced.toFixed(2)} ${failure}`);
  if (failure === '' && atSpeed > 0.6 && advanced > 1.5 && last.duration > 0) print('TEST OK');
  player.dispose();
  GLib.unlink(file);
  loop.quit();
  return GLib.SOURCE_REMOVE;
});
loop.run();
