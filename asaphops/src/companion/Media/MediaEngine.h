#pragma once

#include <juce_core/juce_core.h>
#include <juce_events/juce_events.h>
#include <functional>
#include "../../shared/SharedMemoryFifo.h"

namespace AsaphOps {

class SessionManager;

class MediaEngine : public juce::Thread,
                    public juce::ChangeBroadcaster
{
public:
    explicit MediaEngine (SessionManager& sessions);
    ~MediaEngine() override;

    void setListenServerUrl (const juce::String& url);
    void setOpsReady (bool ready);
    void attachMaster (const juce::String& connectionId,
                       const juce::String& shmName,
                       uint32_t sampleRate,
                       uint32_t channels,
                       uint32_t capacityFrames);
    void startMaster (const juce::String& connectionId);
    void stopMaster (const juce::String& connectionId);

    bool isReceiving() const { return receiving.load(); }
    bool isStreaming() const { return streaming.load(); }
    juce::String getListenUrl() const;

    std::function<void (const juce::String&)> onListenUrl;

    void run() override;

private:
    void networkTick();
    void closeSockets();

    SessionManager& sessions;
    SharedMemoryFifo fifo;
    juce::String listenServerUrl { "http://localhost:3100" };
    juce::String masterConnectionId;
    juce::String listenUrl;
    juce::String sessionId;
    juce::String sessionToken;
    mutable juce::CriticalSection lock;
    std::atomic<bool> opsReady { false };
    std::atomic<bool> wantStream { false };
    std::atomic<bool> receiving { false };
    std::atomic<bool> streaming { false };
    std::atomic<uint32_t> hostSampleRate { 48000 };
    int wsSock = -1;
    int rtpSock = -1;
    bool hasRtp = false;
    juce::String rtpHost;
    int rtpPort = 0;
    uint32_t rtpSsrc = 0x41305348;
    uint16_t rtpSeq = 0;
    uint8_t rtpPt = 111;
    uint32_t rtpTimestamp = 0;
    int framesWithoutAudio = 0;
};

} // namespace AsaphOps
