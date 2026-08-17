#pragma once

#include <string>
#include <cstdint>
#include <vector>

namespace LiveMixStream {

enum class PluginMode
{
    TrackControl = 0,
    Streaming = 1
};

enum class HierarchyRole
{
    Idle = 0,
    Unducked = 1,
    Ducked = 2
};

inline const char* pluginModeToString (PluginMode mode)
{
    return mode == PluginMode::Streaming ? "Streaming" : "TrackControl";
}

inline PluginMode pluginModeFromString (const std::string& s)
{
    return (s == "Streaming" || s == "streaming") ? PluginMode::Streaming : PluginMode::TrackControl;
}

inline const char* hierarchyRoleToString (HierarchyRole role)
{
    switch (role)
    {
        case HierarchyRole::Unducked: return "LIVE";
        case HierarchyRole::Ducked:   return "DUCKED";
        default:                      return "IDLE";
    }
}

struct TrackSwitch
{
    std::string instanceId;
    bool unducked = true;
};

struct HierarchyState
{
    std::string groupId = "default";
    bool unducked = true;
    std::vector<TrackSwitch> tracks;
};

} // namespace LiveMixStream
