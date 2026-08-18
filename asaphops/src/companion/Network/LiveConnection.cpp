#include "LiveConnection.h"
#include <cstring>
#include <functional>

namespace AsaphOps {

namespace {

void setStatusLocked (juce::String& dest, juce::CriticalSection& lock, const juce::String& text)
{
    const juce::ScopedLock sl (lock);
    dest = text;
}

bool readAvailable (juce::StreamingSocket& sock, juce::String& buffer, int timeoutMs)
{
    const int ready = sock.waitUntilReady (true, timeoutMs);
    if (ready < 0)
        return false;
    if (ready == 0)
        return true;

    char tmp[2048];
    const int n = sock.read (tmp, (int) sizeof (tmp), false);
    if (n <= 0)
        return false;
    buffer += juce::String::fromUTF8 (tmp, n);
    return true;
}

} // namespace

LiveConnection::LiveConnection()
    : juce::Thread ("AsaphOpsLive")
{
}

LiveConnection::~LiveConnection()
{
    disconnect();
}

void LiveConnection::connectTo (const juce::String& newUrl,
                                const juce::String& newToken,
                                const juce::String& newMachineId)
{
    disconnect();
    {
        const juce::ScopedLock sl (lock);
        serverUrl = newUrl;
        token = newToken;
        machineId = newMachineId;
        status = "connecting";
    }
    wantConnected = true;
    live = false;
    startThread();
}

void LiveConnection::disconnect()
{
    wantConnected = false;
    stopThread (8000);
    live = false;
    {
        const juce::ScopedLock sl (lock);
        outbound.clear();
        status = "offline";
    }
}

juce::String LiveConnection::getStatus() const
{
    const juce::ScopedLock sl (lock);
    return status;
}

void LiveConnection::setIncomingHandler (std::function<void (juce::String)> handler)
{
    const juce::ScopedLock sl (lock);
    incoming = std::move (handler);
}

void LiveConnection::sendLine (const juce::String& line)
{
    auto text = line.trimEnd();
    if (text.isEmpty())
        return;
    if (! text.endsWithChar ('\n'))
        text += "\n";
    const juce::ScopedLock sl (lock);
    if (text.startsWith ("MIDI "))
    {
        int midiLines = 0;
        for (auto& existing : outbound)
            if (existing.startsWith ("MIDI "))
                ++midiLines;
        if (midiLines >= 512)
            return;
    }
    if (text.startsWith ("PORT "))
    {
        for (int i = outbound.size(); --i >= 0;)
            if (outbound[i].startsWith ("PORT "))
                outbound.remove (i);
    }
    outbound.add (text);
}

bool LiveConnection::writeText (juce::StreamingSocket& sock, const juce::String& text)
{
    const auto* utf = text.toRawUTF8();
    const int n = (int) std::strlen (utf);
    return sock.write (utf, n) == n;
}

void LiveConnection::run()
{
    int backoffMs = 500;
    while (! threadShouldExit() && wantConnected.load())
    {
        setStatusLocked (status, lock, live.load() ? "live" : "connecting");
        if (runSession())
            backoffMs = 500;
        live = false;
        if (threadShouldExit() || ! wantConnected.load())
            break;
        {
            const juce::ScopedLock sl (lock);
            juce::Logger::writeToLog ("ops live socket dropped (" + status + "); retrying");
        }
        setStatusLocked (status, lock, "reconnecting");
        wait ((int) backoffMs);
        backoffMs = juce::jmin (backoffMs * 2, 8000);
    }
    live = false;
    setStatusLocked (status, lock, "offline");
}

bool LiveConnection::runSession()
{
    juce::String urlCopy, tokenCopy, machineCopy;
    {
        const juce::ScopedLock sl (lock);
        urlCopy = serverUrl;
        tokenCopy = token;
        machineCopy = machineId;
    }

    const juce::URL url (urlCopy.trim());
    const auto scheme = url.getScheme().toLowerCase();
    if (scheme != "http")
    {
        setStatusLocked (status, lock, "live socket needs http:// (not https)");
        juce::Logger::writeToLog ("ops live socket: only http:// is supported");
        wait (4000);
        return false;
    }

    auto host = url.getDomain();
    if (host == "localhost")
        host = "127.0.0.1";
    int port = url.getPort();
    if (port <= 0)
        port = 80;

    juce::StreamingSocket sock;
    if (! sock.connect (host, port, 3000))
        return false;

    juce::String leftover;
    if (! handshake (sock, leftover))
        return false;

    if (! writeText (sock, "HELLO " + machineCopy + "\n"))
        return false;

    live = true;
    setStatusLocked (status, lock, "live");
    juce::Logger::writeToLog ("ops live socket connected " + host + ":" + juce::String (port));

    juce::String buffer = leftover;
    auto lastPing = juce::Time::getMillisecondCounter();

    while (! threadShouldExit() && wantConnected.load())
    {
        if (! readAvailable (sock, buffer, 200))
        {
            setStatusLocked (status, lock, "read failed / server closed");
            return true;
        }

        while (true)
        {
            const int nl = buffer.indexOfChar ('\n');
            if (nl < 0)
                break;
            const auto line = buffer.substring (0, nl).trim();
            buffer = buffer.substring (nl + 1);
            if (line == "PING")
            {
                lastPing = juce::Time::getMillisecondCounter();
                if (! writeText (sock, "PONG\n"))
                {
                    setStatusLocked (status, lock, "pong write failed");
                    return true;
                }
            }
            else if (line.startsWith ("ERROR"))
            {
                juce::Logger::writeToLog ("ops live socket: " + line);
                setStatusLocked (status, lock, line);
                return true;
            }
            else if (line.isNotEmpty())
            {
                std::function<void (juce::String)> handler;
                {
                    const juce::ScopedLock sl (lock);
                    handler = incoming;
                }
                if (handler)
                    handler (line);
            }
        }

        juce::StringArray flush;
        {
            const juce::ScopedLock sl (lock);
            flush = outbound;
            outbound.clear();
        }
        if (flush.size() > 0)
        {
            juce::String blob;
            for (auto& out : flush)
                blob += out;
            if (! writeText (sock, blob))
            {
                setStatusLocked (status, lock, "midi write failed (" + juce::String (flush.size()) + " lines)");
                return true;
            }
            lastPing = juce::Time::getMillisecondCounter();
        }

        if (juce::Time::getMillisecondCounter() - lastPing > 20000)
        {
            setStatusLocked (status, lock, "ping timeout");
            juce::Logger::writeToLog ("ops live socket: ping timeout");
            return true;
        }
    }

    return true;
}

bool LiveConnection::handshake (juce::StreamingSocket& sock, juce::String& leftover)
{
    juce::String hostHeader;
    int port = 80;
    {
        const juce::ScopedLock sl (lock);
        const juce::URL url (serverUrl.trim());
        hostHeader = url.getDomain();
        port = url.getPort();
        if (port <= 0)
            port = 80;
    }

    juce::String tokenCopy;
    {
        const juce::ScopedLock sl (lock);
        tokenCopy = token;
    }

    juce::String req;
    req << "GET /api/companion/live HTTP/1.1\r\n"
        << "Host: " << hostHeader << ":" << port << "\r\n"
        << "Upgrade: asaphops-live\r\n"
        << "Connection: Upgrade\r\n"
        << "Authorization: Bearer " << tokenCopy << "\r\n"
        << "\r\n";

    if (! writeText (sock, req))
        return false;

    juce::String buffer;
    const auto deadline = juce::Time::getMillisecondCounter() + 8000;
    int headerEnd = -1;
    while (headerEnd < 0)
    {
        if (threadShouldExit() || ! wantConnected.load())
            return false;
        const int left = (int) (deadline - juce::Time::getMillisecondCounter());
        if (left <= 0)
            return false;
        if (! readAvailable (sock, buffer, juce::jmin (left, 250)))
            return false;
        headerEnd = buffer.indexOf ("\r\n\r\n");
    }

    const auto headers = buffer.substring (0, headerEnd);
    leftover = buffer.substring (headerEnd + 4);
    const auto statusLine = headers.upToFirstOccurrenceOf ("\r\n", false, false);
    if (! statusLine.contains (" 101 "))
    {
        juce::Logger::writeToLog ("ops live socket handshake failed: " + statusLine);
        return false;
    }
    return true;
}

} // namespace AsaphOps
