#!/usr/bin/env bash
# Linux-only: cable AsaphOps MCU + XT1–XT3 to kernel VirMIDI via PipeWire.
set -euo pipefail

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "This script is for Linux only." >&2
  exit 1
fi

if ! grep -q '^snd_virmidi' /proc/modules; then
  echo "Load VirMIDI (once per boot):"
  echo "  sudo modprobe snd-virmidi midi_devs=8"
  exit 1
fi

if ! pw-link -o 2>/dev/null | grep -q AsaphOps; then
  echo "Start the AsaphOps companion first, then run this again."
  exit 1
fi

link_pair() {
  local name="$1" a="$2" b="$3"
  local out vin in vout
  out=$(pw-link -o | grep AsaphOps | grep -F "$name" | head -1 || true)
  vin=$(pw-link -i | grep "VirMIDI 1-$a" | head -1 || true)
  in=$(pw-link -i | grep AsaphOps | grep -F "$name" | head -1 || true)
  vout=$(pw-link -o | grep "VirMIDI 1-$b" | head -1 || true)
  if [[ -n "$out" && -n "$vin" ]]; then
    pw-link "$out" "$vin" 2>/dev/null || true
    echo "  $out"
    echo "    -> $vin"
  fi
  if [[ -n "$vout" && -n "$in" ]]; then
    pw-link "$vout" "$in" 2>/dev/null || true
    echo "  $vout"
    echo "    -> $in"
  fi
}

link_pair MCU 0 1
link_pair XT1 2 3
link_pair XT2 4 5
link_pair XT3 6 7

echo
echo "Reaper MIDI Devices: all unchecked."
echo "Control surfaces:"
echo "  Mackie Control           in=hw:VirMIDI   out=hw:VirMIDI,1"
echo "  Mackie Control Extender  in=hw:VirMIDI,2 out=hw:VirMIDI,3"
echo "  Mackie Control Extender  in=hw:VirMIDI,4 out=hw:VirMIDI,5"
echo "  Mackie Control Extender  in=hw:VirMIDI,6 out=hw:VirMIDI,7"
echo "Then open the mixer from that endpoint in the AsaphOps web app."
