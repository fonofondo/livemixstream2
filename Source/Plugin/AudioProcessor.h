#pragma once

#include <juce_audio_processors/juce_audio_processors.h>
#include <vector>
#include "../Audio/AudioBufferQueue.h"
#include "../Session/SessionManager.h"
#include "../Network/NetworkClient.h"
#include "../Hierarchy/HierarchyTypes.h"
#include "../Hierarchy/GainRamp.h"
#include "../Local/MasterHub.h"
#include "../Local/TrackClient.h"
#include "PluginIdentity.h"

namespace LiveMixStream {

struct ListedTrack
{
    std::string instanceId;
    std::string trackName;
    bool isMaster = false;
    bool unducked = true;
};

class LiveMixStreamAudioProcessor  : public juce::AudioProcessor
{
public:
    enum class NameSource { Host, User, Master };

    LiveMixStreamAudioProcessor();
    ~LiveMixStreamAudioProcessor() override;

    void prepareToPlay (double sampleRate, int samplesPerBlock) override;
    void releaseResources() override;

    bool isBusesLayoutSupported (const BusesLayout& layouts) const override;

    void processBlock (juce::AudioBuffer<float>&, juce::MidiBuffer&) override;

    juce::AudioProcessorEditor* createEditor() override;
    bool hasEditor() const override;

    const juce::String getName() const override;

    bool acceptsMidi() const override;
    bool producesMidi() const override;
    bool isMidiEffect() const override;
    double getTailLengthSeconds() const override;

    int getNumPrograms() override;
    int getCurrentProgram() override;
    void setCurrentProgram (int index) override;
    const juce::String getProgramName (int index) override;
    void changeProgramName (int index, const juce::String& newName) override;

    void getStateInformation (juce::MemoryBlock& destData) override;
    void setStateInformation (const void* data, int sizeInBytes) override;
    void updateTrackProperties (const TrackProperties& properties) override;

    SessionManager& getSessionManager() { return m_sessionManager; }
    NetworkClient& getNetworkClient() { return *m_networkClient; }
    PluginIdentity& getIdentity() { return m_identity; }
    GainRamp& getGainRamp() { return m_gainRamp; }

    bool isStreaming() const { return m_isStreaming.load(); }
    PluginMode getMode() const { return m_mode.load(); }
    void setMode (PluginMode mode);
    bool canOfferMasterMode() const;

    HierarchyRole getHierarchyRole() const { return m_role.load(); }
    void applyHierarchyState (const HierarchyState& state);

    std::string getTrackName() const;
    void setTrackName (const std::string& name, NameSource source = NameSource::User);

    std::string getGroupId() const;
    void setGroupId (const std::string& groupId);

    float getLocalDuckGain() const { return m_localDuckGain.load(); }
    void setLocalDuckGain (float g);

    int getLocalFadeMs() const { return m_localFadeMs.load(); }
    void setLocalFadeMs (int ms);

    bool isUnducked() const { return m_unducked.load(); }
    void toggleDuck();
    void toggleTrackDuck (const std::string& instanceId);

    std::vector<ListedTrack> getListedTracks() const;
    bool isLinkedToMaster() const;
    bool isMasterHubListening() const;

    void connectPlugin();
    void disconnectPlugin();
    void startStreamingSession();
    void stopStreamingSession();

private:
    void updateRoleFromState();
    void applyModeConnections();
    void syncMasterIdentity();

    LockFreeAudioQueue m_audioQueue;
    SessionManager m_sessionManager;
    std::unique_ptr<NetworkClient> m_networkClient;
    std::unique_ptr<MasterHub> m_masterHub;
    std::unique_ptr<TrackClient> m_trackClient;
    PluginIdentity m_identity;
    GainRamp m_gainRamp;

    std::atomic<bool> m_isStreaming { false };
    std::atomic<PluginMode> m_mode { PluginMode::TrackControl };
    std::atomic<HierarchyRole> m_role { HierarchyRole::Idle };
    std::atomic<float> m_localDuckGain { 0.30f };
    std::atomic<int> m_localFadeMs { 200 };
    std::atomic<bool> m_nameLocked { false };
    std::atomic<bool> m_unducked { true };

    mutable juce::CriticalSection m_stateLock;
    std::string m_trackName { "Track" };
    std::string m_groupId { "default" };
    HierarchyState m_hierarchyState;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (LiveMixStreamAudioProcessor)
};

} // namespace LiveMixStream
