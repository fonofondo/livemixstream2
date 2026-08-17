#include "SessionManager.h"

namespace AsaphOps {

PluginSession SessionManager::addSession (const PluginSession& session)
{
    PluginSession stored = session;
    stored.active = true;
    if (stored.connectionId.isEmpty())
        stored.connectionId = juce::Uuid().toDashedString();
    if (stored.sessionId.isEmpty())
        stored.sessionId = juce::Uuid().toDashedString();

    {
        const juce::ScopedLock sl (lock);
        bool replaced = false;
        for (auto& existing : sessions)
        {
            if (existing.connectionId == stored.connectionId || existing.pluginId == stored.pluginId)
            {
                existing = stored;
                replaced = true;
                break;
            }
        }
        if (! replaced)
            sessions.add (stored);
    }
    sendChangeMessage();
    return stored;
}

void SessionManager::removeSession (const juce::String& connectionId)
{
    {
        const juce::ScopedLock sl (lock);
        for (int i = sessions.size(); --i >= 0;)
            if (sessions.getReference (i).connectionId == connectionId)
                sessions.remove (i);
    }
    sendChangeMessage();
}

bool SessionManager::updateSession (const juce::String& connectionId, const std::function<void (PluginSession&)>& fn)
{
    bool found = false;
    {
        const juce::ScopedLock sl (lock);
        for (auto& session : sessions)
        {
            if (session.connectionId == connectionId)
            {
                fn (session);
                found = true;
                break;
            }
        }
    }
    if (found)
        sendChangeMessage();
    return found;
}

juce::Array<PluginSession> SessionManager::getSessions() const
{
    const juce::ScopedLock sl (lock);
    return sessions;
}

juce::Array<PluginSession> SessionManager::getActiveSessions() const
{
    const juce::ScopedLock sl (lock);
    juce::Array<PluginSession> active;
    for (auto& session : sessions)
        if (session.active)
            active.add (session);
    return active;
}

PluginSession SessionManager::getSession (const juce::String& connectionId) const
{
    const juce::ScopedLock sl (lock);
    for (auto& session : sessions)
        if (session.connectionId == connectionId)
            return session;
    return {};
}

juce::String SessionManager::getMasterConnectionId() const
{
    const juce::ScopedLock sl (lock);
    for (auto& session : sessions)
        if (session.active && session.role == "master")
            return session.connectionId;
    return {};
}

bool SessionManager::hasActiveMaster() const
{
    return getMasterConnectionId().isNotEmpty();
}

} // namespace AsaphOps
