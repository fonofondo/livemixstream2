#include "AudioProcessor.h"
#include "../UI/PluginEditor.h"
#include <algorithm>

namespace LiveMixStream {

LiveMixStreamAudioProcessor::LiveMixStreamAudioProcessor()
#ifndef JucePlugin_PreferredBusNumInputChannels
     : AudioProcessor (BusesProperties()
                       #if ! JucePlugin_IsSynth
                        .withInput  ("Input",  juce::AudioChannelSet::stereo(), true)
                       #endif
                        .withOutput ("Output", juce::AudioChannelSet::stereo(), true)
                       )
#endif
    , m_audioQueue(32768, 2)
{
    m_networkClient = std::make_unique<NetworkClient>(m_audioQueue, m_sessionManager);
    m_networkClient->setIdentity(m_identity.getInstanceId(), m_trackName, m_groupId);
    m_networkClient->setHierarchyCallback([this](const HierarchyState& state) {
        applyHierarchyState(state);
        if (m_masterHub)
            m_masterHub->broadcastHierarchy(state);
    });

    m_masterHub = std::make_unique<MasterHub>(m_sessionManager);
    m_masterHub->setForwardJson([this](const std::string& json) {
        m_networkClient->enqueueJson(json);
    });
    syncMasterIdentity();

    m_trackClient = std::make_unique<TrackClient>();
    m_trackClient->setIdentity(m_identity.getInstanceId(), m_trackName, m_groupId);
    m_trackClient->updateDuck(m_localDuckGain.load(), m_localFadeMs.load());
    m_trackClient->setHierarchyCallback([this](const HierarchyState& state) {
        applyHierarchyState(state);
    });
    m_trackClient->setNameCallback([this](const std::string& name, bool lock) {
        setTrackName(name, lock ? NameSource::Master : NameSource::Host);
    });

    applyModeConnections();
}

LiveMixStreamAudioProcessor::~LiveMixStreamAudioProcessor()
{
    stopStreamingSession();
    if (m_trackClient)
        m_trackClient->stop();
    if (m_masterHub)
        m_masterHub->stop();
    disconnectPlugin();
}

const juce::String LiveMixStreamAudioProcessor::getName() const
{
    return JucePlugin_Name;
}

bool LiveMixStreamAudioProcessor::acceptsMidi() const { return false; }
bool LiveMixStreamAudioProcessor::producesMidi() const { return false; }
bool LiveMixStreamAudioProcessor::isMidiEffect() const { return false; }
double LiveMixStreamAudioProcessor::getTailLengthSeconds() const { return 0.0; }

int LiveMixStreamAudioProcessor::getNumPrograms() { return 1; }
int LiveMixStreamAudioProcessor::getCurrentProgram() { return 0; }
void LiveMixStreamAudioProcessor::setCurrentProgram (int) {}
const juce::String LiveMixStreamAudioProcessor::getProgramName (int) { return {}; }
void LiveMixStreamAudioProcessor::changeProgramName (int, const juce::String&) {}

void LiveMixStreamAudioProcessor::prepareToPlay (double sampleRate, int)
{
    m_sessionManager.getConfig().sampleRate = sampleRate;
    m_gainRamp.prepare(sampleRate);
    m_audioQueue.reset();
}

void LiveMixStreamAudioProcessor::releaseResources() {}

bool LiveMixStreamAudioProcessor::isBusesLayoutSupported (const BusesLayout& layouts) const
{
    if (layouts.getMainOutputChannelSet() != juce::AudioChannelSet::mono()
     && layouts.getMainOutputChannelSet() != juce::AudioChannelSet::stereo())
        return false;
    return true;
}

void LiveMixStreamAudioProcessor::processBlock (juce::AudioBuffer<float>& buffer, juce::MidiBuffer&)
{
    juce::ScopedNoDenormals noDenormals;
    const int totalNumInputChannels  = getTotalNumInputChannels();
    const int totalNumOutputChannels = getTotalNumOutputChannels();

    for (auto i = totalNumInputChannels; i < totalNumOutputChannels; ++i)
        buffer.clear (i, 0, buffer.getNumSamples());

    if (totalNumInputChannels == 0)
        return;

    float* channels[2] = {
        buffer.getWritePointer(0),
        totalNumInputChannels > 1 ? buffer.getWritePointer(1) : buffer.getWritePointer(0)
    };
    const int numCh = std::min(totalNumInputChannels, 2);
    m_gainRamp.apply(channels, numCh, buffer.getNumSamples());

    if (m_mode.load() == PluginMode::Streaming && m_isStreaming.load())
    {
        const float* const* readPtrs = buffer.getArrayOfReadPointers();
        m_audioQueue.write(readPtrs, numCh, buffer.getNumSamples());
    }
}

bool LiveMixStreamAudioProcessor::hasEditor() const { return true; }

juce::AudioProcessorEditor* LiveMixStreamAudioProcessor::createEditor()
{
    return new LiveMixStreamPluginEditor (*this);
}

void LiveMixStreamAudioProcessor::getStateInformation (juce::MemoryBlock& destData)
{
    juce::ValueTree state("LiveMixStream");
    state.setProperty("mode", (int) m_mode.load(), nullptr);
    state.setProperty("instanceId", juce::String(m_identity.getInstanceId()), nullptr);
    {
        const juce::ScopedLock sl(m_stateLock);
        state.setProperty("trackName", juce::String(m_trackName), nullptr);
        state.setProperty("groupId", juce::String(m_groupId), nullptr);
    }
    state.setProperty("duckGain", m_localDuckGain.load(), nullptr);
    state.setProperty("fadeMs", m_localFadeMs.load(), nullptr);
    state.setProperty("serverUrl", juce::String(m_sessionManager.getServerUrl()), nullptr);
    state.setProperty("quality", juce::String(m_sessionManager.getConfig().quality), nullptr);
    state.setProperty("sessionId", juce::String(m_sessionManager.getSessionId()), nullptr);
    state.setProperty("requestedSessionId", juce::String(m_sessionManager.getRequestedSessionId()), nullptr);
    state.setProperty("sessionTitle", juce::String(m_sessionManager.getConfig().title), nullptr);
    state.setProperty("listenerUrl", juce::String(m_sessionManager.getListenerUrl()), nullptr);
    state.setProperty("nameLocked", m_nameLocked.load(), nullptr);

    juce::MemoryOutputStream stream(destData, false);
    state.writeToStream(stream);
}

void LiveMixStreamAudioProcessor::setStateInformation (const void* data, int sizeInBytes)
{
    auto state = juce::ValueTree::readFromData(data, (size_t) sizeInBytes);
    if (!state.isValid()) return;

    if (state.hasProperty("instanceId"))
        m_identity.setInstanceId(state.getProperty("instanceId").toString().toStdString());

    setMode((PluginMode)(int) state.getProperty("mode", (int) PluginMode::TrackControl));

    const bool locked = state.hasProperty("nameLocked") && (bool) state.getProperty("nameLocked");
    m_nameLocked.store(false);
    if (state.hasProperty("trackName"))
        setTrackName(state.getProperty("trackName").toString().toStdString(),
                     locked ? NameSource::User : NameSource::Host);
    if (state.hasProperty("groupId"))
        setGroupId(state.getProperty("groupId").toString().toStdString());
    if (state.hasProperty("duckGain"))
        setLocalDuckGain((float) state.getProperty("duckGain"));
    if (state.hasProperty("fadeMs"))
        setLocalFadeMs((int) state.getProperty("fadeMs"));
    if (state.hasProperty("serverUrl"))
        m_sessionManager.saveServerUrlConfig(state.getProperty("serverUrl").toString().toStdString());
    if (state.hasProperty("quality"))
        m_sessionManager.getConfig().quality = state.getProperty("quality").toString().toStdString();
    if (state.hasProperty("requestedSessionId"))
        m_sessionManager.setRequestedSessionId(state.getProperty("requestedSessionId").toString().toStdString());
    else if (state.hasProperty("sessionId"))
        m_sessionManager.setRequestedSessionId(state.getProperty("sessionId").toString().toStdString());
    if (state.hasProperty("listenerUrl"))
        m_sessionManager.setSessionInfo(m_sessionManager.getSessionId(),
                                        m_sessionManager.getAuthToken(),
                                        state.getProperty("listenerUrl").toString().toStdString());
    m_sessionManager.ensurePersistentSessionId();

    m_networkClient->setIdentity(m_identity.getInstanceId(), getTrackName(), getGroupId());
    m_trackClient->setIdentity(m_identity.getInstanceId(), getTrackName(), getGroupId());
    syncMasterIdentity();
    applyModeConnections();
}

void LiveMixStreamAudioProcessor::updateTrackProperties (const TrackProperties& properties)
{
    if (properties.name.has_value() && properties.name->isNotEmpty())
        setTrackName (properties.name->toStdString(), NameSource::Host);
}

void LiveMixStreamAudioProcessor::setMode (PluginMode mode)
{
    const auto prev = m_mode.load();
    if (mode == prev)
        return;

    m_mode.store (mode);
    m_networkClient->setPluginMode (mode);
    if (mode == PluginMode::TrackControl && m_isStreaming.load())
        stopStreamingSession();
    applyModeConnections();
}

bool LiveMixStreamAudioProcessor::canOfferMasterMode() const
{
    if (m_mode.load() == PluginMode::Streaming)
        return true;
    return ! masterHubReachable();
}

void LiveMixStreamAudioProcessor::applyHierarchyState (const HierarchyState& state)
{
    {
        const juce::ScopedLock sl(m_stateLock);
        m_hierarchyState = state;
    }

    if (m_mode.load() == PluginMode::Streaming)
    {
        m_role.store(HierarchyRole::Idle);
        return;
    }

    m_unducked.store(state.unducked);
    m_role.store(state.unducked ? HierarchyRole::Unducked : HierarchyRole::Ducked);

    const float target = state.unducked ? 1.0f : m_localDuckGain.load();
    m_gainRamp.setTarget(target, m_localFadeMs.load());
}

void LiveMixStreamAudioProcessor::updateRoleFromState()
{
    HierarchyState state;
    {
        const juce::ScopedLock sl(m_stateLock);
        state = m_hierarchyState;
    }

    if (m_mode.load() == PluginMode::Streaming)
        m_role.store(HierarchyRole::Idle);
    else
        m_role.store(state.unducked ? HierarchyRole::Unducked : HierarchyRole::Ducked);
}

std::string LiveMixStreamAudioProcessor::getTrackName() const
{
    if (m_mode.load() == PluginMode::Streaming)
        return "master";
    const juce::ScopedLock sl(m_stateLock);
    return m_trackName;
}

void LiveMixStreamAudioProcessor::setTrackName (const std::string& name, NameSource source)
{
    if (source == NameSource::Host && m_nameLocked.load())
        return;

    {
        const juce::ScopedLock sl(m_stateLock);
        m_trackName = name.empty() ? "Track" : name;
    }

    if (source == NameSource::User || source == NameSource::Master)
        m_nameLocked.store(true);

    const auto trackName = getTrackName();
    const auto groupId = getGroupId();
    m_networkClient->updateTrackMeta(trackName, groupId);
    m_trackClient->updateMeta(trackName, groupId);
    syncMasterIdentity();
}

std::string LiveMixStreamAudioProcessor::getGroupId() const
{
    const juce::ScopedLock sl(m_stateLock);
    return m_groupId;
}

void LiveMixStreamAudioProcessor::setGroupId (const std::string& groupId)
{
    {
        const juce::ScopedLock sl(m_stateLock);
        m_groupId = groupId.empty() ? "default" : groupId;
    }
    const auto trackName = getTrackName();
    const auto gid = getGroupId();
    m_networkClient->updateTrackMeta(trackName, gid);
    m_trackClient->updateMeta(trackName, gid);
    syncMasterIdentity();
}

void LiveMixStreamAudioProcessor::setLocalDuckGain (float g)
{
    m_localDuckGain.store(std::clamp(g, 0.0f, 1.0f));
    m_trackClient->updateDuck(m_localDuckGain.load(), m_localFadeMs.load());
    if (m_mode.load() == PluginMode::TrackControl && !m_unducked.load())
        m_gainRamp.setTarget(m_localDuckGain.load(), m_localFadeMs.load());
}

void LiveMixStreamAudioProcessor::setLocalFadeMs (int ms)
{
    m_localFadeMs.store(std::clamp(ms, 50, 1000));
    m_trackClient->updateDuck(m_localDuckGain.load(), m_localFadeMs.load());
    if (m_mode.load() == PluginMode::TrackControl && !m_unducked.load())
        m_gainRamp.setTarget(m_localDuckGain.load(), m_localFadeMs.load());
}

void LiveMixStreamAudioProcessor::toggleDuck()
{
    if (m_mode.load() != PluginMode::TrackControl)
        return;

    const bool next = ! m_unducked.load();
    HierarchyState local;
    {
        const juce::ScopedLock sl(m_stateLock);
        local = m_hierarchyState;
    }
    local.unducked = next;
    applyHierarchyState(local);

    if (m_trackClient)
        m_trackClient->requestSetUnducked(next);
}

void LiveMixStreamAudioProcessor::toggleTrackDuck (const std::string& instanceId)
{
    if (m_mode.load() != PluginMode::Streaming || instanceId.empty() || ! m_masterHub)
        return;
    m_masterHub->toggleUnducked (instanceId);
}

void LiveMixStreamAudioProcessor::syncMasterIdentity()
{
    if (m_masterHub)
        m_masterHub->setMasterIdentity(m_identity.getInstanceId(), getTrackName(), getGroupId());
}

void LiveMixStreamAudioProcessor::applyModeConnections()
{
    if (m_mode.load() == PluginMode::Streaming)
    {
        m_trackClient->stop();
        syncMasterIdentity();
        if (! m_masterHub->start())
        {
            m_mode.store (PluginMode::TrackControl);
            m_networkClient->setPluginMode (PluginMode::TrackControl);
            m_trackClient->setIdentity (m_identity.getInstanceId(), getTrackName(), getGroupId());
            m_trackClient->start();
            return;
        }
        connectPlugin();
    }
    else
    {
        stopStreamingSession();
        m_masterHub->stop();
        disconnectPlugin();
        m_trackClient->setIdentity(m_identity.getInstanceId(), getTrackName(), getGroupId());
        m_trackClient->start();
    }
}

std::vector<ListedTrack> LiveMixStreamAudioProcessor::getListedTracks() const
{
    std::vector<ListedTrack> tracks;
    if (m_masterHub)
    {
        for (const auto& child : m_masterHub->getChildTracks())
            tracks.push_back({ child.instanceId, child.trackName, false,
                               m_masterHub->isUnducked (child.instanceId) });
    }
    return tracks;
}

bool LiveMixStreamAudioProcessor::isLinkedToMaster() const
{
    return m_trackClient && m_trackClient->isLinked();
}

bool LiveMixStreamAudioProcessor::isMasterHubListening() const
{
    return m_masterHub && m_masterHub->isListening();
}

void LiveMixStreamAudioProcessor::connectPlugin()
{
    m_networkClient->setIdentity(m_identity.getInstanceId(), getTrackName(), getGroupId());
    m_networkClient->setPluginMode(PluginMode::Streaming);
    m_networkClient->start(m_sessionManager.getServerUrl());
}

void LiveMixStreamAudioProcessor::disconnectPlugin()
{
    m_networkClient->stop();
}

void LiveMixStreamAudioProcessor::startStreamingSession()
{
    if (m_mode.load() != PluginMode::Streaming)
        setMode(PluginMode::Streaming);

    if (!m_networkClient->isConnected())
        connectPlugin();

    m_audioQueue.reset();
    m_networkClient->startStreaming();
    m_isStreaming = true;
}

void LiveMixStreamAudioProcessor::stopStreamingSession()
{
    if (!m_isStreaming.load()) return;
    m_isStreaming = false;
    m_networkClient->stopStreaming();
}

} // namespace LiveMixStream

juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter()
{
    return new LiveMixStream::LiveMixStreamAudioProcessor();
}
