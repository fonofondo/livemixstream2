#pragma once

#include "LocalProtocol.h"
#include "../Hierarchy/HierarchyTypes.h"
#include "../Session/SessionManager.h"
#include "../Plugin/PluginIdentity.h"
#include <functional>
#include <mutex>
#include <thread>
#include <atomic>
#include <vector>
#include <string>
#include <cstring>
#include <chrono>
#include <csignal>
#include <cstddef>
#include <algorithm>
#include <map>

#ifdef _WIN32
  #include <winsock2.h>
  #include <ws2tcpip.h>
  using socklen_t = int;
#else
  #include <sys/socket.h>
  #include <sys/select.h>
  #include <netinet/in.h>
  #include <arpa/inet.h>
  #include <unistd.h>
  #include <fcntl.h>
  #include <errno.h>
#endif

namespace LiveMixStream {

inline bool masterHubReachable()
{
    int sock = (int) ::socket (AF_INET, SOCK_STREAM, 0);
    if (sock < 0)
        return false;
#ifdef _WIN32
    DWORD ms = 150;
    setsockopt (sock, SOL_SOCKET, SO_RCVTIMEO, (const char*) &ms, sizeof (ms));
    setsockopt (sock, SOL_SOCKET, SO_SNDTIMEO, (const char*) &ms, sizeof (ms));
#else
    timeval tv { 0, 150000 };
    setsockopt (sock, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof (tv));
    setsockopt (sock, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof (tv));
#endif
    sockaddr_in addr {};
    addr.sin_family = AF_INET;
    addr.sin_port = htons ((uint16_t) Local::kDefaultPort);
    addr.sin_addr.s_addr = htonl (INADDR_LOOPBACK);
    const bool ok = ::connect (sock, (sockaddr*) &addr, sizeof (addr)) == 0;
#ifdef _WIN32
    closesocket (sock);
#else
    ::close (sock);
#endif
    return ok;
}

struct HubTrack
{
    std::string instanceId;
    std::string trackName;
    std::string groupId;
    float duckGain = 0.30f;
    int fadeMs = 200;
};

class MasterHub
{
public:
    using ForwardJson = std::function<void(const std::string&)>;

    explicit MasterHub (SessionManager& sessionManager)
        : m_sessionManager (sessionManager)
    {
#ifndef _WIN32
        signal (SIGPIPE, SIG_IGN);
#endif
    }

    ~MasterHub() { stop(); }

    void setForwardJson (ForwardJson cb)
    {
        std::lock_guard<std::recursive_mutex> lock (m_mutex);
        m_forward = std::move (cb);
    }

    void setMasterIdentity (const std::string& instanceId, const std::string& trackName, const std::string& groupId)
    {
        std::lock_guard<std::recursive_mutex> lock (m_mutex);
        m_masterId = instanceId;
        m_masterName = trackName;
        m_masterGroup = groupId;
    }

    bool start()
    {
        if (m_running && m_listening)
            return true;
        stop();

        int sock = (int) ::socket (AF_INET, SOCK_STREAM, 0);
        if (sock < 0)
            return false;

        int yes = 1;
        setsockopt (sock, SOL_SOCKET, SO_REUSEADDR, (const char*) &yes, sizeof (yes));

        sockaddr_in addr {};
        addr.sin_family = AF_INET;
        addr.sin_port = htons ((uint16_t) Local::kDefaultPort);
        addr.sin_addr.s_addr = htonl (INADDR_LOOPBACK);
        if (bind (sock, (sockaddr*) &addr, sizeof (addr)) != 0)
        {
            closeSock (sock);
            return false;
        }

        listen (sock, 16);
        setNonBlock (sock);
        Local::writePortFile (Local::kDefaultPort);
        m_listenSock.store (sock);
        m_running = true;
        m_listening = true;
        m_thread = std::thread (&MasterHub::loop, this);
        return true;
    }

    void stop()
    {
        if (! m_running && ! m_thread.joinable())
            return;
        m_running = false;
        const int s = m_listenSock.exchange (-1);
        if (s >= 0)
            closeSock (s);
        if (m_thread.joinable())
            m_thread.join();
        m_listening = false;
    }

    bool isListening() const { return m_listening.load(); }

    std::vector<HubTrack> getChildTracks() const
    {
        std::lock_guard<std::recursive_mutex> lock (m_mutex);
        std::vector<HubTrack> out;
        out.reserve (m_clients.size());
        for (const auto& c : m_clients)
        {
            if (! c.instanceId.empty())
                out.push_back ({ c.instanceId, c.trackName, c.groupId, c.duckGain, c.fadeMs });
        }
        return out;
    }

    bool isUnducked (const std::string& instanceId) const
    {
        std::lock_guard<std::recursive_mutex> lock (m_mutex);
        auto it = m_unducked.find (instanceId);
        if (it == m_unducked.end())
            return true;
        return it->second;
    }

    void setUnducked (const std::string& instanceId, bool unducked)
    {
        if (instanceId.empty())
            return;
        {
            std::lock_guard<std::recursive_mutex> lock (m_mutex);
            m_unducked[instanceId] = unducked;
            m_lastSyncKey.clear();
        }
        pushLocalHierarchy();
        forwardSetUnducked (instanceId, unducked);
    }

    bool toggleUnducked (const std::string& instanceId)
    {
        if (instanceId.empty())
            return true;
        bool next = true;
        {
            std::lock_guard<std::recursive_mutex> lock (m_mutex);
            auto it = m_unducked.find (instanceId);
            const bool cur = (it == m_unducked.end()) ? true : it->second;
            next = ! cur;
            m_unducked[instanceId] = next;
            m_lastSyncKey.clear();
        }
        pushLocalHierarchy();
        forwardSetUnducked (instanceId, next);
        return next;
    }

    /** Merge server hierarchy into local duck map and notify Track Control clients. */
    void broadcastHierarchy (const HierarchyState& state)
    {
        {
            std::lock_guard<std::recursive_mutex> lock (m_mutex);
            for (const auto& t : state.tracks)
            {
                if (! t.instanceId.empty())
                    m_unducked[t.instanceId] = t.unducked;
            }
        }
        pushLocalHierarchy();
    }

private:
    struct Client
    {
        int sock = -1;
        std::string instanceId;
        std::string trackName;
        std::string groupId { "default" };
        float duckGain = 0.30f;
        int fadeMs = 200;
        std::string rx;
    };

    static void closeSock (int sock)
    {
#ifdef _WIN32
        closesocket (sock);
#else
        close (sock);
#endif
    }

    static void setNonBlock (int sock)
    {
#ifdef _WIN32
        u_long mode = 1;
        ioctlsocket (sock, FIONBIO, &mode);
#else
        int flags = fcntl (sock, F_GETFL, 0);
        fcntl (sock, F_SETFL, flags | O_NONBLOCK);
#endif
    }

    static bool sendLine (int sock, const std::string& json)
    {
        const std::string line = json + "\n";
        size_t sent = 0;
        while (sent < line.size())
        {
#ifdef _WIN32
            int n = send (sock, line.data() + sent, (int) (line.size() - sent), 0);
#else
            int n = (int) send (sock, line.data() + sent, line.size() - sent, MSG_NOSIGNAL);
#endif
            if (n <= 0)
                return false;
            sent += (size_t) n;
        }
        return true;
    }

    void forwardJson (const std::string& json)
    {
        ForwardJson cb;
        {
            std::lock_guard<std::recursive_mutex> lock (m_mutex);
            cb = m_forward;
        }
        if (cb)
            cb (json);
    }

    void forwardRegister (const std::string& instanceId, const std::string& trackName,
                          const std::string& groupId, PluginMode mode,
                          float duckGain = 0.30f, int fadeMs = 200)
    {
        const std::string sessionId = m_sessionManager.getSessionId();
        if (sessionId.empty())
            return;
        std::string json =
            std::string ("{\"type\":\"HIERARCHY_REGISTER\",\"instanceId\":\"") + Local::jsonEscape (instanceId)
            + "\",\"trackName\":\"" + Local::jsonEscape (trackName)
            + "\",\"groupId\":\"" + Local::jsonEscape (groupId)
            + "\",\"sessionId\":\"" + Local::jsonEscape (sessionId)
            + "\",\"mode\":\"" + pluginModeToString (mode)
            + "\",\"duckGain\":" + Local::jsonFloat (duckGain)
            + ",\"fadeDurationMs\":" + std::to_string (fadeMs)
            + ",\"pluginVersion\":\"" + PluginIdentity::pluginVersion()
            + "\",\"os\":\"" + PluginIdentity::operatingSystem() + "\"}";
        forwardJson (json);
    }

    void forwardSync (const std::string& masterId, const std::string& masterName,
                      const std::string& masterGroup, const std::vector<HubTrack>& children,
                      bool force = false)
    {
        const std::string sessionId = m_sessionManager.getSessionId();
        if (sessionId.empty())
            return;

        std::string tracksJson = "[";
        for (size_t i = 0; i < children.size(); ++i)
        {
            const auto& t = children[i];
            if (i > 0)
                tracksJson += ",";
            bool unducked = true;
            {
                std::lock_guard<std::recursive_mutex> lock (m_mutex);
                auto it = m_unducked.find (t.instanceId);
                if (it != m_unducked.end())
                    unducked = it->second;
            }
            tracksJson += std::string ("{\"instanceId\":\"") + Local::jsonEscape (t.instanceId)
                + "\",\"trackName\":\"" + Local::jsonEscape (t.trackName)
                + "\",\"groupId\":\"" + Local::jsonEscape (t.groupId)
                + "\",\"mode\":\"TrackControl\",\"duckGain\":" + Local::jsonFloat (t.duckGain)
                + ",\"fadeDurationMs\":" + std::to_string (t.fadeMs)
                + ",\"unducked\":" + (unducked ? "true" : "false") + "}";
        }
        tracksJson += "]";

        const std::string syncKey = sessionId + "|" + masterId + "|" + tracksJson;
        {
            std::lock_guard<std::recursive_mutex> lock (m_mutex);
            if (! force && syncKey == m_lastSyncKey)
                return;
            m_lastSyncKey = syncKey;
        }

        if (! masterId.empty())
            forwardRegister (masterId, masterName, masterGroup, PluginMode::Streaming);

        forwardJson (std::string ("{\"type\":\"HIERARCHY_SYNC\",\"sessionId\":\"")
                     + Local::jsonEscape (sessionId) + "\",\"groupId\":\"default\",\"tracks\":"
                     + tracksJson + "}");
    }

    void forwardUnregister (const std::string& instanceId)
    {
        if (instanceId.empty())
            return;
        {
            std::lock_guard<std::recursive_mutex> lock (m_mutex);
            m_unducked.erase (instanceId);
        }
        forwardJson (std::string ("{\"type\":\"HIERARCHY_UNREGISTER\",\"instanceId\":\"")
                     + Local::jsonEscape (instanceId) + "\"}");
    }

    void forwardSetUnducked (const std::string& instanceId, bool unducked)
    {
        const std::string sessionId = m_sessionManager.getSessionId();
        if (sessionId.empty() || instanceId.empty())
            return;

        std::string groupId = "default";
        {
            std::lock_guard<std::recursive_mutex> lock (m_mutex);
            for (const auto& c : m_clients)
            {
                if (c.instanceId == instanceId)
                {
                    groupId = c.groupId.empty() ? "default" : c.groupId;
                    break;
                }
            }
        }

        forwardJson (std::string ("{\"type\":\"SET_TRACK_UNDUCKED\",\"instanceId\":\"")
                     + Local::jsonEscape (instanceId)
                     + "\",\"groupId\":\"" + Local::jsonEscape (groupId)
                     + "\",\"sessionId\":\"" + Local::jsonEscape (sessionId)
                     + "\",\"unducked\":" + (unducked ? "true" : "false") + "}");
    }

    void pushLocalHierarchy()
    {
        std::lock_guard<std::recursive_mutex> lock (m_mutex);
        for (auto& c : m_clients)
        {
            if (c.sock < 0 || c.instanceId.empty())
                continue;
            bool unducked = true;
            auto it = m_unducked.find (c.instanceId);
            if (it != m_unducked.end())
                unducked = it->second;
            sendLine (c.sock, std::string ("{\"type\":\"HIERARCHY_STATE\",\"unducked\":")
                                  + (unducked ? "true" : "false") + "}");
        }
    }

    void handleLine (Client& c, const std::string& line)
    {
        const auto type = Local::extractJsonString (line, "type");
        if (type == "REGISTER")
        {
            const auto newId = Local::extractJsonString (line, "instanceId");
            if (! c.instanceId.empty() && c.instanceId != newId)
                forwardUnregister (c.instanceId);
            c.instanceId = newId;
            c.trackName = Local::extractJsonString (line, "trackName");
            c.groupId = Local::extractJsonString (line, "groupId");
            c.duckGain = Local::extractJsonFloat (line, "duckGain", 0.30f);
            c.fadeMs = Local::extractJsonInt (line, "fadeDurationMs", 200);
            if (c.groupId.empty())
                c.groupId = "default";
            if (c.trackName.empty() || c.trackName == "Track")
            {
                int maxN = 0;
                for (const auto& o : m_clients)
                {
                    if (o.instanceId == c.instanceId)
                        continue;
                    if (o.trackName.rfind ("Track ", 0) == 0)
                    {
                        try { maxN = std::max (maxN, std::stoi (o.trackName.substr (6))); }
                        catch (...) {}
                    }
                }
                c.trackName = "Track " + std::to_string (maxN + 1);
                sendLine (c.sock, std::string ("{\"type\":\"SET_NAME\",\"trackName\":\"")
                                      + Local::jsonEscape (c.trackName) + "\",\"lock\":false}");
            }
            sendLine (c.sock, "{\"type\":\"LINKED\"}");
            if (m_unducked.find (c.instanceId) == m_unducked.end())
                m_unducked[c.instanceId] = true;
            {
                bool unducked = m_unducked[c.instanceId];
                sendLine (c.sock, std::string ("{\"type\":\"HIERARCHY_STATE\",\"unducked\":")
                                      + (unducked ? "true" : "false") + "}");
            }
            std::vector<HubTrack> children;
            std::string masterId, masterName, masterGroup;
            {
                masterId = m_masterId;
                masterName = m_masterName;
                masterGroup = m_masterGroup;
                for (const auto& o : m_clients)
                {
                    if (o.instanceId.empty())
                        continue;
                    bool exists = false;
                    for (const auto& t : children)
                        if (t.instanceId == o.instanceId) { exists = true; break; }
                    if (! exists)
                        children.push_back ({ o.instanceId, o.trackName, o.groupId, o.duckGain, o.fadeMs });
                }
            }
            forwardSync (masterId, masterName, masterGroup, children);
        }
        else if (type == "SET_UNDUCKED")
        {
            if (! c.instanceId.empty())
                setUnducked (c.instanceId, Local::extractJsonBool (line, "unducked", true));
        }
    }

    void dropClient (size_t index)
    {
        Client c;
        {
            std::lock_guard<std::recursive_mutex> lock (m_mutex);
            if (index >= m_clients.size())
                return;
            c = std::move (m_clients[index]);
            m_clients.erase (m_clients.begin() + (ptrdiff_t) index);
        }
        if (c.sock >= 0)
            closeSock (c.sock);
        forwardUnregister (c.instanceId);
    }

    void loop()
    {
        std::string lastSession;
        auto lastReregister = std::chrono::steady_clock::now();

        while (m_running)
        {
            const int listenSock = m_listenSock.load();
            if (listenSock < 0)
                break;

            fd_set rfds;
            FD_ZERO (&rfds);
            FD_SET (listenSock, &rfds);
            int maxFd = listenSock;

            {
                std::lock_guard<std::recursive_mutex> lock (m_mutex);
                for (auto& c : m_clients)
                {
                    FD_SET (c.sock, &rfds);
                    if (c.sock > maxFd)
                        maxFd = c.sock;
                }
            }

            timeval tv { 0, 80000 };
            int n = select (maxFd + 1, &rfds, nullptr, nullptr, &tv);
            if (n > 0 && FD_ISSET (listenSock, &rfds))
            {
                sockaddr_in cli {};
                socklen_t len = sizeof (cli);
                int cs = (int) accept (listenSock, (sockaddr*) &cli, &len);
                if (cs >= 0)
                {
                    setNonBlock (cs);
                    std::lock_guard<std::recursive_mutex> lock (m_mutex);
                    m_clients.push_back (Client { cs });
                }
            }

            std::vector<size_t> dead;
            {
                std::lock_guard<std::recursive_mutex> lock (m_mutex);
                for (size_t i = 0; i < m_clients.size(); ++i)
                {
                    auto& c = m_clients[i];
                    if (n <= 0 || ! FD_ISSET (c.sock, &rfds))
                        continue;
                    char buf[2048];
#ifdef _WIN32
                    int got = recv (c.sock, buf, sizeof (buf), 0);
#else
                    int got = (int) recv (c.sock, buf, sizeof (buf), 0);
#endif
                    if (got <= 0)
                    {
#ifndef _WIN32
                        if (got < 0 && (errno == EAGAIN || errno == EWOULDBLOCK))
                            continue;
#endif
                        dead.push_back (i);
                        continue;
                    }
                    c.rx.append (buf, (size_t) got);
                    size_t nl;
                    while ((nl = c.rx.find ('\n')) != std::string::npos)
                    {
                        std::string line = c.rx.substr (0, nl);
                        c.rx.erase (0, nl + 1);
                        if (! line.empty() && line.back() == '\r')
                            line.pop_back();
                        if (! line.empty())
                            handleLine (c, line);
                    }
                }
            }

            for (int i = (int) dead.size() - 1; i >= 0; --i)
                dropClient (dead[(size_t) i]);

            const std::string sid = m_sessionManager.getSessionId();
            auto now = std::chrono::steady_clock::now();
            if (! sid.empty() && (sid != lastSession || now - lastReregister > std::chrono::seconds (15)))
            {
                const bool sessionChanged = (sid != lastSession);
                lastSession = sid;
                lastReregister = now;
                std::vector<HubTrack> children;
                std::string masterId, masterName, masterGroup;
                {
                    std::lock_guard<std::recursive_mutex> lock (m_mutex);
                    masterId = m_masterId;
                    masterName = m_masterName;
                    masterGroup = m_masterGroup;
                    for (const auto& c : m_clients)
                    {
                        if (c.instanceId.empty())
                            continue;
                        bool exists = false;
                        for (const auto& t : children)
                            if (t.instanceId == c.instanceId) { exists = true; break; }
                        if (! exists)
                            children.push_back ({ c.instanceId, c.trackName, c.groupId, c.duckGain, c.fadeMs });
                    }
                }
                forwardSync (masterId, masterName, masterGroup, children, sessionChanged);
            }
        }

        std::vector<Client> leftover;
        {
            std::lock_guard<std::recursive_mutex> lock (m_mutex);
            leftover.swap (m_clients);
        }
        for (auto& c : leftover)
        {
            forwardUnregister (c.instanceId);
            closeSock (c.sock);
        }

        m_listening = false;
        const int leftoverListen = m_listenSock.exchange (-1);
        if (leftoverListen >= 0)
            closeSock (leftoverListen);
    }

    SessionManager& m_sessionManager;
    std::thread m_thread;
    std::atomic<bool> m_running { false };
    std::atomic<bool> m_listening { false };
    std::atomic<int> m_listenSock { -1 };
    mutable std::recursive_mutex m_mutex;
    std::vector<Client> m_clients;
    std::map<std::string, bool> m_unducked;
    std::string m_lastSyncKey;
    ForwardJson m_forward;
    std::string m_masterId;
    std::string m_masterName { "Track" };
    std::string m_masterGroup { "default" };
};

} // namespace LiveMixStream
