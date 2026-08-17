#pragma once

#include <map>
#include <juce_core/juce_core.h>
#include <juce_events/juce_events.h>
#include "../../shared/Protocol.h"

namespace AsaphOps {

class ProjectRegistry;
class SessionManager;
class MediaEngine;

class IPCServer : public juce::InterprocessConnectionServer
{
public:
    IPCServer (ProjectRegistry& registry, SessionManager& sessions, MediaEngine& media, juce::String ipcSecret);
    ~IPCServer() override;

    bool start();
    int getPort() const { return boundPort; }

    juce::InterprocessConnection* createConnectionObject() override;

    void handleHello (juce::InterprocessConnection& connection, const PluginHello& hello);
    void handleDisconnect (juce::InterprocessConnection& connection);
    void handleControlEvent (juce::InterprocessConnection& connection, const juce::var& json);

    void sendTo (const juce::String& connectionId, const juce::var& json);
    void broadcastCommand (const juce::String& name, juce::var payload = {});
    void pushListenUrl (const juce::String& url);

    juce::String getSecret() const { return secret; }

private:
    class PluginPipe;

    juce::String assignRole (const juce::String& requested, const juce::String& connectionId);
    void applyHierarchy (const juce::String& projectId, const juce::String& livePluginId);
    juce::InterprocessConnection* connectionFor (const juce::String& connectionId);

    ProjectRegistry& registry;
    SessionManager& sessions;
    MediaEngine& media;
    juce::String secret;
    int boundPort = kDefaultIpcPort;
    juce::CriticalSection connectionLock;
    std::map<juce::InterprocessConnection*, juce::String> connectionIds;
};

} // namespace AsaphOps
