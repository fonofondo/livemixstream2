#pragma once

#include <juce_audio_processors/juce_audio_processors.h>
#include "IPCClient/IPCClient.h"
#include "../shared/SharedMemoryFifo.h"

namespace AsaphOps {

class PluginEditor;

class PluginProcessor : public juce::AudioProcessor,
                        private juce::ChangeListener
{
public:
    PluginProcessor();
    ~PluginProcessor() override;

    void prepareToPlay (double sampleRate, int samplesPerBlock) override;
    void releaseResources() override;
    bool isBusesLayoutSupported (const BusesLayout& layouts) const override;
    void processBlock (juce::AudioBuffer<float>&, juce::MidiBuffer&) override;
    using juce::AudioProcessor::processBlock;

    juce::AudioProcessorEditor* createEditor() override;
    bool hasEditor() const override { return true; }

    const juce::String getName() const override { return "AsaphOps"; }
    bool acceptsMidi() const override { return false; }
    bool producesMidi() const override { return false; }
    bool isMidiEffect() const override { return false; }
    double getTailLengthSeconds() const override { return 0.0; }

    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram (int) override {}
    const juce::String getProgramName (int) override { return {}; }
    void changeProgramName (int, const juce::String&) override {}

    void getStateInformation (juce::MemoryBlock& destData) override;
    void setStateInformation (const void* data, int sizeInBytes) override;

    IPCClient& getClient() { return client; }

    void updateTrackProperties (const TrackProperties& properties) override;

private:
    void refreshHostInfo();
    void changeListenerCallback (juce::ChangeBroadcaster*) override;
    void setupMasterRing();
    void teardownMasterRing();

    juce::String instanceId { juce::Uuid().toDashedString() };
    IPCClient client;
    SharedMemoryFifo shm;
    std::atomic<bool> prepared { false };
    std::atomic<double> currentSampleRate { 48000.0 };
    int currentBlockSize = 512;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (PluginProcessor)
};

} // namespace AsaphOps
