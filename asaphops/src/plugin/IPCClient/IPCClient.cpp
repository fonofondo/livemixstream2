#include "IPCClient.h"

namespace AsaphOps {

IPCClient::IPCClient()
    : juce::InterprocessConnection (true, 0xf2b49a01),
      juce::Thread ("AsaphOpsIPC")
{
}

IPCClient::~IPCClient()
{
    signalThreadShouldExit();
    disconnect();
    stopThread (2000);
}

void IPCClient::setPluginInfo (juce::String pluginIdIn,
                               juce::String formatIn,
                               juce::String hostTypeIn,
                               juce::String hostVersionIn,
                               juce::String hostPathIn,
                               juce::String projectPathIn,
                               juce::String projectNameIn,
                               juce::String trackNameIn)
{
    const juce::ScopedLock sl (lock);
    pluginId = std::move (pluginIdIn);
    format = std::move (formatIn);
    hostType = std::move (hostTypeIn);
    hostVersion = std::move (hostVersionIn);
    hostPath = std::move (hostPathIn);
    projectPath = std::move (projectPathIn);
    projectName = std::move (projectNameIn);
    if (trackNameIn.isNotEmpty())
        trackName = std::move (trackNameIn);
}

void IPCClient::setRequestedRole (const juce::String& role)
{
    {
        const juce::ScopedLock sl (lock);
        requestedRole = (role == "master") ? "master" : "track";
    }
    if (isConnected())
        sendControlEvent ("SET_ROLE", makeObject ({ { "role", requestedRole } }));
    sendChangeMessage();
}

juce::String IPCClient::getRequestedRole() const
{
    const juce::ScopedLock sl (lock);
    return requestedRole;
}

juce::String IPCClient::getAssignedRole() const
{
    const juce::ScopedLock sl (lock);
    return assignedRole;
}

bool IPCClient::wasRoleAccepted() const
{
    const juce::ScopedLock sl (lock);
    return roleAccepted;
}

bool IPCClient::isConnectedToCompanion() const
{
    return isConnected() && getProjectId().isNotEmpty();
}

juce::String IPCClient::getStatus() const
{
    const juce::ScopedLock sl (lock);
    return status;
}

juce::String IPCClient::getProjectId() const
{
    const juce::ScopedLock sl (lock);
    return projectId;
}

juce::String IPCClient::getSessionId() const
{
    const juce::ScopedLock sl (lock);
    return sessionId;
}

juce::String IPCClient::getListenUrl() const
{
    const juce::ScopedLock sl (lock);
    return listenUrl;
}

juce::String IPCClient::getRoleNote() const
{
    const juce::ScopedLock sl (lock);
    return roleNote;
}

void IPCClient::setTrackName (const juce::String& name)
{
    {
        const juce::ScopedLock sl (lock);
        if (trackName == name)
            return;
        trackName = name;
    }
    if (isConnected())
        sendControlEvent ("SET_TRACK_NAME", makeObject ({ { "trackName", name } }));
    sendChangeMessage();
}

juce::String IPCClient::getTrackName() const
{
    const juce::ScopedLock sl (lock);
    return trackName;
}

void IPCClient::sendControlEvent (const juce::String& name, juce::var payload)
{
    if (! isConnected())
        return;
    sendMessage (jsonToMessage (makeControlEvent (name, payload)));
}

void IPCClient::sendStreamConfig (const juce::String& shmName, uint32_t sampleRate,
                                  uint32_t channels, uint32_t capacity)
{
    sendControlEvent ("STREAM_CONFIG", makeObject ({
        { "shmName", shmName },
        { "sampleRate", (int) sampleRate },
        { "channels", (int) channels },
        { "capacityFrames", (int) capacity }
    }));
}

void IPCClient::sendStreamStart()
{
    sendControlEvent ("STREAM_START");
}

void IPCClient::sendStreamStop()
{
    sendControlEvent ("STREAM_STOP");
}

void IPCClient::connectionMade()
{
    {
        const juce::ScopedLock sl (lock);
        status = "handshaking";
    }
    sendHello();
    sendChangeMessage();
}

void IPCClient::connectionLost()
{
    {
        const juce::ScopedLock sl (lock);
        status = "disconnected";
        projectId.clear();
        sessionId.clear();
        connectionId.clear();
        listenUrl.clear();
        masterAssigned.store (false, std::memory_order_release);
    }
    sendChangeMessage();
}

void IPCClient::messageReceived (const juce::MemoryBlock& message)
{
    auto json = messageToJson (message);
    const auto type = jsonString (json, "message");
    if (type == "hello_ack")
    {
        {
            const juce::ScopedLock sl (lock);
            connectionId = jsonString (json, "connectionId");
            projectId = jsonString (json, "projectId");
            sessionId = jsonString (json, "sessionId");
            assignedRole = jsonString (json, "assignedRole");
            if (assignedRole.isEmpty())
                assignedRole = requestedRole;
            roleAccepted = (bool) json.getProperty ("roleAccepted", true);
            listenUrl = jsonString (json, "listenUrl");
            status = "connected";
            masterAssigned.store (assignedRole == "master", std::memory_order_release);
            if (! roleAccepted)
                roleNote = "Master already present — this instance is Track.";
            else
                roleNote.clear();
        }
        sendChangeMessage();
        return;
    }
    if (type == "hello_nack")
    {
        {
            const juce::ScopedLock sl (lock);
            status = "rejected: " + jsonString (json, "error");
        }
        sendChangeMessage();
        return;
    }
    if (type == "command")
    {
        const auto name = jsonString (json, "name");
        auto payload = jsonChild (json, "payload");
        if (name == "session_started")
        {
            const juce::ScopedLock sl (lock);
            listenUrl = jsonString (payload, "listenUrl");
        }
        else if (name == "session_stopped")
        {
            const juce::ScopedLock sl (lock);
            listenUrl.clear();
        }
        else if (name == "role_assigned")
        {
            const juce::ScopedLock sl (lock);
            assignedRole = jsonString (payload, "assignedRole");
            roleAccepted = (bool) payload.getProperty ("roleAccepted", true);
            masterAssigned.store (assignedRole == "master", std::memory_order_release);
            if (! roleAccepted)
                roleNote = "Master already present — this instance is Track.";
            else
                roleNote.clear();
        }
        sendChangeMessage();
    }
}

void IPCClient::sendHello()
{
    PluginHello hello;
    {
        const juce::ScopedLock sl (lock);
        hello.pluginId = pluginId;
        hello.pluginVersion = kAppVersion;
        hello.pluginFormat = format;
        hello.hostType = hostType;
        hello.hostVersion = hostVersion;
        hello.hostPath = hostPath;
        hello.projectPath = projectPath;
        hello.projectName = projectName;
        hello.trackName = trackName;
        hello.role = "master";
    }
    hello.requestId = juce::Uuid().toDashedString();
    hello.token = loadIpcSecret();
    if (hello.token.isEmpty())
    {
        const juce::ScopedLock sl (lock);
        status = "waiting for companion secret";
        return;
    }
    sendMessage (jsonToMessage (makePluginHello (hello)));
}

void IPCClient::tryLaunchCompanion()
{
    juce::File exe;
    const auto env = juce::SystemStats::getEnvironmentVariable ("ASAPHOPS_COMPANION", {});
    if (env.isNotEmpty())
        exe = juce::File (env);

    if (! exe.existsAsFile() && companionPathFile().existsAsFile())
        exe = juce::File (companionPathFile().loadFileAsString().trim());

    if (! exe.existsAsFile())
    {
        auto dir = juce::File::getSpecialLocation (juce::File::currentExecutableFile).getParentDirectory();
        const juce::StringArray names {
           #if JUCE_WINDOWS
            "AsaphOps.exe",
           #elif JUCE_MAC
            "AsaphOps.app",
           #else
            "AsaphOps",
           #endif
            "AsaphOpsCompanion"
        };
        for (int i = 0; i < 6 && ! exe.existsAsFile(); ++i)
        {
            for (auto& name : names)
            {
                auto candidate = dir.getChildFile (name);
                if (candidate.exists())
                {
                    exe = candidate;
                    break;
                }
            }
            dir = dir.getParentDirectory();
        }
    }

    if (exe.existsAsFile() || exe.isDirectory())
    {
        exe.startAsProcess ("--background");
        const juce::ScopedLock sl (lock);
        status = "launching companion";
    }
    else
    {
        const juce::ScopedLock sl (lock);
        status = "companion not found";
    }
}

void IPCClient::tryConnect()
{
    if (isConnected())
        return;
    const int port = loadIpcPort();
    if (! connectToSocket (kIpcBindAddress, port, 400))
    {
        if (! launchedThisCycle)
        {
            tryLaunchCompanion();
            launchedThisCycle = true;
        }
        const juce::ScopedLock sl (lock);
        if (status != "launching companion" && status != "companion not found")
            status = "connecting";
    }
}

void IPCClient::run()
{
    while (! threadShouldExit())
    {
        if (! isConnected())
            tryConnect();
        else
            launchedThisCycle = false;
        wait (800);
    }
}

} // namespace AsaphOps
