#pragma once

#include <juce_core/juce_core.h>
#include <string>

namespace LiveMixStream {

class PluginIdentity
{
public:
    PluginIdentity()
    {
        m_instanceId = juce::Uuid().toDashedString().toStdString();
    }

    const std::string& getInstanceId() const { return m_instanceId; }

    void setInstanceId (const std::string& id)
    {
        if (! id.empty())
            m_instanceId = id;
    }

    static std::string pluginVersion() { return "1.0.0"; }

    static std::string operatingSystem()
    {
       #if JUCE_WINDOWS
        return "Windows";
       #elif JUCE_MAC
        return "macOS";
       #elif JUCE_LINUX
        return "Linux";
       #else
        return "Unknown";
       #endif
    }

private:
    std::string m_instanceId;
};

} // namespace LiveMixStream
