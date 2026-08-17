#pragma once

#include "../Audio/AudioBufferQueue.h"
#include "../Session/SessionManager.h"
#include "../Hierarchy/HierarchyTypes.h"
#include <thread>
#include <atomic>
#include <memory>
#include <functional>
#include <string>
#include <vector>
#include <chrono>
#include <cstring>
#include <cstdlib>
#include <mutex>
#include <cmath>

#ifdef _WIN32
  #include <winsock2.h>
  #include <ws2tcpip.h>
  #pragma comment(lib, "ws2_32.lib")
  using socklen_t = int;
#else
  #include <sys/socket.h>
  #include <netinet/in.h>
  #include <arpa/inet.h>
  #include <netdb.h>
  #include <unistd.h>
  #include <fcntl.h>
  #include <signal.h>
#endif

#if __has_include(<opus/opus.h>)
  #include <opus/opus.h>
  #define LMS_HAS_OPUS 1
#else
  #define LMS_HAS_OPUS 0
#endif

namespace LiveMixStream {

class NetworkClient {
public:
    using HierarchyCallback = std::function<void(const HierarchyState&)>;

    NetworkClient(LockFreeAudioQueue& audioQueue, SessionManager& sessionManager)
        : m_audioQueue(audioQueue),
          m_sessionManager(sessionManager)
    {
#ifndef _WIN32
        signal(SIGPIPE, SIG_IGN);
#endif
    }

    ~NetworkClient() { stop(); }

    void setIdentity(const std::string& instanceId, const std::string& trackName, const std::string& groupId)
    {
        std::lock_guard<std::mutex> lock(m_metaMutex);
        m_instanceId = instanceId;
        m_trackName = trackName;
        m_groupId = groupId;
    }

    void setPluginMode(PluginMode mode) { m_mode = mode; }

    void setHierarchyCallback(HierarchyCallback cb)
    {
        std::lock_guard<std::mutex> lock(m_metaMutex);
        m_hierarchyCallback = std::move(cb);
    }

    void updateTrackMeta(const std::string& trackName, const std::string& groupId)
    {
        std::lock_guard<std::mutex> lock(m_metaMutex);
        m_trackName = trackName;
        m_groupId = groupId;
        m_metaDirty = true;
    }

    bool start(const std::string& serverEndpoint)
    {
        if (m_isRunning) return true;
        m_serverEndpoint = serverEndpoint;
        m_isRunning = true;
        m_wantStream = false;
        m_networkThread = std::thread(&NetworkClient::networkWorkerLoop, this);
        return true;
    }

    void startStreaming()
    {
        m_wantStream = true;
        m_sessionManager.setState(SessionState::Connecting);
    }

    void stopStreaming()
    {
        m_wantStream = false;
        m_sessionManager.setState(SessionState::Created);
    }

    void stop()
    {
        if (!m_isRunning) return;
        m_isRunning = false;
        m_wantStream = false;
        if (m_networkThread.joinable())
            m_networkThread.join();
        m_sessionManager.setPluginConnected(false);
    }

    bool isConnected() const { return m_isConnected; }

    void enqueueJson (std::string json)
    {
        std::lock_guard<std::mutex> lock (m_outMutex);
        m_outbox.push_back (std::move (json));
    }

private:
    struct ServerAddress {
        std::string host = "127.0.0.1";
        int port = 3001;
    };

    ServerAddress parseEndpoint(const std::string& url)
    {
        ServerAddress addr;
        std::string str = url;
        if (str.find("https://") == 0) str = str.substr(8);
        else if (str.find("http://") == 0) str = str.substr(7);

        size_t slashPos = str.find('/');
        if (slashPos != std::string::npos) str = str.substr(0, slashPos);

        size_t colonPos = str.find(':');
        if (colonPos != std::string::npos) {
            addr.host = str.substr(0, colonPos);
            try { addr.port = std::stoi(str.substr(colonPos + 1)); } catch (...) {}
        } else {
            addr.host = str;
        }
        if (addr.host == "localhost" || addr.host.empty())
            addr.host = "127.0.0.1";
        return addr;
    }

    int connectSocket(const std::string& ipOrHost, int port)
    {
        int sock = (int) socket(AF_INET, SOCK_STREAM, 0);
        if (sock < 0) return -1;

#ifndef _WIN32
        struct timeval tv { 3, 0 };
        setsockopt(sock, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
        setsockopt(sock, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));
#endif

        sockaddr_in serv_addr {};
        serv_addr.sin_family = AF_INET;
        serv_addr.sin_port = htons((uint16_t) port);

        if (inet_pton(AF_INET, ipOrHost.c_str(), &serv_addr.sin_addr) <= 0) {
            hostent* hp = gethostbyname(ipOrHost.c_str());
            if (!hp) { closeSocket(sock); return -1; }
            std::memcpy(&serv_addr.sin_addr, hp->h_addr, (size_t) hp->h_length);
        }

        if (connect(sock, (sockaddr*) &serv_addr, sizeof(serv_addr)) < 0) {
            closeSocket(sock);
            return -1;
        }
        return sock;
    }

    void closeSocket(int sock)
    {
#ifdef _WIN32
        closesocket(sock);
#else
        close(sock);
#endif
    }

    bool sendData(int sock, const void* data, size_t len)
    {
        if (sock < 0) return false;
#ifdef _WIN32
        int sent = send(sock, (const char*) data, (int) len, 0);
#else
        int sent = (int) send(sock, data, len, MSG_NOSIGNAL);
#endif
        return sent == (int) len;
    }

    static std::string extractJsonString(const std::string& src, const std::string& key)
    {
        std::string needle = "\"" + key + "\":\"";
        size_t pos = src.find(needle);
        if (pos == std::string::npos) return {};
        pos += needle.size();
        size_t end = src.find('"', pos);
        if (end == std::string::npos) return {};
        return src.substr(pos, end - pos);
    }

    static int extractJsonInt(const std::string& src, const std::string& key, int fallback = 0)
    {
        std::string needle = "\"" + key + "\":";
        size_t pos = src.find(needle);
        if (pos == std::string::npos) return fallback;
        pos += needle.size();
        while (pos < src.size() && (src[pos] == ' ' || src[pos] == '"')) ++pos;
        try { return std::stoi(src.substr(pos)); } catch (...) { return fallback; }
    }

    static float extractJsonFloat(const std::string& src, const std::string& key, float fallback = 0.0f)
    {
        std::string needle = "\"" + key + "\":";
        size_t pos = src.find(needle);
        if (pos == std::string::npos) return fallback;
        pos += needle.size();
        while (pos < src.size() && src[pos] == ' ') ++pos;
        try { return std::stof(src.substr(pos)); } catch (...) { return fallback; }
    }

    static bool extractJsonBool(const std::string& src, const std::string& key, bool fallback = false)
    {
        std::string needle = "\"" + key + "\":";
        size_t pos = src.find(needle);
        if (pos == std::string::npos) return fallback;
        pos += needle.size();
        while (pos < src.size() && src[pos] == ' ') ++pos;
        if (src.compare(pos, 4, "true") == 0) return true;
        if (src.compare(pos, 5, "false") == 0) return false;
        return fallback;
    }

    bool httpPostJson(const ServerAddress& addr, const std::string& path, const std::string& body, std::string& responseBody)
    {
        int sock = connectSocket(addr.host, addr.port);
        if (sock < 0) return false;

        std::string req =
            "POST " + path + " HTTP/1.1\r\n"
            "Host: " + addr.host + ":" + std::to_string(addr.port) + "\r\n"
            "Content-Type: application/json\r\n"
            "Content-Length: " + std::to_string(body.size()) + "\r\n"
            "Connection: close\r\n\r\n" + body;

        bool ok = sendData(sock, req.data(), req.size());
        if (ok) {
            char buf[8192];
            std::string resp;
            int n;
            while ((n = (int) recv(sock, buf, sizeof(buf), 0)) > 0)
                resp.append(buf, (size_t) n);
            size_t bodyPos = resp.find("\r\n\r\n");
            if (bodyPos != std::string::npos)
                responseBody = resp.substr(bodyPos + 4);
        }
        closeSocket(sock);
        return ok && !responseBody.empty();
    }

    bool wsHandshake(int sock, const ServerAddress& addr, const std::string& path)
    {
        std::string hs =
            "GET " + path + " HTTP/1.1\r\n"
            "Host: " + addr.host + ":" + std::to_string(addr.port) + "\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"
            "Sec-WebSocket-Version: 13\r\n\r\n";

        if (!sendData(sock, hs.data(), hs.size())) return false;
        char buf[2048] = {};
        int n = (int) recv(sock, buf, sizeof(buf) - 1, 0);
        if (n <= 0) return false;
        return std::string(buf, (size_t) n).find("101") != std::string::npos;
    }

    bool sendWsText(int sock, const std::string& text)
    {
        std::vector<uint8_t> frame;
        frame.push_back(0x81);
        auto len = (uint32_t) text.size();
        if (len <= 125) {
            frame.push_back(0x80 | (uint8_t) len);
        } else if (len <= 65535) {
            frame.push_back(0x80 | 126);
            frame.push_back((len >> 8) & 0xFF);
            frame.push_back(len & 0xFF);
        } else {
            return false;
        }
        uint8_t mask[4] = { 0x11, 0x22, 0x33, 0x44 };
        frame.insert(frame.end(), mask, mask + 4);
        for (size_t i = 0; i < text.size(); ++i)
            frame.push_back((uint8_t) text[i] ^ mask[i % 4]);
        return sendData(sock, frame.data(), frame.size());
    }

    bool sendWsBinary(int sock, const uint8_t* data, size_t len)
    {
        std::vector<uint8_t> frame;
        frame.push_back(0x82);
        if (len <= 125) {
            frame.push_back(0x80 | (uint8_t) len);
        } else if (len <= 65535) {
            frame.push_back(0x80 | 126);
            frame.push_back((len >> 8) & 0xFF);
            frame.push_back(len & 0xFF);
        } else {
            frame.push_back(0x80 | 127);
            for (int i = 7; i >= 0; --i)
                frame.push_back((uint8_t) ((len >> (i * 8)) & 0xFF));
        }
        uint8_t mask[4] = { 0x12, 0x34, 0x56, 0x78 };
        frame.insert(frame.end(), mask, mask + 4);
        for (size_t i = 0; i < len; ++i)
            frame.push_back(data[i] ^ mask[i % 4]);
        return sendData(sock, frame.data(), frame.size());
    }

    void handleIncomingJson(const std::string& msg)
    {
        if (msg.find("\"HIERARCHY_STATE\"") != std::string::npos || msg.find("\"type\":\"HIERARCHY_STATE\"") != std::string::npos) {
            HierarchyState state;
            state.groupId = extractJsonString(msg, "groupId");
            if (state.groupId.empty()) state.groupId = "default";
            state.unducked = true;

            std::string selfId;
            {
                std::lock_guard<std::mutex> lock(m_metaMutex);
                selfId = m_instanceId;
            }
            const std::string key = "\"instanceId\":\"";
            size_t pos = 0;
            while ((pos = msg.find(key, pos)) != std::string::npos) {
                pos += key.size();
                size_t end = msg.find('"', pos);
                if (end == std::string::npos) break;
                const std::string id = msg.substr(pos, end - pos);
                size_t objEnd = msg.find('}', end);
                if (objEnd == std::string::npos) objEnd = msg.size();
                const std::string slice = msg.substr(end, objEnd - end);
                const bool u = extractJsonBool(slice, "unducked", true);
                state.tracks.push_back({ id, u });
                if (id == selfId)
                    state.unducked = u;
                pos = end;
            }

            HierarchyCallback cb;
            {
                std::lock_guard<std::mutex> lock(m_metaMutex);
                cb = m_hierarchyCallback;
            }
            if (cb) cb(state);
        }

        if (msg.find("\"listeners\"") != std::string::npos) {
            int listeners = extractJsonInt(msg, "listeners", m_activeListeners);
            m_activeListeners = listeners;
        }
        if (msg.find("\"count\"") != std::string::npos && msg.find("LISTENER_COUNT") != std::string::npos) {
            m_activeListeners = extractJsonInt(msg, "count", m_activeListeners);
        }
        if (msg.find("effectiveLatencyMs") != std::string::npos) {
            m_effectiveLatencyMs = extractJsonInt(msg, "effectiveLatencyMs", m_effectiveLatencyMs);
        }
        if (msg.find("PLAIN_TRANSPORT") != std::string::npos && msg.find("FALLBACK") == std::string::npos) {
            m_rtpHost = extractJsonString(msg, "ip");
            if (m_rtpHost.empty()) m_rtpHost = extractJsonString(msg, "host");
            m_rtpPort = extractJsonInt(msg, "port", m_rtpPort);
            m_rtpSsrc = (uint32_t) extractJsonInt(msg, "ssrc", (int) m_rtpSsrc);
            m_rtpPayloadType = (uint8_t) extractJsonInt(msg, "payloadType", m_rtpPayloadType);
            m_hasRtpTarget = !m_rtpHost.empty() && m_rtpPort > 0;
        }

        m_sessionManager.updateTelemetry(m_activeListeners, m_effectiveLatencyMs, 0.0f, m_bytesTransmitted);
    }

    void pollWs(int sock)
    {
        uint8_t rx[4096];
#ifdef _WIN32
        u_long mode = 1;
        ioctlsocket(sock, FIONBIO, &mode);
        int n = recv(sock, (char*) rx, sizeof(rx), 0);
        mode = 0;
        ioctlsocket(sock, FIONBIO, &mode);
#else
        int n = (int) recv(sock, rx, sizeof(rx), MSG_DONTWAIT);
#endif
        if (n <= 0) return;

        uint8_t opcode = rx[0] & 0x0F;
        if (opcode == 0x09) {
            uint8_t pong[6] = { 0x8A, 0x80, 0x12, 0x34, 0x56, 0x78 };
            sendData(sock, pong, sizeof(pong));
            return;
        }
        if (opcode == 0x01) {
            size_t offset = 2;
            size_t payloadLen = rx[1] & 0x7F;
            if (payloadLen == 126 && n >= 4) {
                payloadLen = (size_t(rx[2]) << 8) | rx[3];
                offset = 4;
            }
            if (offset + payloadLen <= (size_t) n)
                handleIncomingJson(std::string((char*) rx + offset, payloadLen));
            else
                handleIncomingJson(std::string((char*) rx, (size_t) n));
        }
    }

    bool sendRtpOpus(const uint8_t* opusData, size_t opusLen, uint32_t timestamp)
    {
        if (!m_hasRtpTarget || m_rtpSock < 0) return false;

        // RTP header 12 bytes + Opus payload
        uint8_t packet[1500];
        if (12 + opusLen > sizeof(packet)) return false;

        packet[0] = 0x80;
        packet[1] = m_rtpPayloadType & 0x7F;
        packet[2] = (m_rtpSeq >> 8) & 0xFF;
        packet[3] = m_rtpSeq & 0xFF;
        packet[4] = (timestamp >> 24) & 0xFF;
        packet[5] = (timestamp >> 16) & 0xFF;
        packet[6] = (timestamp >> 8) & 0xFF;
        packet[7] = timestamp & 0xFF;
        packet[8] = (m_rtpSsrc >> 24) & 0xFF;
        packet[9] = (m_rtpSsrc >> 16) & 0xFF;
        packet[10] = (m_rtpSsrc >> 8) & 0xFF;
        packet[11] = m_rtpSsrc & 0xFF;
        std::memcpy(packet + 12, opusData, opusLen);
        ++m_rtpSeq;

        sockaddr_in dest {};
        dest.sin_family = AF_INET;
        dest.sin_port = htons((uint16_t) m_rtpPort);
        inet_pton(AF_INET, m_rtpHost.c_str(), &dest.sin_addr);

        int sent = (int) sendto(m_rtpSock, (const char*) packet, (int) (12 + opusLen), 0,
                                (sockaddr*) &dest, sizeof(dest));
        if (sent > 0) {
            m_bytesTransmitted += (uint64_t) sent;
            return true;
        }
        return false;
    }

    void sendPresence(int sock, bool streaming)
    {
        const std::string sid = m_sessionManager.getSessionId();
        if (sid.empty() || sock < 0)
            return;
        const std::string json =
            std::string("{\"type\":\"PRESENCE\",\"sessionId\":\"") + sid +
            "\",\"streaming\":" + (streaming ? "true" : "false") + "}";
        sendWsText(sock, json);
    }

    void networkWorkerLoop()
    {
        ServerAddress addr = parseEndpoint(m_serverEndpoint);

        int wsSock = -1;
        bool streamingActive = false;
        uint32_t rtpTimestamp = 0;

#if LMS_HAS_OPUS
        int err = 0;
        OpusEncoder* encoder = opus_encoder_create(48000, 2, OPUS_APPLICATION_AUDIO, &err);
        if (encoder && err == OPUS_OK) {
            opus_encoder_ctl(encoder, OPUS_SET_BITRATE(128000));
            opus_encoder_ctl(encoder, OPUS_SET_COMPLEXITY(5));
        } else {
            encoder = nullptr;
        }
#else
        void* encoder = nullptr;
#endif

        std::vector<float> pcmScratch(2048 * 2);
        std::vector<float> pcmAccum;
        pcmAccum.reserve(960 * 2 * 4);
        size_t accumFrames = 0;
        std::vector<uint8_t> opusBuf(4000);
        auto lastRegister = std::chrono::steady_clock::now() - std::chrono::seconds(10);
        auto lastPresence = std::chrono::steady_clock::now() - std::chrono::seconds(10);

        while (m_isRunning) {
            if (wsSock < 0) {
                wsSock = connectSocket(addr.host, addr.port);
                if (wsSock < 0) {
                    m_isConnected = false;
                    m_sessionManager.setPluginConnected(false);
                    std::this_thread::sleep_for(std::chrono::milliseconds(1000));
                    continue;
                }

                std::string instanceId, trackName, groupId;
                {
                    std::lock_guard<std::mutex> lock(m_metaMutex);
                    instanceId = m_instanceId;
                    trackName = m_trackName;
                    groupId = m_groupId;
                }

                std::string path = "/ws?role=plugin&instanceId=" + instanceId;
                if (!wsHandshake(wsSock, addr, path)) {
                    closeSocket(wsSock);
                    wsSock = -1;
                    std::this_thread::sleep_for(std::chrono::milliseconds(1000));
                    continue;
                }

                m_isConnected = true;
                m_sessionManager.setPluginConnected(true);
                if (! m_wantStream.load())
                    m_sessionManager.setState(SessionState::Created);

                {
                    auto& cfg = m_sessionManager.getConfig();
                    std::string requested = m_sessionManager.getRequestedSessionId();
                    if (requested.empty()) requested = m_sessionManager.getSessionId();
                    std::string body = std::string("{\"title\":\"") + cfg.title + "\"";
                    if (!requested.empty())
                        body += ",\"sessionId\":\"" + requested + "\"";
                    body += ",\"quality\":\"" + cfg.quality +
                            "\",\"sampleRate\":" + std::to_string((int) cfg.sampleRate) +
                            ",\"channels\":" + std::to_string(cfg.numChannels) + "}";
                    std::string resp;
                    if (httpPostJson(addr, "/api/session", body, resp)
                        && resp.find("\"success\":true") != std::string::npos) {
                        std::string sessionId = extractJsonString(resp, "sessionId");
                        std::string token = extractJsonString(resp, "token");
                        std::string listenerUrl = extractJsonString(resp, "listenerUrl");
                        if (listenerUrl.empty() && !sessionId.empty())
                            listenerUrl = m_serverEndpoint + "/s/" + sessionId;
                        m_sessionManager.setSessionInfo(sessionId, token, listenerUrl);
                        m_sessionManager.setRequestedSessionId(sessionId);
                    }
                }

                m_metaDirty = true;
                sendPresence(wsSock, m_wantStream.load());
            }

            auto now = std::chrono::steady_clock::now();
            const std::string sessionId = m_sessionManager.getSessionId();
            if (!sessionId.empty() && (m_metaDirty || now - lastRegister > std::chrono::seconds(5))) {
                std::string instanceId, trackName, groupId;
                PluginMode mode;
                {
                    std::lock_guard<std::mutex> lock(m_metaMutex);
                    instanceId = m_instanceId;
                    trackName = m_trackName;
                    groupId = m_groupId;
                    mode = m_mode;
                }
                m_metaDirty = false;
                std::string reg =
                    std::string("{\"type\":\"HIERARCHY_REGISTER\",\"instanceId\":\"") + instanceId +
                    "\",\"trackName\":\"" + trackName +
                    "\",\"groupId\":\"" + groupId +
                    "\",\"sessionId\":\"" + sessionId +
                    "\",\"mode\":\"" + pluginModeToString(mode) +
                    "\",\"pluginVersion\":\"1.0.0\",\"os\":\"" +
#ifdef _WIN32
                    "Windows"
#elif defined(__APPLE__)
                    "macOS"
#else
                    "Linux"
#endif
                    + "\"}";
                sendWsText(wsSock, reg);
                sendPresence(wsSock, m_wantStream.load() || streamingActive);
                lastRegister = now;
            }

            if (now - lastPresence > std::chrono::seconds(2)) {
                sendPresence(wsSock, m_wantStream.load() || streamingActive);
                lastPresence = now;
            }

            // Start / stop streaming session
            if (m_wantStream && !streamingActive) {
                m_sessionManager.setState(SessionState::Connecting);
                auto& cfg = m_sessionManager.getConfig();
                std::string requested = m_sessionManager.getSessionId();
                std::string body = std::string("{\"title\":\"") + cfg.title +
                    "\",\"quality\":\"" + cfg.quality +
                    "\",\"sampleRate\":" + std::to_string((int) cfg.sampleRate) +
                    ",\"channels\":" + std::to_string(cfg.numChannels);
                if (!requested.empty())
                    body += ",\"sessionId\":\"" + requested + "\"";
                body += "}";

                std::string resp;
                if (httpPostJson(addr, "/api/session", body, resp)) {
                    std::string sessionId = extractJsonString(resp, "sessionId");
                    std::string token = extractJsonString(resp, "token");
                    std::string listenerUrl = extractJsonString(resp, "listenerUrl");
                    if (listenerUrl.empty() && !sessionId.empty())
                        listenerUrl = m_serverEndpoint + "/s/" + sessionId;
                    m_sessionManager.setSessionInfo(sessionId, token, listenerUrl);

                    // Request plain RTP transport for plugin producer
                    std::string produceReq =
                        std::string("{\"type\":\"PRODUCE_PLAIN\",\"sessionId\":\"") + sessionId +
                        "\",\"token\":\"" + token +
                        "\",\"sampleRate\":" + std::to_string((int) cfg.sampleRate) +
                        ",\"channels\":" + std::to_string(cfg.numChannels) +
                        ",\"bitrate\":" + std::to_string(cfg.bitrateKbps) + "}";
                    sendWsText(wsSock, produceReq);

                    // Also open transmitter WS role for control/telemetry
                    // Media goes via RTP; control stays on plugin socket.
                    streamingActive = true;
                    m_sessionManager.setState(SessionState::Live);
                    m_sessionManager.setBitrate(cfg.bitrateKbps);
                    sendPresence(wsSock, true);

                    if (m_rtpSock < 0) {
                        m_rtpSock = (int) socket(AF_INET, SOCK_DGRAM, 0);
                    }

#if LMS_HAS_OPUS
                    if (encoder) {
                        int br = cfg.quality == "Efficient" ? 64000 : 128000;
                        opus_encoder_ctl(encoder, OPUS_SET_BITRATE(br));
                    }
#endif
                } else {
                    m_sessionManager.setState(SessionState::Disconnected);
                    m_wantStream = false;
                }
            }

            if (!m_wantStream && streamingActive) {
                sendWsText(wsSock, "{\"type\":\"STOP_PRODUCE\"}");
                sendPresence(wsSock, false);
                streamingActive = false;
                m_hasRtpTarget = false;
                m_sessionManager.setState(SessionState::Created);
            }

            // Encode and send audio when streaming
            if (streamingActive) {
                // Pull whatever is queued; accumulate to 20ms (960 @ 48k) Opus frames.
                // IMPORTANT: never discard partial reads — DAW blocks are often 128–512 frames.
                size_t frames = m_audioQueue.read(pcmScratch.data(), 1024);
                if (frames > 0) {
                    const size_t samples = frames * 2;
                    const size_t oldSamples = accumFrames * 2;
                    pcmAccum.resize(oldSamples + samples);
                    std::memcpy(pcmAccum.data() + oldSamples, pcmScratch.data(), samples * sizeof(float));
                    accumFrames += frames;

                    // Always fan-out PCM to listeners over WebSocket (reliable browser path)
                    sendWsBinary(wsSock,
                                 reinterpret_cast<const uint8_t*>(pcmScratch.data()),
                                 samples * sizeof(float));
                    m_bytesTransmitted += samples * sizeof(float);
                    ++m_packetsSent;
                }

                const size_t frameSize = 960; // Opus packet size at 48kHz
                const double sr = m_sessionManager.getConfig().sampleRate;
                const bool opusOk = (std::abs(sr - 48000.0) < 1.0);

                while (accumFrames >= frameSize) {
#if LMS_HAS_OPUS
                    if (encoder && opusOk && m_hasRtpTarget) {
                        int encoded = opus_encode_float(encoder, pcmAccum.data(), (int) frameSize,
                                                        opusBuf.data(), (int) opusBuf.size());
                        if (encoded > 0) {
                            sendRtpOpus(opusBuf.data(), (size_t) encoded, rtpTimestamp);
                            rtpTimestamp += (uint32_t) frameSize;
                        }
                    }
#endif
                    // Shift accumulator left by one Opus frame
                    const size_t remainFrames = accumFrames - frameSize;
                    if (remainFrames > 0) {
                        std::memmove(pcmAccum.data(),
                                     pcmAccum.data() + frameSize * 2,
                                     remainFrames * 2 * sizeof(float));
                    }
                    accumFrames = remainFrames;
                    pcmAccum.resize(accumFrames * 2);
                }

                if (m_packetsSent > 0 && m_packetsSent % 50 == 0)
                    m_sessionManager.updateTelemetry(m_activeListeners, m_effectiveLatencyMs, 0.0f, m_bytesTransmitted);
            } else {
                accumFrames = 0;
                pcmAccum.clear();
            }

            pollWs(wsSock);
            if (wsSock >= 0) {
                std::vector<std::string> pending;
                {
                    std::lock_guard<std::mutex> lock(m_outMutex);
                    pending.swap(m_outbox);
                }
                for (const auto& json : pending)
                    sendWsText(wsSock, json);
            }
            std::this_thread::sleep_for(std::chrono::milliseconds(streamingActive ? 5 : 20));
        }

#if LMS_HAS_OPUS
        if (encoder) opus_encoder_destroy(encoder);
#endif
        if (m_rtpSock >= 0) { closeSocket(m_rtpSock); m_rtpSock = -1; }
        if (wsSock >= 0) closeSocket(wsSock);
        m_isConnected = false;
        m_sessionManager.setPluginConnected(false);
        m_sessionManager.setState(SessionState::Disconnected);
    }

    LockFreeAudioQueue& m_audioQueue;
    SessionManager& m_sessionManager;
    std::thread m_networkThread;
    std::atomic<bool> m_isRunning { false };
    std::atomic<bool> m_isConnected { false };
    std::atomic<bool> m_wantStream { false };
    std::atomic<PluginMode> m_mode { PluginMode::TrackControl };

    std::mutex m_metaMutex;
    std::string m_instanceId;
    std::string m_trackName { "Track" };
    std::string m_groupId { "default" };
    HierarchyCallback m_hierarchyCallback;
    std::atomic<bool> m_metaDirty { true };

    std::mutex m_outMutex;
    std::vector<std::string> m_outbox;

    std::string m_serverEndpoint;
    uint64_t m_bytesTransmitted = 0;
    uint64_t m_packetsSent = 0;
    int m_activeListeners = 0;
    int m_effectiveLatencyMs = 0;

    int m_rtpSock = -1;
    bool m_hasRtpTarget = false;
    std::string m_rtpHost;
    int m_rtpPort = 0;
    uint32_t m_rtpSsrc = 0x12345678;
    uint16_t m_rtpSeq = 0;
    uint8_t m_rtpPayloadType = 111;
};

} // namespace LiveMixStream
