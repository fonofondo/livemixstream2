#include "OpsClient.h"
#include "../../shared/MachineIdentity.h"

namespace AsaphOps {

OpsClient::OpsClient()
{
    load();
}

OpsClient::~OpsClient()
{
    stopLive();
}

void OpsClient::load()
{
    const juce::ScopedLock sl (lock);
    auto f = settingsFile();
    if (! f.existsAsFile())
        return;
    auto json = juce::JSON::parse (f.loadFileAsString());
    settings.serverUrl = json.getProperty ("serverUrl", settings.serverUrl).toString();
    settings.token = json.getProperty ("token", {}).toString();
    settings.email = json.getProperty ("email", {}).toString();
    settings.personName = json.getProperty ("personName", {}).toString();
    settings.endpointId = json.getProperty ("endpointId", {}).toString();
    settings.endpointCode = json.getProperty ("endpointCode", {}).toString();
    settings.endpointStatus = json.getProperty ("endpointStatus", {}).toString();
    settings.autostart = (bool) json.getProperty ("autostart", false);
    settings.mackieDuckDb = (float) (double) json.getProperty ("mackieDuckDb", -14.0);
}

void OpsClient::save() const
{
    const juce::ScopedLock sl (lock);
    auto* obj = new juce::DynamicObject();
    obj->setProperty ("serverUrl", settings.serverUrl);
    obj->setProperty ("token", settings.token);
    obj->setProperty ("email", settings.email);
    obj->setProperty ("personName", settings.personName);
    obj->setProperty ("endpointId", settings.endpointId);
    obj->setProperty ("endpointCode", settings.endpointCode);
    obj->setProperty ("endpointStatus", settings.endpointStatus);
    obj->setProperty ("autostart", settings.autostart);
    obj->setProperty ("mackieDuckDb", (double) settings.mackieDuckDb);
    settingsFile().replaceWithText (juce::JSON::toString (juce::var (obj), true));
}

OpsSettings OpsClient::getSettings() const
{
    const juce::ScopedLock sl (lock);
    return settings;
}

void OpsClient::setServerUrl (const juce::String& url)
{
    {
        const juce::ScopedLock sl (lock);
        settings.serverUrl = url.trim().isEmpty() ? juce::String ("http://localhost:3100") : url.trim();
    }
    save();
    sendChangeMessage();
}

void OpsClient::setMackieDuckDb (float db)
{
    {
        const juce::ScopedLock sl (lock);
        settings.mackieDuckDb = juce::jlimit (-60.0f, -1.0f, db);
    }
    save();
    sendChangeMessage();
}

void OpsClient::setAutostart (bool enabled)
{
    {
        const juce::ScopedLock sl (lock);
        settings.autostart = enabled;
    }
    save();
    sendChangeMessage();
}

juce::String OpsClient::getLastError() const
{
    const juce::ScopedLock sl (lock);
    return lastError;
}

juce::String OpsClient::getLastDebug() const
{
    const juce::ScopedLock sl (lock);
    return lastDebug;
}

void OpsClient::storeDebug (const juce::String& text)
{
    {
        const juce::ScopedLock sl (lock);
        lastDebug = text;
    }
    juce::Logger::writeToLog (text.replaceCharacters ("\n", " ").trim());
    sendChangeMessage();
}

bool OpsClient::isLoggedIn() const
{
    const juce::ScopedLock sl (lock);
    return settings.token.isNotEmpty();
}

bool OpsClient::isLiveConnected() const
{
    return live != nullptr && live->isSocketLive();
}

juce::String OpsClient::getLiveStatus() const
{
    if (live != nullptr)
        return live->getStatus();
    return "offline";
}

void OpsClient::startLive()
{
    juce::String url, tokenCopy, machine;
    {
        const juce::ScopedLock sl (lock);
        url = settings.serverUrl;
        tokenCopy = settings.token;
    }
    if (tokenCopy.isEmpty())
        return;
    MachineIdentity::get().loadOrCreate();
    machine = MachineIdentity::get().getMachineId();
    if (live == nullptr)
        live = std::make_unique<LiveConnection>();
    live->setIncomingHandler (liveLineHandler);
    live->connectTo (url, tokenCopy, machine);
}

void OpsClient::stopLive()
{
    if (live != nullptr)
        live->disconnect();
}

void OpsClient::sendLiveLine (const juce::String& line)
{
    if (live != nullptr)
        live->sendLine (line);
}

void OpsClient::setLiveLineHandler (std::function<void (juce::String)> handler)
{
    liveLineHandler = std::move (handler);
    if (live != nullptr)
        live->setIncomingHandler (liveLineHandler);
}

juce::var OpsClient::postJson (const juce::String& path, const juce::var& body, int* statusOut)
{
    juce::String base, tokenCopy;
    {
        const juce::ScopedLock sl (lock);
        base = settings.serverUrl;
        tokenCopy = settings.token;
    }

    const auto fullUrl = base.trimCharactersAtEnd ("/") + path;
    auto url = juce::URL (fullUrl).withPOSTData (juce::JSON::toString (body, false));

    juce::String headers = "Content-Type: application/json\r\n";
    if (tokenCopy.isNotEmpty())
        headers += "Authorization: Bearer " + tokenCopy + "\r\n";

    int status = 0;
    auto opts = juce::URL::InputStreamOptions (juce::URL::ParameterHandling::inPostData)
                    .withExtraHeaders (headers)
                    .withConnectionTimeoutMs (8000)
                    .withStatusCode (&status)
                    .withHttpRequestCmd ("POST");

    auto stream = url.createInputStream (opts);
    juce::String raw;
    if (stream != nullptr)
        raw = stream->readEntireStreamAsString();
    if (statusOut != nullptr)
        *statusOut = status;

    juce::String debug;
    debug << juce::Time::getCurrentTime().formatted ("%Y-%m-%d %H:%M:%S") << "\n"
          << "POST " << fullUrl << "\n"
          << "HTTP status: " << (status == 0 ? juce::String ("(no response / connection failed)") : juce::String (status)) << "\n"
          << "Stream: " << (stream != nullptr ? "ok" : "null") << "\n";
    if (path.containsIgnoreCase ("login"))
        debug << "Email: " << body.getProperty ("email", {}).toString() << "\n"
              << "Password length: " << body.getProperty ("password", {}).toString().length() << "\n";
    debug << "Response (" << raw.length() << " bytes):\n"
          << (raw.isEmpty() ? juce::String ("<empty>") : raw.substring (0, 2000));
    if (raw.length() > 2000)
        debug << "\n... truncated";
    storeDebug (debug);

    if (raw.isEmpty())
        return {};
    return juce::JSON::parse (raw);
}

juce::var OpsClient::makeRegisterBody() const
{
    MachineIdentity::get().loadOrCreate();
    auto* obj = new juce::DynamicObject();
    obj->setProperty ("machineId", MachineIdentity::get().getMachineId());
    obj->setProperty ("hostname", juce::SystemStats::getComputerName());
    obj->setProperty ("os", operatingSystemName());
    obj->setProperty ("appVersion", kAppVersion);
    obj->setProperty ("name", juce::SystemStats::getComputerName());
    return juce::var (obj);
}

bool OpsClient::login (const juce::String& email, const juce::String& password)
{
    if (email.isEmpty() || password.isEmpty())
    {
        lastError = "Email and password are required";
        storeDebug (lastError);
        return false;
    }

    auto* body = new juce::DynamicObject();
    body->setProperty ("email", email);
    body->setProperty ("password", password);
    int status = 0;
    auto json = postJson ("/api/auth/login", juce::var (body), &status);
    if (! (bool) json.getProperty ("ok", false))
    {
        auto parsed = json.getProperty ("error", {}).toString();
        const juce::ScopedLock sl (lock);
        if (parsed.isNotEmpty())
            lastError = parsed;
        else if (status == 0)
            lastError = "Could not reach " + settings.serverUrl + " — is AsaphOps running on port 3100?";
        else
            lastError = "Login failed (HTTP " + juce::String (status) + "). See Diagnostics.";
        return false;
    }

    {
        const juce::ScopedLock sl (lock);
        settings.token = json.getProperty ("token", {}).toString();
        settings.email = email;
        auto person = json.getProperty ("person", {});
        settings.personName = person.getProperty ("name", email).toString();
        lastError.clear();
    }
    save();
    if (! registerEndpoint())
        return false;
    startLive();
    sendChangeMessage();
    return true;
}

void OpsClient::logout()
{
    stopLive();
    goOffline();
    {
        const juce::ScopedLock sl (lock);
        settings.token.clear();
        settings.endpointId.clear();
        settings.endpointCode.clear();
        settings.endpointStatus.clear();
        lastError.clear();
    }
    save();
    sendChangeMessage();
}

bool OpsClient::registerEndpoint()
{
    int status = 0;
    auto json = postJson ("/api/companion/register", makeRegisterBody(), &status);
    if (status == 401)
    {
        const juce::ScopedLock sl (lock);
        settings.token.clear();
        lastError = "Session expired. Sign in again.";
        save();
        sendChangeMessage();
        return false;
    }
    if (! (bool) json.getProperty ("ok", false))
    {
        const juce::ScopedLock sl (lock);
        lastError = json.getProperty ("error", "Could not register endpoint").toString();
        return false;
    }
    {
        const juce::ScopedLock sl (lock);
        settings.endpointId = json.getProperty ("endpointId", {}).toString();
        settings.endpointCode = json.getProperty ("code", {}).toString();
        settings.endpointStatus = json.getProperty ("status", {}).toString();
        lastError.clear();
    }
    save();
    juce::Logger::writeToLog ("endpoint registered " + getSettings().endpointCode);
    sendChangeMessage();
    return true;
}

bool OpsClient::goOffline()
{
    if (! isLoggedIn())
        return false;
    auto* body = new juce::DynamicObject();
    body->setProperty ("machineId", MachineIdentity::get().getMachineId());
    postJson ("/api/companion/offline", juce::var (body));
    return true;
}

} // namespace AsaphOps
