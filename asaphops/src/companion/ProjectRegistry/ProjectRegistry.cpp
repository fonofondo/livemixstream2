#include "ProjectRegistry.h"

namespace AsaphOps {

void ProjectRegistry::load()
{
    const juce::ScopedLock sl (lock);
    daws.clear();
    projects.clear();
    auto f = registryFile();
    if (! f.existsAsFile())
        return;

    auto json = juce::JSON::parse (f.loadFileAsString());
    if (auto* dawList = json.getProperty ("daws", {}).getArray())
    {
        for (auto& item : *dawList)
        {
            DawRecord d;
            d.id = item.getProperty ("id", {}).toString();
            d.hostType = item.getProperty ("hostType", {}).toString();
            d.hostPath = item.getProperty ("hostPath", {}).toString();
            d.hostVersion = item.getProperty ("hostVersion", {}).toString();
            if (d.id.isNotEmpty())
                daws.add (d);
        }
    }
    if (auto* projectList = json.getProperty ("projects", {}).getArray())
    {
        for (auto& item : *projectList)
        {
            ProjectRecord p;
            p.id = item.getProperty ("id", {}).toString();
            p.dawId = item.getProperty ("dawId", {}).toString();
            p.projectPath = item.getProperty ("projectPath", {}).toString();
            p.projectName = item.getProperty ("projectName", {}).toString();
            p.createdAt = (juce::int64) item.getProperty ("createdAt", 0);
            p.lastSeenAt = (juce::int64) item.getProperty ("lastSeenAt", 0);
            if (p.id.isNotEmpty())
                projects.add (p);
        }
    }
}

void ProjectRegistry::save() const
{
    const juce::ScopedLock sl (lock);
    saveUnlocked();
}

void ProjectRegistry::saveUnlocked() const
{
    juce::Array<juce::var> dawVars;
    for (auto& d : daws)
    {
        auto* obj = new juce::DynamicObject();
        obj->setProperty ("id", d.id);
        obj->setProperty ("hostType", d.hostType);
        obj->setProperty ("hostPath", d.hostPath);
        obj->setProperty ("hostVersion", d.hostVersion);
        dawVars.add (juce::var (obj));
    }
    juce::Array<juce::var> projectVars;
    for (auto& p : projects)
    {
        auto* obj = new juce::DynamicObject();
        obj->setProperty ("id", p.id);
        obj->setProperty ("dawId", p.dawId);
        obj->setProperty ("projectPath", p.projectPath);
        obj->setProperty ("projectName", p.projectName);
        obj->setProperty ("createdAt", p.createdAt);
        obj->setProperty ("lastSeenAt", p.lastSeenAt);
        projectVars.add (juce::var (obj));
    }
    auto* root = new juce::DynamicObject();
    root->setProperty ("daws", dawVars);
    root->setProperty ("projects", projectVars);
    registryFile().replaceWithText (juce::JSON::toString (juce::var (root), true));
}

DawRecord ProjectRegistry::ensureDaw (const juce::String& hostType,
                                      const juce::String& hostPath,
                                      const juce::String& hostVersion)
{
    DawRecord result;
    {
        const juce::ScopedLock sl (lock);
        bool found = false;
        for (auto& d : daws)
        {
            if (d.hostType == hostType && d.hostPath == hostPath)
            {
                d.hostVersion = hostVersion;
                result = d;
                saveUnlocked();
                found = true;
                break;
            }
        }
        if (! found)
        {
            result.id = juce::Uuid().toDashedString();
            result.hostType = hostType;
            result.hostPath = hostPath;
            result.hostVersion = hostVersion;
            daws.add (result);
            saveUnlocked();
        }
    }
    sendChangeMessage();
    return result;
}

ProjectRecord ProjectRegistry::ensureProject (const DawRecord& daw,
                                              const juce::String& projectPath,
                                              const juce::String& projectName)
{
    const auto keyPath = projectPath.isNotEmpty() ? projectPath : juce::String ("(unnamed)");
    ProjectRecord result;
    {
        const juce::ScopedLock sl (lock);
        bool found = false;
        for (auto& p : projects)
        {
            if (p.dawId == daw.id && p.projectPath == keyPath)
            {
                if (projectName.isNotEmpty())
                    p.projectName = projectName;
                p.lastSeenAt = juce::Time::currentTimeMillis();
                result = p;
                saveUnlocked();
                found = true;
                break;
            }
        }
        if (! found)
        {
            result.id = juce::Uuid().toDashedString();
            result.dawId = daw.id;
            result.projectPath = keyPath;
            result.projectName = projectName.isNotEmpty() ? projectName : keyPath.fromLastOccurrenceOf ("/", false, false);
            result.createdAt = juce::Time::currentTimeMillis();
            result.lastSeenAt = result.createdAt;
            projects.add (result);
            saveUnlocked();
        }
    }
    sendChangeMessage();
    return result;
}

juce::Array<ProjectRecord> ProjectRegistry::getProjects() const
{
    const juce::ScopedLock sl (lock);
    return projects;
}

juce::Array<DawRecord> ProjectRegistry::getDaws() const
{
    const juce::ScopedLock sl (lock);
    return daws;
}

void ProjectRegistry::touchProject (const juce::String& projectId)
{
    const juce::ScopedLock sl (lock);
    for (auto& p : projects)
    {
        if (p.id == projectId)
        {
            p.lastSeenAt = juce::Time::currentTimeMillis();
            break;
        }
    }
    saveUnlocked();
}

} // namespace AsaphOps
