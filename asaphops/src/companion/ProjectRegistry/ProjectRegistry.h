#pragma once

#include <juce_core/juce_core.h>
#include <juce_events/juce_events.h>
#include "shared/Paths.h"

namespace AsaphOps {

struct DawRecord
{
    juce::String id;
    juce::String hostType;
    juce::String hostPath;
    juce::String hostVersion;
};

struct ProjectRecord
{
    juce::String id;
    juce::String dawId;
    juce::String projectPath;
    juce::String projectName;
    juce::int64 createdAt = 0;
    juce::int64 lastSeenAt = 0;
};

class ProjectRegistry : public juce::ChangeBroadcaster
{
public:
    void load();
    void save() const;

    DawRecord ensureDaw (const juce::String& hostType,
                         const juce::String& hostPath,
                         const juce::String& hostVersion);

    ProjectRecord ensureProject (const DawRecord& daw,
                                 const juce::String& projectPath,
                                 const juce::String& projectName);

    juce::Array<ProjectRecord> getProjects() const;
    juce::Array<DawRecord> getDaws() const;

    void touchProject (const juce::String& projectId);

private:
    void saveUnlocked() const;

    juce::Array<DawRecord> daws;
    juce::Array<ProjectRecord> projects;
    mutable juce::CriticalSection lock;
};

} // namespace AsaphOps
