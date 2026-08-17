#pragma once

#include <juce_events/juce_events.h>
#include <atomic>
#include "../../shared/Protocol.h"

namespace AsaphOps {

class IPCClient : public juce::InterprocessConnection,
                  public juce::Thread,
                  public juce::ChangeBroadcaster
{
public:
    IPCClient();
    ~IPCClient() override;

    void setPluginInfo (juce::String pluginId,
                        juce::String format,
                        juce::String hostType,
                        juce::String hostVersion,
                        juce::String hostPath,
                        juce::String projectPath,
                        juce::String projectName,
                        juce::String trackName = {});

    void setTrackName (const juce::String& name);
    juce::String getTrackName() const;

    void setRequestedRole (const juce::String& role);
    juce::String getRequestedRole() const;
    juce::String getAssignedRole() const;
    bool isMaster() const { return masterAssigned.load (std::memory_order_acquire); }
    bool wasRoleAccepted() const;

    bool isConnectedToCompanion() const;
    juce::String getStatus() const;
    juce::String getProjectId() const;
    juce::String getSessionId() const;
    juce::String getListenUrl() const;
    juce::String getRoleNote() const;

    void sendControlEvent (const juce::String& name, juce::var payload = {});
    void sendStreamConfig (const juce::String& shmName, uint32_t sampleRate, uint32_t channels, uint32_t capacity);
    void sendStreamStart();
    void sendStreamStop();

    void connectionMade() override;
    void connectionLost() override;
    void messageReceived (const juce::MemoryBlock& message) override;
    void run() override;

private:
    void tryConnect();
    void tryLaunchCompanion();
    void sendHello();

    juce::String pluginId, format, hostType, hostVersion, hostPath, projectPath, projectName, trackName;
    juce::String requestedRole { "master" };
    juce::String assignedRole { "master" };
    juce::String status { "disconnected" };
    juce::String projectId, sessionId, connectionId, listenUrl, roleNote;
    bool launchedThisCycle = false;
    bool roleAccepted = true;
    std::atomic<bool> masterAssigned { false };
    mutable juce::CriticalSection lock;
};

} // namespace AsaphOps
