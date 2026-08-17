#include "MackieSurface.h"
#include <algorithm>
#include <cmath>
#include <cstring>

namespace AsaphOps {

namespace {

constexpr int kMuteNote = 16;
constexpr int kSoloNote = 8;
constexpr int kSelectNote = 24;
constexpr int kRecNote = 0;
constexpr int kFaderTouchNote = 104;
constexpr int kBankLeftNote = 46;
constexpr int kBankRightNote = 47;
constexpr int kRampHz = 50;
constexpr int kWaitTicks = 10;

struct FaderKnot
{
    int midi;
    float db;
};

constexpr FaderKnot kFaderKnots[] = {
    { 0,     -144.0f },
    { 1311,   -60.0f },
    { 1966,   -55.0f },
    { 2621,   -50.0f },
    { 3277,   -45.0f },
    { 4096,   -40.0f },
    { 5079,   -35.0f },
    { 6062,   -30.0f },
    { 7209,   -25.0f },
    { 8519,   -20.0f },
    { 9830,   -15.0f },
    { 11304,  -10.0f },
    { 13106,   -5.0f },
    { 14880,    0.0f },
    { 15728,    5.0f },
    { 16383,   10.0f }
};

constexpr int kNumKnots = (int) (sizeof (kFaderKnots) / sizeof (kFaderKnots[0]));

void mcuResponse (const juce::uint8* c, juce::uint8* r)
{
    r[0] = (juce::uint8) (0x7F & (c[0] + (c[1] ^ 0x0A) - c[3]));
    r[1] = (juce::uint8) (0x7F & ((c[2] >> 4) ^ (c[0] + c[3])));
    r[2] = (juce::uint8) (0x7F & ((c[3] - (c[2] << 2)) ^ (c[0] | c[1])));
    r[3] = (juce::uint8) (0x7F & (c[1] - c[2] + (0xF0 ^ (c[3] << 4))));
}

} // namespace

float MackieSurface::midiToDb (int midi)
{
    midi = juce::jlimit (0, 16383, midi);
    for (int i = 1; i < kNumKnots; ++i)
    {
        if (midi <= kFaderKnots[i].midi)
        {
            const int span = kFaderKnots[i].midi - kFaderKnots[i - 1].midi;
            const float t = span > 0 ? (float) (midi - kFaderKnots[i - 1].midi) / (float) span : 0.0f;
            return kFaderKnots[i - 1].db + t * (kFaderKnots[i].db - kFaderKnots[i - 1].db);
        }
    }
    return 10.0f;
}

int MackieSurface::dbToMidi (float db)
{
    if (db <= -144.0f)
        return 0;
    if (db >= 10.0f)
        return 16383;
    for (int i = 1; i < kNumKnots; ++i)
    {
        if (db <= kFaderKnots[i].db)
        {
            const float span = kFaderKnots[i].db - kFaderKnots[i - 1].db;
            const float t = span > 0.0f ? (db - kFaderKnots[i - 1].db) / span : 0.0f;
            return juce::jlimit (0, 16383,
                                 (int) std::lround ((double) kFaderKnots[i - 1].midi
                                                    + (double) t * (double) (kFaderKnots[i].midi - kFaderKnots[i - 1].midi)));
        }
    }
    return 16383;
}

juce::String MackieSurface::charsToString (const char* chars)
{
    return juce::String (chars, 7).trim();
}

MackieSurface::MackieSurface()
{
    lcd.fill (' ');
    for (auto& s : strips)
    {
        std::fill (s.top, s.top + 8, '\0');
        std::fill (s.bottom, s.bottom + 8, '\0');
        std::fill (s.top, s.top + 7, ' ');
        std::fill (s.bottom, s.bottom + 7, ' ');
    }
}

MackieSurface::~MackieSurface()
{
    stop();
}

bool MackieSurface::start()
{
    stop();

   #if JUCE_LINUX || JUCE_BSD || JUCE_MAC || JUCE_IOS
    midiOut = juce::MidiOutput::createNewDevice (kPortName);
    midiIn  = juce::MidiInput::createNewDevice (kPortName, this);
   #else
    status = "virtual MIDI not supported on this OS";
    sendChangeMessage();
    return false;
   #endif

    if (midiIn == nullptr || midiOut == nullptr)
    {
        midiIn.reset();
        midiOut.reset();
        status = "failed to create MIDI ports";
        juce::Logger::writeToLog ("Mackie Control: " + status);
        sendChangeMessage();
        return false;
    }

    midiIn->start();
    portsOpen = true;
   #if JUCE_LINUX
    ensureKernelVirMidi();
    status = "waiting for kernel VirMIDI — Reaper should use Virtual Raw MIDI, not its own “virtual”";
    bridgeLinuxDaw();
   #else
    status = "waiting for DAW — add Mackie Control, MIDI I/O = AsaphOps MCU";
   #endif
    juce::Logger::writeToLog ("Mackie Control ports created as '" + juce::String (kPortName) + "'");
    sendHostConnectionQuery();
    startTimerHz (kRampHz);
    sendChangeMessage();
    return true;
}

void MackieSurface::stop()
{
    stopTimer();
    if (midiIn != nullptr)
        midiIn->stop();
    midiIn.reset();
    midiOut.reset();
    portsOpen = false;
    hostLinked = false;
    scan = Scan::Idle;
    linuxBridged = false;
    kernelVirMidiSeen = false;
    status = "stopped";
}

juce::Array<MackieSurface::MixerTrack> MackieSurface::getTracks() const
{
    juce::Array<MixerTrack> out;
    const juce::ScopedLock sl (lock);
    for (int i = 0; i < tracks.size(); ++i)
    {
        const auto& t = tracks.getReference (i);
        if (t.name.isEmpty() && t.midi < 0)
            continue;
        MixerTrack row;
        row.index = i;
        row.name = t.name.isNotEmpty() ? t.name : ("Ch " + juce::String (i + 1));
        row.known = t.midi >= 0;
        row.db = t.midi >= 0 ? midiToDb (t.midi) : -144.0f;
        row.isMaster = false;
        out.add (row);
    }
    MixerTrack master;
    master.index = -1;
    master.name = "Master";
    master.isMaster = true;
    master.known = masterMidi >= 0;
    master.db = masterMidi >= 0 ? midiToDb (masterMidi) : -144.0f;
    out.add (master);
    return out;
}

void MackieSurface::setTrackDb (int index, float db, bool touching)
{
    const juce::ScopedLock sl (lock);
    pendingIsMaster = false;
    pendingIndex = index;
    pendingMidi = dbToMidi (db);
    pendingTouch = touching;
    if (index >= 0)
    {
        while (tracks.size() <= index)
            tracks.add ({});
        tracks.getReference (index).midi = pendingMidi;
    }
}

void MackieSurface::setMasterDb (float db, bool touching)
{
    const juce::ScopedLock sl (lock);
    pendingIsMaster = true;
    pendingIndex = -1;
    pendingMidi = dbToMidi (db);
    pendingTouch = touching;
    masterMidi = pendingMidi;
}

void MackieSurface::requestScan()
{
    const juce::ScopedLock sl (lock);
    if (hostLinked.load (std::memory_order_acquire))
        beginScanLocked();
}

juce::String MackieSurface::getSetupHint() const
{
   #if JUCE_LINUX
    if (isHostLinked())
        return {};
    if (linuxBridged.load (std::memory_order_acquire))
        return "Do not enable hw:VirMIDI in MIDI Devices (Input/All/Control/Output). That double-open aborts Reaper on Linux.\n"
               "Add Mackie Control Universal only: MIDI in = hw:VirMIDI, MIDI out = hw:VirMIDI,1.\n"
               "Patchbay if needed: qpwgraph.";
    if (! kernelVirMidiSeen.load (std::memory_order_acquire))
        return "Linux MIDI: Reaper cannot see AsaphOps MCU (it only lists kernel devices).\n"
               "Once:  sudo modprobe snd-virmidi midi_devs=2\n"
               "Restart companion. In Reaper leave all MIDI Devices unchecked, then Mackie in/out = hw:VirMIDI / hw:VirMIDI,1.";
    return "VirMIDI is loaded. Leave MIDI Devices all off. Mackie Control: in = hw:VirMIDI, out = hw:VirMIDI,1.\n"
           "If cables are missing, open qpwgraph.";
   #else
    if (isHostLinked())
        return {};
    return "Add Mackie Control Universal, MIDI I/O = AsaphOps MCU";
   #endif
}

juce::String MackieSurface::getStatus() const
{
    const juce::ScopedLock sl (lock);
    return status;
}

void MackieSurface::handleIncomingMidiMessage (juce::MidiInput*, const juce::MidiMessage& message)
{
    lastHostMessageMs.store (juce::Time::getMillisecondCounter(), std::memory_order_release);
    if (message.isSysEx())
        handleSysex (message);
    else if (message.isPitchWheel())
        handlePitchBend (message);
    else if (message.isNoteOnOrOff())
        handleNote (message);
}

void MackieSurface::timerCallback()
{
    bool notify = false;
    {
        const juce::ScopedLock sl (lock);
        const auto now = juce::Time::getMillisecondCounter();
        const auto lastHost = lastHostMessageMs.load (std::memory_order_acquire);
        if (hostLinked.load (std::memory_order_acquire) && lastHost > 0 && now - lastHost > 8000)
        {
            hostLinked = false;
            scan = Scan::Idle;
            status = "DAW MIDI timed out — waiting for Mackie Control again";
            notify = true;
        }
        tickScan();
        flushPendingFader();
    }
   #if JUCE_LINUX
    if (! hostLinked.load (std::memory_order_acquire))
        bridgeLinuxDaw();
   #endif
    if (notify)
        sendChangeMessage();
}

void MackieSurface::send (const juce::MidiMessage& message)
{
    if (midiOut != nullptr)
        midiOut->sendMessageNow (message);
}

void MackieSurface::sendSysex (juce::uint8 cmd, const juce::uint8* data, int len)
{
    juce::MemoryBlock block;
    const juce::uint8 hdr[5] = { 0x00, 0x00, 0x66, deviceId, cmd };
    block.append (hdr, 5);
    if (data != nullptr && len > 0)
        block.append (data, (size_t) len);
    send (juce::MidiMessage::createSysExMessage (block.getData(), (int) block.getSize()));
}

void MackieSurface::sendHostConnectionQuery()
{
    juce::Random rng;
    for (auto& b : challenge)
        b = (juce::uint8) rng.nextInt (128);
    juce::uint8 payload[11];
    std::memcpy (payload, kSerial, 7);
    std::memcpy (payload + 7, challenge, 4);
    sendSysex (0x01, payload, 11);
}

void MackieSurface::sendHostConnectionConfirm()
{
    sendSysex (0x03, kSerial, 7);
}

void MackieSurface::sendVersionReply()
{
    const juce::uint8 ver[5] = { 'V', '1', '.', '0', ' ' };
    sendSysex (0x14, ver, 5);
}

void MackieSurface::sendFader (int strip, int midi14)
{
    midi14 = juce::jlimit (0, 16383, midi14);
    const int channel = (strip == kMasterStrip) ? 9 : strip + 1;
    send (juce::MidiMessage::pitchWheel (channel, midi14));
}

void MackieSurface::sendTouch (int strip, bool down)
{
    send (juce::MidiMessage::noteOn (1, kFaderTouchNote + strip, (juce::uint8) (down ? 127 : 0)));
}

void MackieSurface::sendNoteBang (int note)
{
    send (juce::MidiMessage::noteOn (1, note, (juce::uint8) 127));
    send (juce::MidiMessage::noteOff (1, note));
}

void MackieSurface::handleSysex (const juce::MidiMessage& message)
{
    const auto* d = message.getSysExData();
    const int n = message.getSysExDataSize();
    if (d == nullptr || n < 5)
        return;
    if (d[0] != 0x00 || d[1] != 0x00 || d[2] != 0x66)
        return;
    const juce::uint8 id = d[3];
    if (id != 0x14 && id != 0x10 && id != 0x15)
        return;
    deviceId = (id == 0x15 ? (juce::uint8) 0x14 : id);
    const juce::uint8 cmd = d[4];
    switch (cmd)
    {
        case 0x00: sendHostConnectionQuery(); break;
        case 0x02:
        {
            if (n < 16)
                break;
            juce::uint8 expected[4];
            mcuResponse (challenge, expected);
            (void) expected;
            sendHostConnectionConfirm();
            hostLinked = true;
            {
                const juce::ScopedLock sl (lock);
                status = "Mackie Control linked";
                if (scan == Scan::Idle)
                    beginScanLocked();
            }
            break;
        }
        case 0x0F:
            hostLinked = false;
            {
                const juce::ScopedLock sl (lock);
                status = "DAW went offline";
                scan = Scan::Idle;
            }
            break;
        case 0x12:
            if (n >= 6)
                writeLcd ((int) d[5], d + 6, n - 6);
            return;
        case 0x13: sendVersionReply(); break;
        default: break;
    }
    sendChangeMessage();
}

void MackieSurface::handlePitchBend (const juce::MidiMessage& message)
{
    const int ch = message.getChannel();
    const int midi = message.getPitchWheelValue();
    if (ch < 1 || ch > 9)
        return;
    const bool wasLinked = hostLinked.exchange (true);
    const juce::ScopedLock sl (lock);
    if (! wasLinked && scan == Scan::Idle)
        beginScanLocked();
    if (status.containsIgnoreCase ("waiting") || status.containsIgnoreCase ("timed out"))
        status = "Mackie Control linked";
    if (ch == 9)
    {
        if (touchingIndex != -2)
            masterMidi = midi;
        return;
    }
    const int strip = ch - 1;
    strips[(size_t) strip].midi = midi;
    const int idx = bankOffset + strip;
    if (touchingIndex == idx)
        return;
    while (tracks.size() <= idx)
        tracks.add ({});
    tracks.getReference (idx).midi = midi;
    if (tracks.getReference (idx).name.isEmpty())
        tracks.getReference (idx).name = charsToString (strips[(size_t) strip].top);
}

void MackieSurface::handleNote (const juce::MidiMessage& message)
{
    const int note = message.getNoteNumber();
    const bool on = message.isNoteOn() && message.getVelocity() > 0;
    const juce::ScopedLock sl (lock);
    if (note >= kRecNote && note < kRecNote + kStripCount)
        strips[(size_t) (note - kRecNote)].rec = on;
    else if (note >= kSoloNote && note < kSoloNote + kStripCount)
        strips[(size_t) (note - kSoloNote)].solo = on;
    else if (note >= kMuteNote && note < kMuteNote + kStripCount)
        strips[(size_t) (note - kMuteNote)].mute = on;
    else if (note >= kSelectNote && note < kSelectNote + kStripCount)
        strips[(size_t) (note - kSelectNote)].selected = on;
}

void MackieSurface::writeLcd (int offset, const juce::uint8* chars, int count)
{
    if (offset < 0 || chars == nullptr || count <= 0)
        return;
    {
        const juce::ScopedLock sl (lock);
        for (int i = 0; i < count; ++i)
        {
            const int pos = offset + i;
            if (pos < 0 || pos >= (int) lcd.size())
                break;
            const auto c = chars[i];
            lcd[(size_t) pos] = (c >= 32 && c < 127) ? (char) c : ' ';
        }
        refreshStripNames();
        hostLinked = true;
        if (status.containsIgnoreCase ("waiting") || status.containsIgnoreCase ("timed out"))
            status = "Mackie Control linked";
        if (scan == Scan::Idle && tracks.isEmpty())
            beginScanLocked();
        else if (scan == Scan::Idle)
        {
            for (int i = 0; i < kStripCount; ++i)
            {
                const int idx = bankOffset + i;
                const auto name = charsToString (strips[(size_t) i].top);
                if (name.isEmpty())
                    continue;
                while (tracks.size() <= idx)
                    tracks.add ({});
                tracks.getReference (idx).name = name;
            }
        }
    }
    sendChangeMessage();
}

void MackieSurface::refreshStripNames()
{
    for (int i = 0; i < kStripCount; ++i)
    {
        for (int c = 0; c < 7; ++c)
        {
            strips[(size_t) i].top[c]    = lcd[(size_t) (i * 7 + c)];
            strips[(size_t) i].bottom[c] = lcd[(size_t) (56 + i * 7 + c)];
        }
        strips[(size_t) i].top[7] = 0;
        strips[(size_t) i].bottom[7] = 0;
    }
}

void MackieSurface::beginScanLocked()
{
    scan = Scan::Homing;
    homeTries = 0;
    bankOffset = 0;
    firstBankSig.clear();
    preHomeSig = currentBankSignature();
    waitTicks = kWaitTicks;
    status = "scanning DAW tracks…";
    sendNoteBang (kBankLeftNote);
}

void MackieSurface::tickScan()
{
    if (scan == Scan::Idle)
        return;
    if (waitTicks > 0)
    {
        --waitTicks;
        return;
    }

    if (scan == Scan::Homing)
    {
        const auto sig = currentBankSignature();
        if (sig == preHomeSig || homeTries >= 24)
        {
            bankOffset = 0;
            tracks.clear();
            firstBankSig.clear();
            scan = Scan::Capture;
        }
        else
        {
            ++homeTries;
            preHomeSig = sig;
            sendNoteBang (kBankLeftNote);
            waitTicks = kWaitTicks;
        }
        return;
    }

    if (scan == Scan::WaitBank)
    {
        scan = Scan::Capture;
        return;
    }

    if (scan == Scan::Capture)
    {
        const auto sig = currentBankSignature();
        if (firstBankSig.isNotEmpty() && sig == firstBankSig)
        {
            scan = Scan::Rewind;
            waitTicks = 0;
        }
        else
        {
            ingestCurrentBank();
            if (firstBankSig.isEmpty())
                firstBankSig = sig;

            bool empty = true;
            for (int i = 0; i < kStripCount; ++i)
                if (charsToString (strips[(size_t) i].top).isNotEmpty() || strips[(size_t) i].midi > 0)
                    empty = false;

            if (empty)
            {
                if (bankOffset == 0)
                {
                    scan = Scan::Idle;
                    status = hostLinked.load()
                        ? "linked — waiting for track names from the DAW"
                        : status;
                }
                else
                    scan = Scan::Rewind;
            }
            else if (bankOffset >= 8 * 32)
                scan = Scan::Rewind;
            else
            {
                sendNoteBang (kBankRightNote);
                bankOffset += 8;
                scan = Scan::WaitBank;
                waitTicks = kWaitTicks;
            }
        }
        return;
    }

    if (scan == Scan::Rewind)
    {
        if (bankOffset <= 0)
        {
            bankOffset = 0;
            scan = Scan::Idle;
            int n = 0;
            for (auto& t : tracks)
                if (t.name.isNotEmpty() || t.midi > 0)
                    ++n;
            status = n > 0
                ? ("mixer: " + juce::String (n) + " tracks")
                : "linked — no track names yet";
            return;
        }
        sendNoteBang (kBankLeftNote);
        bankOffset = juce::jmax (0, bankOffset - 8);
        waitTicks = kWaitTicks;
    }
}

void MackieSurface::ingestCurrentBank()
{
    for (int i = 0; i < kStripCount; ++i)
    {
        const auto name = charsToString (strips[(size_t) i].top);
        const int midi = strips[(size_t) i].midi;
        if (name.isEmpty() && midi <= 0)
            continue;
        const int idx = bankOffset + i;
        while (tracks.size() <= idx)
            tracks.add ({});
        auto& t = tracks.getReference (idx);
        if (name.isNotEmpty())
            t.name = name;
        else if (t.name.isEmpty())
            t.name = "Ch " + juce::String (idx + 1);
        if (midi >= 0)
            t.midi = midi;
    }
}

void MackieSurface::flushPendingFader()
{
    if (pendingMidi < 0 && ! pendingTouch && touchingIndex < 0)
        return;
    if (scan != Scan::Idle)
        return;

    if (pendingIsMaster)
    {
        if (pendingTouch && touchingIndex != -2)
        {
            if (sentTouch && touchingIndex >= 0)
                sendTouch (touchingIndex % kStripCount, false);
            sendTouch (kMasterStrip, true);
            sentTouch = true;
            touchingIndex = -2;
        }
        if (pendingMidi >= 0)
        {
            sendFader (kMasterStrip, pendingMidi);
            masterMidi = pendingMidi;
        }
        if (! pendingTouch && touchingIndex == -2)
        {
            sendTouch (kMasterStrip, false);
            sentTouch = false;
            touchingIndex = -1;
        }
        pendingMidi = pendingTouch ? pendingMidi : -1;
        return;
    }

    if (pendingIndex < 0)
        return;

    const int needed = (pendingIndex / kStripCount) * kStripCount;
    if (bankOffset != needed)
    {
        if (sentTouch)
        {
            sendTouch (touchingIndex >= 0 ? touchingIndex % kStripCount : 0, false);
            sentTouch = false;
            touchingIndex = -1;
        }
        if (bankOffset < needed)
        {
            sendNoteBang (kBankRightNote);
            bankOffset += 8;
        }
        else
        {
            sendNoteBang (kBankLeftNote);
            bankOffset = juce::jmax (0, bankOffset - 8);
        }
        waitTicks = kWaitTicks;
        return;
    }

    const int strip = pendingIndex % kStripCount;
    if (pendingTouch && touchingIndex != pendingIndex)
    {
        if (sentTouch && touchingIndex >= 0)
            sendTouch (touchingIndex % kStripCount, false);
        sendTouch (strip, true);
        sentTouch = true;
        touchingIndex = pendingIndex;
    }
    if (pendingMidi >= 0)
        sendFader (strip, pendingMidi);
    if (! pendingTouch)
    {
        if (sentTouch)
            sendTouch (strip, false);
        sentTouch = false;
        touchingIndex = -1;
        pendingMidi = -1;
        pendingIndex = -1;
    }
}

juce::String MackieSurface::currentBankSignature() const
{
    juce::String s;
    for (int i = 0; i < kStripCount; ++i)
        s << charsToString (strips[(size_t) i].top) << "|";
    return s;
}

#if JUCE_LINUX
bool MackieSurface::isKernelVirMidiName (const juce::String& clientName, const juce::String& portLine)
{
    // Kernel snd-virmidi: "Virtual Raw MIDI 1-0" / port "VirMIDI 1-0"
    // Reaper's own seq client: "Virtual RawMIDI" (no space) — do not use that.
    if (clientName.contains ("Virtual RawMIDI") && ! clientName.contains ("Virtual Raw MIDI"))
        return false;
    return clientName.contains ("Virtual Raw MIDI") || portLine.contains ("VirMIDI");
}

void MackieSurface::ensureKernelVirMidi()
{
    if (triedModprobe)
        return;
    triedModprobe = true;

    const auto text = juce::File ("/proc/asound/seq/clients").loadFileAsString();
    if (text.contains ("VirMIDI") || text.contains ("Virtual Raw MIDI"))
        return;

    juce::ChildProcess proc;
    proc.start (juce::StringArray { "modprobe", "snd-virmidi", "midi_devs=2" });
    proc.waitForProcessToFinish (2000);
}

void MackieSurface::bridgeLinuxDaw()
{
    const auto now = juce::Time::getMillisecondCounter();
    if (now - lastBridgeTryMs < 1500)
        return;
    lastBridgeTryMs = now;

    const auto text = juce::File ("/proc/asound/seq/clients").loadFileAsString();
    if (text.isEmpty())
        return;

    struct SeqPort { int client = -1; int port = -1; };
    SeqPort oursIn, oursOut;
    juce::Array<SeqPort> virMidi;
    int curClient = -1;
    juce::String curName;
    bool ours = false;

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
            ours = curName == "AsaphOps" || curName == "AsaphOps MCU";
            continue;
        }
        if (! line.startsWith ("Port") || curClient < 0)
            continue;

        const int port = line.fromFirstOccurrenceOf ("Port", false, false).getIntValue();
        const bool isIn = line.contains ("[In]");
        const bool isOut = line.contains ("[Out]");
        const bool namedMcu = line.contains ("AsaphOps MCU");

        if (ours && namedMcu)
        {
            if (isIn)
                oursIn = { curClient, port };
            if (isOut)
                oursOut = { curClient, port };
        }
        else if (! ours && isKernelVirMidiName (curName, line))
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

    if (oursIn.client < 0 || oursOut.client < 0 || virMidi.size() < 2)
    {
        if (oursIn.client >= 0 && ! linuxBridged.load())
        {
            const juce::ScopedLock sl (lock);
            if (virMidi.isEmpty())
                status = "need kernel VirMIDI — sudo modprobe snd-virmidi midi_devs=2  then restart companion";
            else
                status = "need two VirMIDI ports (midi_devs=2) so Reaper in/out are not the same cable";
        }
        return;
    }

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

    // Two kernel cables: companion out → VirMIDI 0 (Reaper MIDI in), VirMIDI 1 → companion in (Reaper MIDI out).
    connect (oursOut.client, oursOut.port, virMidi[0].client, virMidi[0].port);
    connect (virMidi[1].client, virMidi[1].port, oursIn.client, oursIn.port);

    if (! linuxBridged.exchange (true))
    {
        {
            const juce::ScopedLock sl (lock);
            status = "bridged to kernel VirMIDI — Reaper Mackie in/out = Virtual Raw MIDI 1-0 / 1-1 (not “virtual”)";
        }
        juce::Logger::writeToLog ("Mackie Control: bridged AsaphOps MCU to kernel VirMIDI");
        sendChangeMessage();
    }
}
#endif
} // namespace AsaphOps
