#include "MidiPassthrough.h"
#include <cstring>
#include <juce_core/juce_core.h>

namespace AsaphOps {

MidiPassthrough::MidiPassthrough()
{
    for (int i = 0; i < kSurfaceCount; ++i)
        surfaces[(size_t) i].name = kPortNames[i];
}

MidiPassthrough::~MidiPassthrough()
{
    stop();
}

bool MidiPassthrough::start()
{
    stop();

   #if JUCE_LINUX || JUCE_BSD || JUCE_MAC || JUCE_IOS
    bool ok = true;
    for (int i = 0; i < kSurfaceCount; ++i)
    {
        auto& s = surfaces[(size_t) i];
        s.midiOut = juce::MidiOutput::createNewDevice (s.name);
        s.midiIn  = juce::MidiInput::createNewDevice (s.name, this);
        if (s.midiIn == nullptr || s.midiOut == nullptr)
        {
            ok = false;
            break;
        }
        s.midiIn->start();
    }
   #else
    status = "virtual MIDI not supported on this OS";
    sendChangeMessage();
    return false;
   #endif

    if (! ok)
    {
        stop();
        status = "failed to create MIDI ports (MCU + XT1–XT3)";
        juce::Logger::writeToLog ("MIDI passthrough: " + status);
        sendChangeMessage();
        return false;
    }

    portsOpen = true;
   #if JUCE_LINUX
    ensureKernelVirMidi();
    status = "waiting for kernel VirMIDI — Reaper should use Virtual Raw MIDI, not its own “virtual”";
    bridgeLinuxDaw();
    startTimerHz (2);
   #else
    status = "MIDI ports open — DAW: MCU + three Mackie Control Extenders (XT1–XT3)";
   #endif
    juce::Logger::writeToLog ("MIDI passthrough: MCU + XT1 XT2 XT3");
    sendChangeMessage();
    return true;
}

void MidiPassthrough::stop()
{
    stopTimer();
    for (auto& s : surfaces)
    {
        if (s.midiIn != nullptr)
            s.midiIn->stop();
        s.midiIn.reset();
        s.midiOut.reset();
        s.loggedFirstIncoming = false;
    }
    portsOpen = false;
    linuxBridged = false;
    kernelVirMidiSeen = false;
    {
        const juce::ScopedLock sl (lock);
        status = "stopped";
    }
}

void MidiPassthrough::setIncomingMidiHandler (std::function<void (int, juce::MidiMessage)> handler)
{
    const juce::ScopedLock sl (lock);
    incoming = std::move (handler);
}

void MidiPassthrough::sendRaw (int surface, const juce::uint8* data, int size)
{
    if (surface < 0 || surface >= kSurfaceCount || data == nullptr || size <= 0)
        return;
    auto& s = surfaces[(size_t) surface];
    if (s.midiOut == nullptr)
        return;
    rememberOutgoing (surface, data, size);
    s.midiOut->sendMessageNow (juce::MidiMessage (data, size));
}

void MidiPassthrough::sendHex (int surface, const juce::String& hex)
{
    juce::MemoryBlock block;
    block.loadFromHexString (hex.trim());
    if (block.getSize() > 0)
        sendRaw (surface, static_cast<const juce::uint8*> (block.getData()), (int) block.getSize());
}

juce::String MidiPassthrough::getPortName() const
{
    return "AsaphOps MCU + XT1–XT3";
}

juce::String MidiPassthrough::getSetupHint() const
{
   #if JUCE_LINUX
    if (linuxBridged.load (std::memory_order_acquire))
        return "Do not enable hw:VirMIDI in MIDI Devices. Leave all MIDI Devices unchecked.\n"
               "Control surfaces (Mackie Control + 3 Extenders):\n"
               "  MCU  in=hw:VirMIDI   out=hw:VirMIDI,1\n"
               "  XT1  in=hw:VirMIDI,2 out=hw:VirMIDI,3\n"
               "  XT2  in=hw:VirMIDI,4 out=hw:VirMIDI,5\n"
               "  XT3  in=hw:VirMIDI,6 out=hw:VirMIDI,7\n"
               "Mixer protocol is in the AsaphOps web app.";
    if (! kernelVirMidiSeen.load (std::memory_order_acquire))
        return "Linux MIDI: Reaper cannot see AsaphOps ports (it only lists kernel devices).\n"
               "Once:  sudo modprobe snd-virmidi midi_devs=8\n"
               "Restart companion. MIDI Devices all off. Then four Mackie surfaces on VirMIDI 0/1, 2/3, 4/5, 6/7.";
    return "VirMIDI is loaded. Need midi_devs=8 (four in/out pairs). MIDI Devices all off.\n"
           "If cables are missing, run asaphops/scripts/linux-mcu-connect.sh or use qpwgraph.";
   #else
    return "Add Mackie Control Universal on AsaphOps MCU, then three Mackie Control Extenders on AsaphOps XT1, XT2, XT3.";
   #endif
}

juce::String MidiPassthrough::getStatus() const
{
    const juce::ScopedLock sl (lock);
    return status;
}

juce::String MidiPassthrough::portSnapshotJson() const
{
    auto* root = new juce::DynamicObject();
    root->setProperty ("portsOpen", arePortsOpen());
    root->setProperty ("bridged", linuxBridged.load (std::memory_order_acquire));
    root->setProperty ("status", getStatus());
    root->setProperty ("hint", getSetupHint().replaceCharacters ("\n", " "));
    root->setProperty ("surfaces", kSurfaceCount);
    return juce::JSON::toString (juce::var (root), false);
}

void MidiPassthrough::rememberOutgoing (int surface, const juce::uint8* data, int size)
{
    auto& s = surfaces[(size_t) surface];
    const juce::ScopedLock sl (lock);
    auto& slot = s.recentOut[(size_t) s.recentOutIndex];
    slot.bytes.setSize ((size_t) size, false);
    slot.bytes.copyFrom (data, 0, (size_t) size);
    slot.atMs = juce::Time::getMillisecondCounter();
    s.recentOutIndex = (s.recentOutIndex + 1) % (int) s.recentOut.size();
}

bool MidiPassthrough::isLocalEcho (int surface, const juce::MidiMessage& message) const
{
    const auto* data = message.getRawData();
    const int n = message.getRawDataSize();
    if (data == nullptr || n <= 0)
        return true;
    const auto now = juce::Time::getMillisecondCounter();
    const auto& s = surfaces[(size_t) surface];
    const juce::ScopedLock sl (lock);
    for (auto& slot : s.recentOut)
    {
        if (slot.atMs == 0 || now - slot.atMs > 120)
            continue;
        if ((int) slot.bytes.getSize() == n
            && std::memcmp (slot.bytes.getData(), data, (size_t) n) == 0)
            return true;
    }
    return false;
}

int MidiPassthrough::surfaceForInput (juce::MidiInput* source) const
{
    for (int i = 0; i < kSurfaceCount; ++i)
        if (surfaces[(size_t) i].midiIn.get() == source)
            return i;
    return 0;
}

void MidiPassthrough::handleIncomingMidiMessage (juce::MidiInput* source, const juce::MidiMessage& message)
{
    if (message.getRawDataSize() <= 0)
        return;
    const auto statusByte = (juce::uint8) message.getRawData()[0];
    if (statusByte == 0xF8 || statusByte == 0xFE)
        return;
    const int surface = surfaceForInput (source);
    if (isLocalEcho (surface, message))
        return;

    std::function<void (int, juce::MidiMessage)> handler;
    {
        const juce::ScopedLock sl (lock);
        handler = incoming;
    }
    if (! handler)
        return;
    if (! surfaces[(size_t) surface].loggedFirstIncoming.exchange (true))
        juce::Logger::writeToLog ("MIDI passthrough: first DAW message on "
                                  + surfaces[(size_t) surface].name);
    handler (surface, message);
}

void MidiPassthrough::timerCallback()
{
   #if JUCE_LINUX
    if (! linuxBridged.load (std::memory_order_acquire))
        bridgeLinuxDaw();
   #endif
}

#if JUCE_LINUX
bool MidiPassthrough::isKernelVirMidiName (const juce::String& clientName, const juce::String& portLine)
{
    if (clientName.contains ("Virtual RawMIDI") && ! clientName.contains ("Virtual Raw MIDI"))
        return false;
    return clientName.contains ("Virtual Raw MIDI") || portLine.contains ("VirMIDI");
}

void MidiPassthrough::ensureKernelVirMidi()
{
    if (triedModprobe)
        return;
    triedModprobe = true;

    const auto text = juce::File ("/proc/asound/seq/clients").loadFileAsString();
    if (text.contains ("VirMIDI") || text.contains ("Virtual Raw MIDI"))
        return;

    juce::ChildProcess proc;
    proc.start (juce::StringArray { "modprobe", "snd-virmidi", "midi_devs=8" });
    proc.waitForProcessToFinish (2000);
}

void MidiPassthrough::bridgeLinuxDaw()
{
    const auto now = juce::Time::getMillisecondCounter();
    if (now - lastBridgeTryMs < 1500)
        return;
    lastBridgeTryMs = now;

    const auto text = juce::File ("/proc/asound/seq/clients").loadFileAsString();
    if (text.isEmpty())
        return;

    struct SeqPort { int client = -1; int port = -1; };
    SeqPort oursIn[kSurfaceCount], oursOut[kSurfaceCount];
    juce::Array<SeqPort> virMidi;
    int curClient = -1;
    juce::String curName;
    bool oursClient = false;

    auto lines = juce::StringArray::fromLines (text);
    for (auto& raw : lines)
    {
        auto line = raw.trim();
        if (line.startsWith ("Client"))
        {
            curClient = line.fromFirstOccurrenceOf ("Client", false, false).getIntValue();
            const auto q1 = line.indexOfChar ('"');
            const auto q2 = line.lastIndexOfChar ('"');
            curName = (q1 >= 0 && q2 > q1) ? line.substring (q1 + 1, q2) : juce::String();
            oursClient = curName == "AsaphOps" || curName.contains ("AsaphOps");
            continue;
        }
        if (! line.startsWith ("Port") || curClient < 0)
            continue;

        const int port = line.fromFirstOccurrenceOf ("Port", false, false).getIntValue();
        const bool isIn = line.contains ("[In]");
        const bool isOut = line.contains ("[Out]");

        int surface = -1;
        if (oursClient)
        {
            if (line.contains ("AsaphOps MCU") || line.contains ("MCU"))
                surface = 0;
            else if (line.contains ("XT1"))
                surface = 1;
            else if (line.contains ("XT2"))
                surface = 2;
            else if (line.contains ("XT3"))
                surface = 3;
        }

        if (surface >= 0)
        {
            if (isIn)
                oursIn[surface] = { curClient, port };
            if (isOut)
                oursOut[surface] = { curClient, port };
        }
        else if (! oursClient && isKernelVirMidiName (curName, line))
        {
            SeqPort p { curClient, port };
            bool already = false;
            for (auto& v : virMidi)
                if (v.client == p.client && v.port == p.port)
                    already = true;
            if (! already)
                virMidi.add (p);
        }
    }

    kernelVirMidiSeen.store (virMidi.size() >= 1, std::memory_order_release);

    if (virMidi.size() < 8)
    {
        if (oursIn[0].client >= 0 && ! linuxBridged.load())
        {
            {
                const juce::ScopedLock sl (lock);
                if (virMidi.isEmpty())
                    status = "need kernel VirMIDI — sudo modprobe snd-virmidi midi_devs=8  then restart companion";
                else
                    status = "need eight VirMIDI ports (midi_devs=8) for MCU + 3 extenders";
            }
            sendChangeMessage();
        }
        return;
    }

    for (int i = 0; i < kSurfaceCount; ++i)
        if (oursIn[i].client < 0 || oursOut[i].client < 0)
            return;

    auto connect = [] (int srcC, int srcP, int dstC, int dstP)
    {
        juce::ChildProcess proc;
        proc.start (juce::StringArray {
            "aconnect",
            juce::String (srcC) + ":" + juce::String (srcP),
            juce::String (dstC) + ":" + juce::String (dstP)
        });
        proc.waitForProcessToFinish (800);
    };

    for (int i = 0; i < kSurfaceCount; ++i)
    {
        connect (oursOut[i].client, oursOut[i].port, virMidi[i * 2].client, virMidi[i * 2].port);
        connect (virMidi[i * 2 + 1].client, virMidi[i * 2 + 1].port, oursIn[i].client, oursIn[i].port);
    }

    {
        juce::ChildProcess pw;
        pw.start (juce::StringArray {
            "bash", "-c",
            "link_pair() { "
            "  local name=\"$1\" a=\"$2\" b=\"$3\"; "
            "  local out in vin vout; "
            "  out=$(pw-link -o | grep AsaphOps | grep -F \"$name\" | head -1); "
            "  vin=$(pw-link -i | grep \"VirMIDI 1-$a\" | head -1); "
            "  in=$(pw-link -i | grep AsaphOps | grep -F \"$name\" | head -1); "
            "  vout=$(pw-link -o | grep \"VirMIDI 1-$b\" | head -1); "
            "  [ -n \"$out\" ] && [ -n \"$vin\" ] && pw-link \"$out\" \"$vin\"; "
            "  [ -n \"$vout\" ] && [ -n \"$in\" ] && pw-link \"$vout\" \"$in\"; "
            "}; "
            "link_pair MCU 0 1; link_pair XT1 2 3; link_pair XT2 4 5; link_pair XT3 6 7"
        });
        pw.waitForProcessToFinish (2500);
    }

    juce::ChildProcess check;
    check.start (juce::StringArray { "bash", "-c", "pw-link -l | grep -q AsaphOps && pw-link -l | grep -q VirMIDI" });
    const bool pwOk = check.waitForProcessToFinish (800) && check.getExitCode() == 0;

    if (pwOk && ! linuxBridged.exchange (true))
    {
        {
            const juce::ScopedLock sl (lock);
            status = "bridged MCU+XT1–3 to VirMIDI — Reaper: four Mackie surfaces on hw:VirMIDI 0/1, 2/3, 4/5, 6/7";
        }
        juce::Logger::writeToLog ("MIDI passthrough: PipeWire-linked MCU + extenders to VirMIDI");
        sendChangeMessage();
    }
}
#endif

} // namespace AsaphOps
