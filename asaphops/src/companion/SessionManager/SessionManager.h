#pragma once

#include <juce_core/juce_core.h>
#include <juce_events/juce_events.h>
#include <functional>

namespace AsaphOps {

struct PluginSession
{
    juce::String connectionId;
    juce::String sessionId;
    juce::String projectId;
    juce::String projectName;
    juce::String pluginId;
    juce::String pluginFormat;
    juce::String hostType;
    juce::String hostPath;
    juce::String hostVersion;
    juce::String role { "track" };
    juce::String trackName;
    juce::String shmName;
    juce::String listenUrl;
    bool active = true;
    bool streaming = false;
    bool receivingAudio = false;
    bool unducked = true;
    double sampleRate = 0.0;
    int channels = 2;
    int capacityFrames = 0;
};

class SessionManager : public juce::ChangeBroadcaster
{
public:
    PluginSession addSession (const PluginSession& session);
    void removeSession (const juce::String& connectionId);
    bool updateSession (const juce::String& connectionId, const std::function<void (PluginSession&)>& fn);

    juce::Array<PluginSession> getSessions() const;
    juce::Array<PluginSession> getActiveSessions() const;
    PluginSession getSession (const juce::String& connectionId) const;
    juce::String getMasterConnectionId() const;
    bool hasActiveMaster() const;

private:
    juce::Array<PluginSession> sessions;
    mutable juce::CriticalSection lock;
};

} // namespace AsaphOps
