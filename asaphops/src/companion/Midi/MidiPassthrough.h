#pragma once

#include <array>
#include <atomic>
#include <functional>
#include <juce_audio_devices/juce_audio_devices.h>
#include <juce_events/juce_events.h>

namespace AsaphOps {

/** Virtual MIDI ports plus Linux VirMIDI bridging. No Mackie protocol. */
class MidiPassthrough : public juce::MidiInputCallback,
                        public juce::Timer,
                        public juce::ChangeBroadcaster
{
public:
    static constexpr int kSurfaceCount = 4;
    static constexpr const char* kPortNames[kSurfaceCount] = {
        "AsaphOps MCU",
        "AsaphOps XT1",
        "AsaphOps XT2",
        "AsaphOps XT3"
    };

    MidiPassthrough();
    ~MidiPassthrough() override;

    bool start();
    void stop();

    void sendRaw (int surface, const juce::uint8* data, int size);
    void sendHex (int surface, const juce::String& hex);

    void setIncomingMidiHandler (std::function<void (int, juce::MidiMessage)> handler);

    juce::String getStatus() const;
    juce::String getSetupHint() const;
    juce::String portSnapshotJson() const;
    juce::String getPortName() const;
    bool arePortsOpen() const { return portsOpen.load (std::memory_order_acquire); }

    void handleIncomingMidiMessage (juce::MidiInput* source, const juce::MidiMessage& message) override;
    void timerCallback() override;

private:
    struct EchoSample
    {
        juce::MemoryBlock bytes;
        juce::uint32 atMs = 0;
    };

    struct SurfacePort
    {
        juce::String name;
        std::unique_ptr<juce::MidiInput> midiIn;
        std::unique_ptr<juce::MidiOutput> midiOut;
        std::array<EchoSample, 48> recentOut {};
        int recentOutIndex = 0;
        std::atomic<bool> loggedFirstIncoming { false };
    };

    void rememberOutgoing (int surface, const juce::uint8* data, int size);
    bool isLocalEcho (int surface, const juce::MidiMessage& message) const;
    int surfaceForInput (juce::MidiInput* source) const;

   #if JUCE_LINUX
    void ensureKernelVirMidi();
    void bridgeLinuxDaw();
    static bool isKernelVirMidiName (const juce::String& clientName, const juce::String& portLine);
   #endif

    std::array<SurfacePort, kSurfaceCount> surfaces;
    std::function<void (int, juce::MidiMessage)> incoming;
    juce::String status { "stopped" };
    std::atomic<bool> portsOpen { false };
    std::atomic<bool> linuxBridged { false };
    std::atomic<bool> kernelVirMidiSeen { false };
    bool triedModprobe { false };
    juce::uint32 lastBridgeTryMs { 0 };
    mutable juce::CriticalSection lock;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (MidiPassthrough)
};

} // namespace AsaphOps
