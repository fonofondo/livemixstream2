#pragma once

#include <array>
#include <atomic>
#include <juce_audio_devices/juce_audio_devices.h>
#include <juce_events/juce_events.h>

namespace AsaphOps {

class MackieSurface : public juce::MidiInputCallback,
                      public juce::Timer,
                      public juce::ChangeBroadcaster
{
public:
    static constexpr int kStripCount = 8;
    static constexpr const char* kPortName = "AsaphOps MCU";

    struct MixerTrack
    {
        juce::String name;
        float db = -144.0f;
        bool known = false;
        bool isMaster = false;
        int index = 0;
    };

    MackieSurface();
    ~MackieSurface() override;

    bool start();
    void stop();

    juce::Array<MixerTrack> getTracks() const;
    void setTrackDb (int index, float db, bool touching);
    void setMasterDb (float db, bool touching);
    void requestScan();

    juce::String getStatus() const;
    juce::String getPortName() const { return kPortName; }
    juce::String getSetupHint() const;
    bool isHostLinked() const { return hostLinked.load (std::memory_order_acquire); }
    bool arePortsOpen() const { return portsOpen.load (std::memory_order_acquire); }

    void handleIncomingMidiMessage (juce::MidiInput* source, const juce::MidiMessage& message) override;
    void timerCallback() override;

    static float midiToDb (int midi);
    static int dbToMidi (float db);

private:
    struct Strip
    {
        char top[8] {};
        char bottom[8] {};
        int midi = -1;
        bool rec = false, solo = false, mute = false, selected = false;
    };

    struct Track
    {
        juce::String name;
        int midi = -1;
    };

    enum class Scan { Idle, Homing, Capture, WaitBank, Rewind };

    void send (const juce::MidiMessage& message);
    void sendSysex (juce::uint8 cmd, const juce::uint8* data, int len);
    void sendHostConnectionQuery();
    void sendHostConnectionConfirm();
    void sendVersionReply();
    void sendFader (int strip, int midi14);
    void sendTouch (int strip, bool down);
    void sendNoteBang (int note);
    void handleSysex (const juce::MidiMessage& message);
    void handlePitchBend (const juce::MidiMessage& message);
    void handleNote (const juce::MidiMessage& message);
    void writeLcd (int offset, const juce::uint8* chars, int count);
    void refreshStripNames();
    void beginScanLocked();
    void tickScan();
    void ingestCurrentBank();
    void flushPendingFader();
    juce::String currentBankSignature() const;
    static juce::String charsToString (const char* chars);
   #if JUCE_LINUX
    void ensureKernelVirMidi();
    void bridgeLinuxDaw();
    static bool isKernelVirMidiName (const juce::String& clientName, const juce::String& portLine);
   #endif

    static constexpr int kMasterStrip = 8;
    static constexpr juce::uint8 kSerial[7] = { 'A', 'S', 'A', 'P', 'H', '0', '1' };

    std::unique_ptr<juce::MidiInput> midiIn;
    std::unique_ptr<juce::MidiOutput> midiOut;
    juce::uint8 deviceId { 0x14 };
    juce::uint8 challenge[4] {};
    std::array<char, 112> lcd {};
    std::array<Strip, kStripCount> strips;
    juce::Array<Track> tracks;
    int masterMidi = -1;
    int bankOffset = 0;
    int homeTries = 0;
    int waitTicks = 0;
    int touchingIndex = -1;
    int pendingIndex = -1;
    int pendingMidi = -1;
    bool pendingTouch = false;
    bool pendingIsMaster = false;
    bool sentTouch = false;
    Scan scan { Scan::Idle };
    juce::String firstBankSig;
    juce::String preHomeSig;
    juce::String status { "stopped" };
    std::atomic<bool> portsOpen { false };
    std::atomic<bool> hostLinked { false };
    std::atomic<bool> linuxBridged { false };
    std::atomic<bool> kernelVirMidiSeen { false };
    bool triedModprobe { false };
    juce::uint32 lastBridgeTryMs { 0 };
    mutable juce::CriticalSection lock;
    std::atomic<juce::uint32> lastHostMessageMs { 0 };

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (MackieSurface)
};

} // namespace AsaphOps
