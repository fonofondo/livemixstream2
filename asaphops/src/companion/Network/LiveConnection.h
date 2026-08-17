#pragma once

#include <juce_core/juce_core.h>
#include <atomic>

namespace AsaphOps {

class LiveConnection : private juce::Thread
{
public:
    LiveConnection();
    ~LiveConnection() override;

    void connectTo (const juce::String& serverUrl,
                    const juce::String& token,
                    const juce::String& machineId);
    void disconnect();

    bool isSocketLive() const { return live.load(); }
    juce::String getStatus() const;

private:
    void run() override;
    bool runSession();
    bool handshake (juce::StreamingSocket& sock, juce::String& leftover);
    static bool writeText (juce::StreamingSocket& sock, const juce::String& text);

    juce::String serverUrl;
    juce::String token;
    juce::String machineId;
    juce::String status;
    std::atomic<bool> wantConnected { false };
    std::atomic<bool> live { false };
    mutable juce::CriticalSection lock;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (LiveConnection)
};

} // namespace AsaphOps
