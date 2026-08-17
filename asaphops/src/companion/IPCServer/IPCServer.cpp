#include "IPCServer.h"
#include "../ProjectRegistry/ProjectRegistry.h"
#include "../SessionManager/SessionManager.h"
#include "../Media/MediaEngine.h"

namespace AsaphOps {

class IPCServer::PluginPipe : public juce::InterprocessConnection
{
public:
    PluginPipe (IPCServer& ownerIn)
        : juce::InterprocessConnection (true, 0xf2b49a01),
          owner (ownerIn)
    {
    }

    void connectionMade() override
    {
        juce::Logger::writeToLog ("plugin connection opened");
    }

    void connectionLost() override
    {
        owner.handleDisconnect (*this);
    }

    void messageReceived (const juce::MemoryBlock& message) override
    {
        auto json = messageToJson (message);
        const auto type = jsonString (json, "message");
        if (type == "plugin_hello")
        {
            PluginHello hello;
            if (! parsePluginHello (json, hello))
            {
                sendMessage (jsonToMessage (makeHelloNack ({}, "invalid plugin_hello")));
                return;
            }
            owner.handleHello (*this, hello);
            return;
        }
        if (type == "control_event")
        {
            owner.handleControlEvent (*this, json);
            return;
        }
        juce::Logger::writeToLog ("unhandled ipc message: " + type);
    }

private:
    IPCServer& owner;
};

IPCServer::IPCServer (ProjectRegistry& registryIn, SessionManager& sessionsIn,
                      MediaEngine& mediaIn, juce::String ipcSecret)
    : registry (registryIn),
      sessions (sessionsIn),
      media (mediaIn),
      secret (std::move (ipcSecret))
{
}

IPCServer::~IPCServer()
{
    stop();
}

bool IPCServer::start()
{
    boundPort = kDefaultIpcPort;
    if (! beginWaitingForSocket (boundPort, kIpcBindAddress))
    {
        if (! beginWaitingForSocket (0, kIpcBindAddress))
            return false;
        boundPort = getBoundPort();
    }
    writeIpcPort (boundPort);
    juce::Logger::writeToLog ("ipc listening on " + juce::String (kIpcBindAddress) + ":" + juce::String (boundPort));
    return true;
}

juce::InterprocessConnection* IPCServer::createConnectionObject()
{
    return new PluginPipe (*this);
}

juce::String IPCServer::assignRole (const juce::String& requested, const juce::String& connectionId)
{
    if (requested != "master")
        return "track";
    const auto existing = sessions.getMasterConnectionId();
    if (existing.isNotEmpty() && existing != connectionId)
        return "track";
    return "master";
}

juce::InterprocessConnection* IPCServer::connectionFor (const juce::String& connectionId)
{
    const juce::ScopedLock sl (connectionLock);
    for (auto& pair : connectionIds)
        if (pair.second == connectionId)
            return pair.first;
    return nullptr;
}

void IPCServer::sendTo (const juce::String& connectionId, const juce::var& json)
{
    if (auto* c = connectionFor (connectionId))
        c->sendMessage (jsonToMessage (json));
}

void IPCServer::broadcastCommand (const juce::String& name, juce::var payload)
{
    auto msg = jsonToMessage (makeCommand (name, payload));
    const juce::ScopedLock sl (connectionLock);
    for (auto& pair : connectionIds)
        pair.first->sendMessage (msg);
}

void IPCServer::pushListenUrl (const juce::String& url)
{
    broadcastCommand ("session_started", makeObject ({ { "listenUrl", url } }));
}

void IPCServer::applyHierarchy (const juce::String& projectId, const juce::String& livePluginId)
{
    auto active = sessions.getActiveSessions();
    juce::Array<juce::var> list;
    for (auto& s : active)
    {
        if (s.projectId != projectId || s.role == "master")
            continue;
        const bool live = s.pluginId == livePluginId;
        sessions.updateSession (s.connectionId, [live] (PluginSession& row) { row.unducked = live; });
        list.add (makeObject ({
            { "pluginId", s.pluginId },
            { "trackName", s.trackName },
            { "unducked", live }
        }));
    }
    broadcastCommand ("hierarchy_state", makeObject ({
        { "projectId", projectId },
        { "tracks", juce::var (list) }
    }));
}

void IPCServer::handleHello (juce::InterprocessConnection& connection, const PluginHello& hello)
{
    if (hello.token != secret)
    {
        connection.sendMessage (jsonToMessage (makeHelloNack (hello.requestId, "unauthorized")));
        juce::Logger::writeToLog ("rejected plugin handshake (bad token)");
        return;
    }

    auto daw = registry.ensureDaw (hello.hostType, hello.hostPath, hello.hostVersion);
    auto project = registry.ensureProject (daw, hello.projectPath,
                                           hello.projectName.isNotEmpty() ? hello.projectName : "Untitled");

    PluginSession session;
    session.connectionId = juce::Uuid().toDashedString();
    session.sessionId = juce::Uuid().toDashedString();
    session.projectId = project.id;
    session.projectName = project.projectName;
    session.pluginId = hello.pluginId;
    session.pluginFormat = hello.pluginFormat;
    session.hostType = hello.hostType;
    session.hostPath = hello.hostPath;
    session.hostVersion = hello.hostVersion;
    session.role = assignRole (hello.role, session.connectionId);
    session.trackName = hello.trackName;
    const bool accepted = (hello.role == session.role);
    session = sessions.addSession (session);

    {
        const juce::ScopedLock sl (connectionLock);
        connectionIds[&connection] = session.connectionId;
    }

    connection.sendMessage (jsonToMessage (makeHelloAck (hello.requestId,
                                                         session.connectionId,
                                                         session.projectId,
                                                         session.sessionId,
                                                         session.role,
                                                         accepted,
                                                         media.getListenUrl())));
    juce::Logger::writeToLog ("plugin connected role=" + session.role + " host=" + hello.hostType
                              + " project=" + session.projectName);
}

void IPCServer::handleDisconnect (juce::InterprocessConnection& connection)
{
    juce::String connectionId;
    {
        const juce::ScopedLock sl (connectionLock);
        auto it = connectionIds.find (&connection);
        if (it != connectionIds.end())
        {
            connectionId = it->second;
            connectionIds.erase (it);
        }
    }
    if (connectionId.isEmpty())
        return;

    auto session = sessions.getSession (connectionId);
    if (session.role == "master")
        media.stopMaster (connectionId);
    const auto projectId = session.projectId;
    const bool wasLiveTrack = session.role != "master" && session.unducked;
    sessions.removeSession (connectionId);
    if (wasLiveTrack)
        applyHierarchy (projectId, {});
    juce::Logger::writeToLog ("plugin disconnected");
}

void IPCServer::handleControlEvent (juce::InterprocessConnection& connection, const juce::var& json)
{
    juce::String connectionId;
    {
        const juce::ScopedLock sl (connectionLock);
        auto it = connectionIds.find (&connection);
        if (it != connectionIds.end())
            connectionId = it->second;
    }
    if (connectionId.isEmpty())
        return;

    const auto name = jsonString (json, "name");
    auto payload = jsonChild (json, "payload");
    juce::Logger::writeToLog ("control_event " + name);

    if (name == "SET_ROLE")
    {
        const auto requested = jsonString (payload, "role");
        const auto assigned = assignRole (requested, connectionId);
        sessions.updateSession (connectionId, [assigned] (PluginSession& s) { s.role = assigned; });
        sendTo (connectionId, makeCommand ("role_assigned", makeObject ({
            { "assignedRole", assigned },
            { "roleAccepted", requested == assigned }
        })));
        if (assigned != "master")
            media.stopMaster (connectionId);
        return;
    }

    if (name == "STREAM_CONFIG")
    {
        const auto shmName = jsonString (payload, "shmName");
        const auto sr = (uint32_t) (int) payload.getProperty ("sampleRate", 48000);
        const auto ch = (uint32_t) (int) payload.getProperty ("channels", 2);
        const auto cap = (uint32_t) (int) payload.getProperty ("capacityFrames", 16384);
        sessions.updateSession (connectionId, [&] (PluginSession& s)
        {
            s.shmName = shmName;
            s.sampleRate = (double) sr;
            s.channels = (int) ch;
            s.capacityFrames = (int) cap;
        });
        auto session = sessions.getSession (connectionId);
        if (session.role == "master")
            media.attachMaster (connectionId, shmName, sr, ch, cap);
        return;
    }

    if (name == "STREAM_START")
    {
        auto session = sessions.getSession (connectionId);
        if (session.role == "master")
            media.startMaster (connectionId);
        return;
    }

    if (name == "STREAM_STOP")
    {
        media.stopMaster (connectionId);
        return;
    }

    if (name == "SET_TRACK_NAME")
    {
        const auto trackName = jsonString (payload, "trackName");
        sessions.updateSession (connectionId, [&] (PluginSession& s) { s.trackName = trackName; });
        auto session = sessions.getSession (connectionId);
        if (session.unducked && session.role != "master")
            applyHierarchy (session.projectId, session.pluginId);
        return;
    }

    if (name == "SET_UNDUCKED")
    {
        auto session = sessions.getSession (connectionId);
        const bool live = (bool) payload.getProperty ("unducked", true);
        applyHierarchy (session.projectId, live ? session.pluginId : juce::String());
        return;
    }
}

} // namespace AsaphOps
