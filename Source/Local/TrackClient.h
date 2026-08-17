#pragma once

#include "LocalProtocol.h"
#include "../Hierarchy/HierarchyTypes.h"
#include <functional>
#include <mutex>
#include <thread>
#include <atomic>
#include <string>
#include <cstring>
#include <chrono>

#ifdef _WIN32
  #include <winsock2.h>
  #include <ws2tcpip.h>
#else
  #include <sys/socket.h>
  #include <netinet/in.h>
  #include <arpa/inet.h>
  #include <unistd.h>
  #include <fcntl.h>
  #include <errno.h>
#endif

namespace LiveMixStream {

class TrackClient
{
public:
    using HierarchyCallback = std::function<void(const HierarchyState&)>;
    using NameCallback = std::function<void(const std::string&, bool)>;

    TrackClient() = default;
    ~TrackClient() { stop(); }

    void setIdentity (const std::string& instanceId, const std::string& trackName, const std::string& groupId)
    {
        std::lock_guard<std::mutex> lock (m_mutex);
        m_instanceId = instanceId;
        m_trackName = trackName;
        m_groupId = groupId;
        m_metaDirty = true;
    }

    void updateMeta (const std::string& trackName, const std::string& groupId)
    {
        std::lock_guard<std::mutex> lock (m_mutex);
        m_trackName = trackName;
        m_groupId = groupId;
        m_metaDirty = true;
    }

    void updateDuck (float duckGain, int fadeMs)
    {
        std::lock_guard<std::mutex> lock (m_mutex);
        m_duckGain = duckGain;
        m_fadeMs = fadeMs;
        m_metaDirty = true;
    }

    void requestSetUnducked (bool unducked)
    {
        m_pendingUnducked.store (unducked ? 1 : 0);
    }

    void setHierarchyCallback (HierarchyCallback cb)
    {
        std::lock_guard<std::mutex> lock (m_mutex);
        m_hierarchyCallback = std::move (cb);
    }

    void setNameCallback (NameCallback cb)
    {
        std::lock_guard<std::mutex> lock (m_mutex);
        m_nameCallback = std::move (cb);
    }

    bool isLinked() const { return m_linked.load(); }

    void start()
    {
        if (m_running)
            return;
        m_running = true;
        m_thread = std::thread (&TrackClient::loop, this);
    }

    void stop()
    {
        if (! m_running)
            return;
        m_running = false;
        if (m_thread.joinable())
            m_thread.join();
        m_linked = false;
    }

private:
    static void closeSock (int sock)
    {
#ifdef _WIN32
        closesocket (sock);
#else
        close (sock);
#endif
    }

    static bool sendLine (int sock, const std::string& json)
    {
        const std::string line = json + "\n";
#ifdef _WIN32
        int n = send (sock, line.data(), (int) line.size(), 0);
#else
        int n = (int) send (sock, line.data(), line.size(), MSG_NOSIGNAL);
#endif
        return n == (int) line.size();
    }

    void handleLine (const std::string& line)
    {
        const auto type = Local::extractJsonString (line, "type");
        if (type == "LINKED")
        {
            m_linked = true;
            return;
        }
        if (type == "SET_NAME")
        {
            const auto name = Local::extractJsonString (line, "trackName");
            const bool lockName = Local::extractJsonBool (line, "lock", true);
            NameCallback cb;
            {
                std::lock_guard<std::mutex> lock (m_mutex);
                if (! name.empty())
                    m_trackName = name;
                cb = m_nameCallback;
            }
            if (cb && ! name.empty())
                cb (name, lockName);
            return;
        }
        if (line.find ("HIERARCHY_STATE") != std::string::npos)
        {
            HierarchyState state;
            state.unducked = Local::extractJsonBool (line, "unducked", true);
            HierarchyCallback cb;
            {
                std::lock_guard<std::mutex> lock (m_mutex);
                cb = m_hierarchyCallback;
            }
            if (cb)
                cb (state);
        }
    }

    void loop()
    {
        int sock = -1;
        std::string rx;
        auto lastReg = std::chrono::steady_clock::now() - std::chrono::seconds (10);

        while (m_running)
        {
            if (sock < 0)
            {
                m_linked = false;
                const int port = Local::readPortFile();
                sock = (int) socket (AF_INET, SOCK_STREAM, 0);
                if (sock < 0)
                {
                    std::this_thread::sleep_for (std::chrono::milliseconds (400));
                    continue;
                }
                sockaddr_in addr {};
                addr.sin_family = AF_INET;
                addr.sin_port = htons ((uint16_t) (port > 0 ? port : Local::kDefaultPort));
                addr.sin_addr.s_addr = htonl (INADDR_LOOPBACK);
                if (connect (sock, (sockaddr*) &addr, sizeof (addr)) < 0)
                {
                    closeSock (sock);
                    sock = -1;
                    std::this_thread::sleep_for (std::chrono::milliseconds (500));
                    continue;
                }
                m_metaDirty = true;
            }

            auto now = std::chrono::steady_clock::now();
            if (m_metaDirty || now - lastReg > std::chrono::seconds (4))
            {
                std::string instanceId, trackName, groupId;
                float duckGain;
                int fadeMs;
                {
                    std::lock_guard<std::mutex> lock (m_mutex);
                    instanceId = m_instanceId;
                    trackName = m_trackName;
                    groupId = m_groupId;
                    duckGain = m_duckGain;
                    fadeMs = m_fadeMs;
                    m_metaDirty = false;
                }
                const std::string json =
                    std::string ("{\"type\":\"REGISTER\",\"instanceId\":\"") + Local::jsonEscape (instanceId)
                    + "\",\"trackName\":\"" + Local::jsonEscape (trackName)
                    + "\",\"groupId\":\"" + Local::jsonEscape (groupId)
                    + "\",\"duckGain\":" + Local::jsonFloat (duckGain)
                    + ",\"fadeDurationMs\":" + std::to_string (fadeMs) + "}";
                if (! sendLine (sock, json))
                {
                    closeSock (sock);
                    sock = -1;
                    continue;
                }
                lastReg = now;
            }

            const int pendingUnducked = m_pendingUnducked.exchange (-1);
            if (pendingUnducked >= 0 && sock >= 0)
            {
                const std::string json =
                    std::string ("{\"type\":\"SET_UNDUCKED\",\"unducked\":")
                    + (pendingUnducked ? "true" : "false") + "}";
                if (! sendLine (sock, json))
                {
                    closeSock (sock);
                    sock = -1;
                    m_pendingUnducked.store (pendingUnducked);
                    continue;
                }
            }

            char buf[2048];
#ifdef _WIN32
            u_long mode = 1;
            ioctlsocket (sock, FIONBIO, &mode);
            int got = recv (sock, buf, sizeof (buf), 0);
            mode = 0;
            ioctlsocket (sock, FIONBIO, &mode);
#else
            int got = (int) recv (sock, buf, sizeof (buf), MSG_DONTWAIT);
#endif
            if (got > 0)
            {
                rx.append (buf, (size_t) got);
                size_t nl;
                while ((nl = rx.find ('\n')) != std::string::npos)
                {
                    std::string line = rx.substr (0, nl);
                    rx.erase (0, nl + 1);
                    if (! line.empty() && line.back() == '\r')
                        line.pop_back();
                    if (! line.empty())
                        handleLine (line);
                }
            }
            else if (got == 0)
            {
                closeSock (sock);
                sock = -1;
                m_linked = false;
            }
#ifndef _WIN32
            else if (errno != EAGAIN && errno != EWOULDBLOCK)
            {
                closeSock (sock);
                sock = -1;
                m_linked = false;
            }
#endif

            std::this_thread::sleep_for (std::chrono::milliseconds (40));
        }

        if (sock >= 0)
            closeSock (sock);
        m_linked = false;
    }

    std::thread m_thread;
    std::atomic<bool> m_running { false };
    std::atomic<bool> m_linked { false };
    std::mutex m_mutex;
    std::string m_instanceId;
    std::string m_trackName { "Track" };
    std::string m_groupId { "default" };
    float m_duckGain { 0.30f };
    int m_fadeMs { 200 };
    std::atomic<bool> m_metaDirty { true };
    std::atomic<int> m_pendingUnducked { -1 };
    HierarchyCallback m_hierarchyCallback;
    NameCallback m_nameCallback;
};

} // namespace LiveMixStream
