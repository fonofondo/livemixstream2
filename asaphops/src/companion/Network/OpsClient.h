#pragma once

#include <juce_core/juce_core.h>
#include <juce_events/juce_events.h>
#include <functional>
#include <memory>
#include "../../shared/Paths.h"
#include "LiveConnection.h"

namespace AsaphOps {

struct OpsSettings
{
    juce::String serverUrl { "http://localhost:3100" };
    juce::String token;
    juce::String email;
    juce::String personName;
    juce::String endpointId;
    juce::String endpointCode;
    juce::String endpointStatus;
    bool autostart = false;
    float mackieDuckDb = -14.0f;
};

class OpsClient : public juce::ChangeBroadcaster
{
public:
    OpsClient();
    ~OpsClient() override;

    void load();
    void save() const;

    OpsSettings getSettings() const;
    void setServerUrl (const juce::String& url);
    void setMackieDuckDb (float db);
    void setAutostart (bool enabled);

    juce::String getLastError() const;
    juce::String getLastDebug() const;
    juce::String getLiveStatus() const;
    bool isLoggedIn() const;
    bool isLiveConnected() const;

    bool login (const juce::String& email, const juce::String& password);
    void logout();
    bool registerEndpoint();
    bool goOffline();
    void startLive();
    void stopLive();
    void sendLiveLine (const juce::String& line);
    void setLiveLineHandler (std::function<void (juce::String)> handler);

private:
    juce::var postJson (const juce::String& path, const juce::var& body, int* statusOut = nullptr);
    juce::var makeRegisterBody() const;
    void storeDebug (const juce::String& text);

    OpsSettings settings;
    juce::String lastError;
    juce::String lastDebug;
    mutable juce::CriticalSection lock;
    std::unique_ptr<LiveConnection> live;
    std::function<void (juce::String)> liveLineHandler;
};

} // namespace AsaphOps
