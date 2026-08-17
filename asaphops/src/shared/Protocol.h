#pragma once

#include <juce_core/juce_core.h>
#include "Paths.h"

namespace AsaphOps {

inline juce::MemoryBlock jsonToMessage (const juce::var& value)
{
    const auto text = juce::JSON::toString (value, false);
    return juce::MemoryBlock (text.toRawUTF8(), (size_t) text.getNumBytesAsUTF8());
}

inline juce::var messageToJson (const juce::MemoryBlock& block)
{
    auto text = juce::String::fromUTF8 (static_cast<const char*> (block.getData()),
                                        (int) block.getSize());
    return juce::JSON::parse (text);
}

inline juce::var makeObject (std::initializer_list<std::pair<const char*, juce::var>> fields)
{
    auto* obj = new juce::DynamicObject();
    for (auto& field : fields)
        obj->setProperty (field.first, field.second);
    return juce::var (obj);
}

inline juce::var nestedObject (std::initializer_list<std::pair<const char*, juce::var>> fields)
{
    return makeObject (fields);
}

inline juce::String jsonString (const juce::var& obj, const juce::Identifier& key)
{
    if (auto* o = obj.getDynamicObject())
        return o->getProperty (key).toString();
    return {};
}

inline juce::var jsonChild (const juce::var& obj, const juce::Identifier& key)
{
    if (auto* o = obj.getDynamicObject())
        return o->getProperty (key);
    return {};
}

inline juce::var makeEnvelope (const juce::String& messageType,
                               const juce::String& requestId,
                               juce::var extra = {})
{
    auto* obj = new juce::DynamicObject();
    obj->setProperty ("protocol", kProtocolVersion);
    obj->setProperty ("message", messageType);
    if (requestId.isNotEmpty())
        obj->setProperty ("requestId", requestId);
    if (auto* extraObj = extra.getDynamicObject())
    {
        for (auto& p : extraObj->getProperties())
            obj->setProperty (p.name, p.value);
    }
    return juce::var (obj);
}

struct PluginHello
{
    juce::String requestId;
    juce::String token;
    juce::String pluginId;
    juce::String pluginVersion;
    juce::String pluginFormat;
    juce::String hostType;
    juce::String hostVersion;
    juce::String hostPath;
    juce::String projectPath;
    juce::String projectName;
    juce::String role { "track" };
    juce::String trackName;
};

inline bool parsePluginHello (const juce::var& json, PluginHello& out)
{
    if (jsonString (json, "message") != "plugin_hello")
        return false;
    if ((int) json.getProperty ("protocol", 0) < 1)
        return false;

    out.requestId = jsonString (json, "requestId");
    out.token = jsonString (json, "token");
    auto plugin = jsonChild (json, "plugin");
    auto host = jsonChild (json, "host");
    auto project = jsonChild (json, "project");
    out.pluginId = jsonString (plugin, "id");
    out.pluginVersion = jsonString (plugin, "version");
    out.pluginFormat = jsonString (plugin, "format");
    out.hostType = jsonString (host, "type");
    out.hostVersion = jsonString (host, "version");
    out.hostPath = jsonString (host, "path");
    out.projectPath = jsonString (project, "path");
    out.projectName = jsonString (project, "name");
    out.role = jsonString (json, "role");
    if (out.role != "master")
        out.role = "track";
    out.trackName = jsonString (json, "trackName");
    if (out.trackName.isEmpty())
        out.trackName = jsonString (plugin, "trackName");
    return out.pluginId.isNotEmpty();
}

inline juce::var makePluginHello (const PluginHello& hello)
{
    return makeEnvelope ("plugin_hello", hello.requestId, makeObject ({
        { "token", hello.token },
        { "role", hello.role },
        { "trackName", hello.trackName },
        { "plugin", nestedObject ({
            { "id", hello.pluginId },
            { "version", hello.pluginVersion },
            { "format", hello.pluginFormat }
        }) },
        { "host", nestedObject ({
            { "type", hello.hostType },
            { "version", hello.hostVersion },
            { "path", hello.hostPath }
        }) },
        { "project", nestedObject ({
            { "path", hello.projectPath },
            { "name", hello.projectName }
        }) }
    }));
}

inline juce::var makeHelloAck (const juce::String& requestId,
                               const juce::String& connectionId,
                               const juce::String& projectId,
                               const juce::String& sessionId,
                               const juce::String& assignedRole = "track",
                               bool roleAccepted = true,
                               const juce::String& listenUrl = {})
{
    return makeEnvelope ("hello_ack", requestId, makeObject ({
        { "connectionId", connectionId },
        { "projectId", projectId },
        { "sessionId", sessionId },
        { "assignedRole", assignedRole },
        { "roleAccepted", roleAccepted },
        { "listenUrl", listenUrl }
    }));
}

inline juce::var makeHelloNack (const juce::String& requestId, const juce::String& error)
{
    return makeEnvelope ("hello_nack", requestId, makeObject ({
        { "error", error }
    }));
}

inline juce::var makeCommand (const juce::String& name, juce::var payload = {})
{
    return makeEnvelope ("command", juce::Uuid().toDashedString(), makeObject ({
        { "name", name },
        { "payload", payload }
    }));
}

inline juce::var makeControlEvent (const juce::String& name, juce::var payload = {})
{
    return makeEnvelope ("control_event", juce::Uuid().toDashedString(), makeObject ({
        { "name", name },
        { "payload", payload }
    }));
}

} // namespace AsaphOps
