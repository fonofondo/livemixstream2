#include "MediaEngine.h"
#include "../SessionManager/SessionManager.h"
#include <cstring>
#include <cstddef>
#include <vector>
#include <cmath>

#if __has_include(<opus/opus.h>)
 #include <opus/opus.h>
 #define ASAPHOPS_HAS_OPUS 1
#else
 #define ASAPHOPS_HAS_OPUS 0
#endif

#ifdef _WIN32
 #include <winsock2.h>
 #include <ws2tcpip.h>
 using socklen_t = int;
#else
 #include <arpa/inet.h>
 #include <fcntl.h>
 #include <netdb.h>
 #include <netinet/in.h>
 #include <signal.h>
 #include <sys/socket.h>
 #include <unistd.h>
#endif

namespace AsaphOps {

namespace {

void closeSock (int sock)
{
    if (sock < 0) return;
#ifdef _WIN32
    closesocket (sock);
#else
    close (sock);
#endif
}

int connectTcp (const juce::String& host, int port)
{
    int sock = (int) socket (AF_INET, SOCK_STREAM, 0);
    if (sock < 0) return -1;
#ifndef _WIN32
    timeval tv { 3, 0 };
    setsockopt (sock, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof (tv));
    setsockopt (sock, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof (tv));
#endif
    sockaddr_in addr {};
    addr.sin_family = AF_INET;
    addr.sin_port = htons ((uint16_t) port);
    auto hostUtf = host.toRawUTF8();
    if (inet_pton (AF_INET, hostUtf, &addr.sin_addr) <= 0)
    {
        hostent* hp = gethostbyname (hostUtf);
        if (hp == nullptr) { closeSock (sock); return -1; }
        std::memcpy (&addr.sin_addr, hp->h_addr, (size_t) hp->h_length);
    }
    if (connect (sock, (sockaddr*) &addr, sizeof (addr)) < 0)
    {
        closeSock (sock);
        return -1;
    }
    return sock;
}

bool sendAll (int sock, const void* data, size_t len)
{
    if (sock < 0) return false;
#ifdef _WIN32
    return send (sock, (const char*) data, (int) len, 0) == (int) len;
#else
    return send (sock, data, len, MSG_NOSIGNAL) == (ssize_t) len;
#endif
}

void parseUrl (const juce::String& url, juce::String& host, int& port)
{
    host = "127.0.0.1";
    port = 3100;
    auto u = juce::URL (url.trim());
    if (u.getDomain().isNotEmpty())
        host = u.getDomain();
    if (host == "localhost")
        host = "127.0.0.1";
    port = u.getPort();
    if (port <= 0)
        port = 3100;
}

juce::String extractJsonString (const juce::String& src, const juce::String& key)
{
    auto needle = "\"" + key + "\":\"";
    auto pos = src.indexOf (needle);
    if (pos < 0) return {};
    pos += needle.length();
    auto end = src.indexOfChar (pos, '"');
    if (end < 0) return {};
    return src.substring (pos, end);
}

int extractJsonInt (const juce::String& src, const juce::String& key, int fallback)
{
    auto needle = "\"" + key + "\":";
    auto pos = src.indexOf (needle);
    if (pos < 0) return fallback;
    pos += needle.length();
    while (pos < src.length() && (src[pos] == ' ' || src[pos] == '"'))
        ++pos;
    return src.substring (pos).getIntValue();
}

bool sendWsText (int sock, const juce::String& text)
{
    auto utf = text.toRawUTF8();
    auto len = (uint32_t) std::strlen (utf);
    std::vector<uint8_t> frame;
    frame.push_back (0x81);
    if (len <= 125)
        frame.push_back ((uint8_t) (0x80 | len));
    else if (len <= 65535)
    {
        frame.push_back (0x80 | 126);
        frame.push_back ((uint8_t) (len >> 8));
        frame.push_back ((uint8_t) len);
    }
    else
        return false;
    uint8_t mask[4] = { 0x11, 0x22, 0x33, 0x44 };
    frame.insert (frame.end(), mask, mask + 4);
    for (uint32_t i = 0; i < len; ++i)
        frame.push_back ((uint8_t) utf[i] ^ mask[i % 4]);
    return sendAll (sock, frame.data(), frame.size());
}

bool sendWsBinary (int sock, const uint8_t* data, size_t len)
{
    std::vector<uint8_t> frame;
    frame.push_back (0x82);
    if (len <= 125)
        frame.push_back ((uint8_t) (0x80 | len));
    else if (len <= 65535)
    {
        frame.push_back (0x80 | 126);
        frame.push_back ((uint8_t) (len >> 8));
        frame.push_back ((uint8_t) len);
    }
    else
    {
        frame.push_back (0x80 | 127);
        for (int i = 7; i >= 0; --i)
            frame.push_back ((uint8_t) ((len >> (i * 8)) & 0xFF));
    }
    uint8_t mask[4] = { 0x12, 0x34, 0x56, 0x78 };
    frame.insert (frame.end(), mask, mask + 4);
    for (size_t i = 0; i < len; ++i)
        frame.push_back (data[i] ^ mask[i % 4]);
    return sendAll (sock, frame.data(), frame.size());
}

bool httpPostJson (const juce::String& host, int port, const juce::String& path,
                   const juce::String& body, juce::String& responseBody)
{
    int sock = connectTcp (host, port);
    if (sock < 0) return false;
    auto utf = body.toRawUTF8();
    auto n = (size_t) std::strlen (utf);
    juce::String req;
    req << "POST " << path << " HTTP/1.1\r\n"
        << "Host: " << host << ":" << port << "\r\n"
        << "Content-Type: application/json\r\n"
        << "Content-Length: " << (int) n << "\r\n"
        << "Connection: close\r\n\r\n" << body;
    auto ok = sendAll (sock, req.toRawUTF8(), (size_t) req.getNumBytesAsUTF8());
    if (ok)
    {
        char buf[8192];
        juce::String resp;
        int got;
        while ((got = (int) recv (sock, buf, sizeof (buf), 0)) > 0)
            resp += juce::String::fromUTF8 (buf, got);
        auto bodyPos = resp.indexOf ("\r\n\r\n");
        if (bodyPos >= 0)
            responseBody = resp.substring (bodyPos + 4);
    }
    closeSock (sock);
    return ok && responseBody.isNotEmpty();
}

bool wsHandshake (int sock, const juce::String& host, int port, const juce::String& path)
{
    juce::String hs;
    hs << "GET " << path << " HTTP/1.1\r\n"
       << "Host: " << host << ":" << port << "\r\n"
       << "Upgrade: websocket\r\n"
       << "Connection: Upgrade\r\n"
       << "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"
       << "Sec-WebSocket-Version: 13\r\n\r\n";
    if (! sendAll (sock, hs.toRawUTF8(), (size_t) hs.getNumBytesAsUTF8()))
        return false;
    char buf[2048] {};
    int n = (int) recv (sock, buf, sizeof (buf) - 1, 0);
    if (n <= 0) return false;
    return juce::String::fromUTF8 (buf, n).contains ("101");
}

void appendResampled48k (const float* in, int inFrames, int inSr, int channels,
                         std::vector<float>& accum)
{
    if (inFrames <= 0) return;
    if (inSr == 48000)
    {
        accum.insert (accum.end(), in, in + inFrames * channels);
        return;
    }
    const double ratio = 48000.0 / (double) juce::jmax (1, inSr);
    const int outFrames = juce::jmax (1, (int) std::llround ((double) inFrames * ratio));
    for (int i = 0; i < outFrames; ++i)
    {
        const double src = (double) i / ratio;
        const int i0 = juce::jlimit (0, inFrames - 1, (int) src);
        const int i1 = juce::jmin (inFrames - 1, i0 + 1);
        const float t = (float) (src - (double) i0);
        for (int c = 0; c < channels; ++c)
        {
            const float a = in[i0 * channels + c];
            const float b = in[i1 * channels + c];
            accum.push_back (a + (b - a) * t);
        }
    }
}

} // namespace

MediaEngine::MediaEngine (SessionManager& sessionsIn)
    : juce::Thread ("AsaphOpsMedia"),
      sessions (sessionsIn)
{
#ifndef _WIN32
    signal (SIGPIPE, SIG_IGN);
#endif
    startThread();
}

MediaEngine::~MediaEngine()
{
    signalThreadShouldExit();
    stopThread (4000);
    closeSockets();
    fifo.close();
}

void MediaEngine::setListenServerUrl (const juce::String& url)
{
    const juce::ScopedLock sl (lock);
    listenServerUrl = url.trim().isEmpty() ? juce::String ("http://localhost:3100") : url.trim();
}

void MediaEngine::setOpsReady (bool ready)
{
    opsReady = ready;
}

void MediaEngine::attachMaster (const juce::String& connectionId,
                                const juce::String& shmName,
                                uint32_t sampleRate,
                                uint32_t /*channels*/,
                                uint32_t /*capacityFrames*/)
{
    {
        const juce::ScopedLock sl (lock);
        masterConnectionId = connectionId;
        hostSampleRate = sampleRate > 0 ? sampleRate : 48000;
    }
    fifo.close();
    if (! fifo.openReader (shmName))
        juce::Logger::writeToLog ("media: failed to map shm " + shmName);
    else
        juce::Logger::writeToLog ("media: mapped master shm " + shmName);
}

void MediaEngine::startMaster (const juce::String& connectionId)
{
    {
        const juce::ScopedLock sl (lock);
        masterConnectionId = connectionId;
    }
    wantStream = true;
}

void MediaEngine::stopMaster (const juce::String& connectionId)
{
    juce::String current;
    {
        const juce::ScopedLock sl (lock);
        current = masterConnectionId;
    }
    if (current != connectionId && current.isNotEmpty())
        return;
    wantStream = false;
    receiving = false;
    streaming = false;
    fifo.close();
    sessions.updateSession (connectionId, [] (PluginSession& s)
    {
        s.streaming = false;
        s.receivingAudio = false;
    });
}

juce::String MediaEngine::getListenUrl() const
{
    const juce::ScopedLock sl (lock);
    return listenUrl;
}

void MediaEngine::closeSockets()
{
    closeSock (wsSock);
    wsSock = -1;
    closeSock (rtpSock);
    rtpSock = -1;
    hasRtp = false;
}

void MediaEngine::run()
{
    std::vector<float> scratch (2048 * 2);
    std::vector<float> accum;
    accum.reserve (960 * 2 * 4);
#if ASAPHOPS_HAS_OPUS
    int err = 0;
    OpusEncoder* encoder = opus_encoder_create (48000, 2, OPUS_APPLICATION_AUDIO, &err);
    if (encoder != nullptr && err == OPUS_OK)
    {
        opus_encoder_ctl (encoder, OPUS_SET_BITRATE (128000));
        opus_encoder_ctl (encoder, OPUS_SET_COMPLEXITY (5));
    }
    else
        encoder = nullptr;
#else
    void* encoder = nullptr;
#endif
    std::vector<uint8_t> opusBuf (4000);
    auto lastSessionTry = juce::Time::getMillisecondCounter() - 5000;

    while (! threadShouldExit())
    {
        juce::String url, host;
        int port = 3100;
        {
            const juce::ScopedLock sl (lock);
            url = listenServerUrl;
        }
        parseUrl (url, host, port);

        if (wsSock < 0)
        {
            wsSock = connectTcp (host, port);
            if (wsSock < 0)
            {
                wait (1000);
                continue;
            }
            if (! wsHandshake (wsSock, host, port, "/ws?role=plugin&instanceId=asaphops-companion"))
            {
                closeSockets();
                wait (1000);
                continue;
            }
            juce::Logger::writeToLog ("media: ops ws connected " + host + ":" + juce::String (port));
        }

        const bool want = wantStream.load() && opsReady.load() && fifo.isOpen();
        if (want && ! streaming.load())
        {
            const auto now = juce::Time::getMillisecondCounter();
            if (now - lastSessionTry > 2000)
            {
                lastSessionTry = now;
                juce::String body = "{\"title\":\"AsaphOps\",\"quality\":\"High\",\"sampleRate\":48000,\"channels\":2}";
                juce::String resp;
                if (httpPostJson (host, port, "/api/session", body, resp)
                    && resp.contains ("\"success\":true"))
                {
                    auto sid = extractJsonString (resp, "sessionId");
                    auto tok = extractJsonString (resp, "token");
                    auto lurl = extractJsonString (resp, "listenerUrl");
                    if (lurl.isEmpty() && sid.isNotEmpty())
                        lurl = url.trimCharactersAtEnd ("/") + "/s/" + sid;
                    {
                        const juce::ScopedLock sl (lock);
                        sessionId = sid;
                        sessionToken = tok;
                        listenUrl = lurl;
                    }
                    juce::String produce;
                    produce << "{\"type\":\"PRODUCE_PLAIN\",\"sessionId\":\"" << sid
                            << "\",\"token\":\"" << tok
                            << "\",\"sampleRate\":48000,\"channels\":2,\"bitrate\":128}";
                    sendWsText (wsSock, produce);
                    sendWsText (wsSock, "{\"type\":\"PRESENCE\",\"sessionId\":\"" + sid + "\",\"streaming\":true}");
                    if (rtpSock < 0)
                        rtpSock = (int) socket (AF_INET, SOCK_DGRAM, 0);
                    streaming = true;
                    juce::String masterId;
                    {
                        const juce::ScopedLock sl (lock);
                        masterId = masterConnectionId;
                    }
                    sessions.updateSession (masterId, [lurl] (PluginSession& s)
                    {
                        s.streaming = true;
                        s.listenUrl = lurl;
                    });
                    sendChangeMessage();
                    if (onListenUrl)
                        onListenUrl (lurl);
                    juce::Logger::writeToLog ("media: listen " + lurl);
                }
            }
        }

        if (! want && streaming.load())
        {
            sendWsText (wsSock, "{\"type\":\"STOP_PRODUCE\"}");
            streaming = false;
            hasRtp = false;
            juce::String masterId;
            {
                const juce::ScopedLock sl (lock);
                masterId = masterConnectionId;
            }
            sessions.updateSession (masterId, [] (PluginSession& s)
            {
                s.streaming = false;
            });
            sendChangeMessage();
        }

        const int got = fifo.isOpen() ? fifo.readInterleaved (scratch.data(), 1024) : 0;
        if (got > 0)
        {
            framesWithoutAudio = 0;
            if (! receiving.load())
            {
                receiving = true;
                juce::String masterId;
                {
                    const juce::ScopedLock sl (lock);
                    masterId = masterConnectionId;
                }
                sessions.updateSession (masterId, [] (PluginSession& s) { s.receivingAudio = true; });
            }
            if (streaming.load())
            {
                sendWsBinary (wsSock, reinterpret_cast<const uint8_t*> (scratch.data()),
                              (size_t) got * 2 * sizeof (float));
                appendResampled48k (scratch.data(), got, (int) hostSampleRate.load(), 2, accum);
            }
        }
        else
        {
            ++framesWithoutAudio;
            if (framesWithoutAudio > 50 && receiving.load())
            {
                receiving = false;
                juce::String masterId;
                {
                    const juce::ScopedLock sl (lock);
                    masterId = masterConnectionId;
                }
                sessions.updateSession (masterId, [] (PluginSession& s) { s.receivingAudio = false; });
            }
        }

        const size_t frameSize = 960;
        while (streaming.load() && accum.size() >= frameSize * 2)
        {
#if ASAPHOPS_HAS_OPUS
            if (encoder != nullptr && hasRtp && rtpSock >= 0)
            {
                int encoded = opus_encode_float (encoder, accum.data(), (int) frameSize,
                                                 opusBuf.data(), (int) opusBuf.size());
                if (encoded > 0)
                {
                    uint8_t packet[1500];
                    packet[0] = 0x80;
                    packet[1] = rtpPt & 0x7F;
                    packet[2] = (uint8_t) (rtpSeq >> 8);
                    packet[3] = (uint8_t) rtpSeq;
                    packet[4] = (uint8_t) (rtpTimestamp >> 24);
                    packet[5] = (uint8_t) (rtpTimestamp >> 16);
                    packet[6] = (uint8_t) (rtpTimestamp >> 8);
                    packet[7] = (uint8_t) rtpTimestamp;
                    packet[8] = (uint8_t) (rtpSsrc >> 24);
                    packet[9] = (uint8_t) (rtpSsrc >> 16);
                    packet[10] = (uint8_t) (rtpSsrc >> 8);
                    packet[11] = (uint8_t) rtpSsrc;
                    std::memcpy (packet + 12, opusBuf.data(), (size_t) encoded);
                    ++rtpSeq;
                    rtpTimestamp += (uint32_t) frameSize;
                    sockaddr_in dest {};
                    dest.sin_family = AF_INET;
                    dest.sin_port = htons ((uint16_t) rtpPort);
                    inet_pton (AF_INET, rtpHost.toRawUTF8(), &dest.sin_addr);
    sendto (rtpSock, (const char*) packet, (int) (12 + encoded), 0, (sockaddr*) &dest, sizeof (dest));
                }
            }
#endif
            accum.erase (accum.begin(), accum.begin() + (ptrdiff_t) (frameSize * 2));
        }

        if (! streaming.load())
            accum.clear();

        uint8_t rx[4096];
#ifndef _WIN32
        int n = (int) recv (wsSock, rx, sizeof (rx), MSG_DONTWAIT);
#else
        u_long mode = 1;
        ioctlsocket (wsSock, FIONBIO, &mode);
        int n = recv (wsSock, (char*) rx, sizeof (rx), 0);
        mode = 0;
        ioctlsocket (wsSock, FIONBIO, &mode);
#endif
        if (n > 0)
        {
            const uint8_t opcode = rx[0] & 0x0F;
            if (opcode == 0x09)
            {
                uint8_t pong[6] = { 0x8A, 0x80, 0x12, 0x34, 0x56, 0x78 };
                sendAll (wsSock, pong, sizeof (pong));
            }
            else if (opcode == 0x01)
            {
                size_t offset = 2;
                size_t payloadLen = rx[1] & 0x7F;
                if (payloadLen == 126 && n >= 4)
                {
                    payloadLen = (size_t (rx[2]) << 8) | rx[3];
                    offset = 4;
                }
                juce::String msg;
                if (offset + payloadLen <= (size_t) n)
                    msg = juce::String::fromUTF8 ((char*) rx + offset, (int) payloadLen);
                else
                    msg = juce::String::fromUTF8 ((char*) rx, n);
                if (msg.contains ("PLAIN_TRANSPORT") && ! msg.contains ("FALLBACK"))
                {
                    rtpHost = extractJsonString (msg, "ip");
                    if (rtpHost.isEmpty())
                        rtpHost = extractJsonString (msg, "host");
                    rtpPort = extractJsonInt (msg, "port", rtpPort);
                    rtpSsrc = (uint32_t) extractJsonInt (msg, "ssrc", (int) rtpSsrc);
                    rtpPt = (uint8_t) extractJsonInt (msg, "payloadType", rtpPt);
                    hasRtp = rtpHost.isNotEmpty() && rtpPort > 0;
                }
            }
        }
        else if (n == 0)
        {
            closeSockets();
        }

        wait (want ? 5 : 20);
    }

#if ASAPHOPS_HAS_OPUS
    if (encoder != nullptr)
        opus_encoder_destroy (encoder);
#endif
    closeSockets();
}

} // namespace AsaphOps
