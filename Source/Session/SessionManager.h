#pragma once
#include <juce_core/juce_core.h>
#include <cstdlib>
#include <cctype>
#include <mutex>
#include <atomic>

namespace LiveMixStream {

enum class SessionState {
    Created,
    Connecting,
    Live,
    Paused,
    Disconnected,
    Expired
};

struct SessionConfig {
    std::string serverUrl = "http://localhost:3001";
    std::string title = "My DAW Mix Session";
    std::string quality = "High";
    double sampleRate = 48000.0;
    int numChannels = 2;
    int bitrateKbps = 256;
    int targetLatencyMs = 200;
};

struct StreamTelemetry {
    int activeListeners = 0;
    int roundTripLatencyMs = 0;
    int bitrateKbps = 256;
    float packetLossPercent = 0.0f;
    uint64_t bytesTransmitted = 0;
};

class SessionManager {
public:
    SessionManager()
        : m_state(SessionState::Disconnected)
    {
        loadServerUrlConfig();
        ensurePersistentSessionId();
    }

    void ensurePersistentSessionId()
    {
        std::lock_guard<std::mutex> lock (m_mutex);
        if (! m_requestedSessionId.empty() || ! m_sessionId.empty())
        {
            if (m_requestedSessionId.empty())
                m_requestedSessionId = m_sessionId;
            return;
        }
        m_requestedSessionId = juce::Uuid().toDashedString().removeCharacters ("-")
                                      .substring (0, 12).toUpperCase().toStdString();
    }

    void setTargetLatencyMs(int ms) {
        m_config.targetLatencyMs = ms;
        m_telemetry.roundTripLatencyMs = ms;
    }

    int getTargetLatencyMs() const { return m_config.targetLatencyMs; }

    void loadServerUrlConfig() {
        const char* envUrl = std::getenv("LIVEMIXSTREAM_SERVER_URL");
        if (envUrl && envUrl[0] != '\0') {
            m_config.serverUrl = envUrl;
            return;
        }

        juce::File configFile = juce::File::getSpecialLocation(juce::File::userHomeDirectory)
                                   .getChildFile(".config/livemixstream/server.url");
        if (configFile.existsAsFile()) {
            auto content = configFile.loadFileAsString().trim().toStdString();
            if (!content.empty()) {
                m_config.serverUrl = content;
            }
        }
    }

    void saveServerUrlConfig(const std::string& url) {
        m_config.serverUrl = url;
        juce::File configFile = juce::File::getSpecialLocation(juce::File::userHomeDirectory)
                                   .getChildFile(".config/livemixstream/server.url");
        configFile.getParentDirectory().createDirectory();
        configFile.replaceWithText(url);
    }

    std::string getServerUrl() const { return m_config.serverUrl; }

    void setSessionInfo(const std::string& id, const std::string& token, const std::string& url) {
        std::lock_guard<std::mutex> lock (m_mutex);
        m_sessionId = id;
        if (! id.empty())
            m_requestedSessionId = id;
        m_authToken = token;
        m_listenerUrl = url;
    }

    std::string getSessionId() const {
        std::lock_guard<std::mutex> lock (m_mutex);
        return m_sessionId.empty() ? m_requestedSessionId : m_sessionId;
    }
    std::string getRequestedSessionId() const {
        std::lock_guard<std::mutex> lock (m_mutex);
        return m_requestedSessionId.empty() ? m_sessionId : m_requestedSessionId;
    }
    void setRequestedSessionId(const std::string& id) {
        std::lock_guard<std::mutex> lock (m_mutex);
        m_requestedSessionId = id;
        for (auto& c : m_requestedSessionId) c = (char) std::toupper((unsigned char) c);
        if (m_sessionId.empty())
            m_sessionId = m_requestedSessionId;
    }
    std::string getAuthToken() const {
        std::lock_guard<std::mutex> lock (m_mutex);
        return m_authToken;
    }
    std::string getListenerUrl() const {
        std::lock_guard<std::mutex> lock (m_mutex);
        if (! m_listenerUrl.empty())
            return m_listenerUrl;
        const auto id = m_sessionId.empty() ? m_requestedSessionId : m_sessionId;
        if (id.empty())
            return {};
        auto base = m_config.serverUrl;
        if (! base.empty() && base.back() == '/')
            base.pop_back();
        return base + "/s/" + id;
    }

    void setState(SessionState state) { m_state = state; }
    SessionState getState() const { return m_state; }

    std::string getStateString() const {
        switch (m_state) {
            case SessionState::Created: return "CREATED";
            case SessionState::Connecting: return "CONNECTING";
            case SessionState::Live: return "LIVE";
            case SessionState::Paused: return "PAUSED";
            case SessionState::Disconnected: return "DISCONNECTED";
            case SessionState::Expired: return "EXPIRED";
            default: return "UNKNOWN";
        }
    }

    void updateTelemetry(int listeners, int latency, float loss, uint64_t bytes) {
        m_telemetry.activeListeners = listeners;
        m_telemetry.roundTripLatencyMs = latency;
        m_telemetry.packetLossPercent = loss;
        m_telemetry.bytesTransmitted = bytes;
    }

    void setBitrate(int kbps) { m_telemetry.bitrateKbps = kbps; m_config.bitrateKbps = kbps; }

    StreamTelemetry getTelemetry() const { return m_telemetry; }
    SessionConfig& getConfig() { return m_config; }
    const SessionConfig& getConfig() const { return m_config; }

    bool isPluginConnected() const { return m_pluginConnected.load(); }
    void setPluginConnected(bool v) { m_pluginConnected.store(v); }

private:
    mutable std::mutex m_mutex;
    std::string m_sessionId;
    std::string m_requestedSessionId;
    std::string m_authToken;
    std::string m_listenerUrl;
    std::atomic<SessionState> m_state;
    SessionConfig m_config;
    StreamTelemetry m_telemetry;
    std::atomic<bool> m_pluginConnected { false };
};

} // namespace LiveMixStream
