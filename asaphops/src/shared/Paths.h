#pragma once

#include <juce_core/juce_core.h>

namespace AsaphOps {

constexpr int kProtocolVersion = 2;
constexpr int kDefaultIpcPort = 18780;
inline constexpr const char* kIpcBindAddress = "127.0.0.1";
inline constexpr const char* kAppVersion = "0.1.0";

inline juce::File appDataDir()
{
    auto dir = juce::File::getSpecialLocation (juce::File::userApplicationDataDirectory)
                   .getChildFile ("AsaphOps");
    dir.createDirectory();
    return dir;
}

inline juce::File ipcSecretFile()      { return appDataDir().getChildFile ("ipc.secret"); }
inline juce::File ipcPortFile()        { return appDataDir().getChildFile ("ipc.port"); }
inline juce::File companionPathFile()  { return appDataDir().getChildFile ("companion.path"); }
inline juce::File machineFile()        { return appDataDir().getChildFile ("machine.json"); }
inline juce::File registryFile()       { return appDataDir().getChildFile ("registry.json"); }
inline juce::File settingsFile()       { return appDataDir().getChildFile ("settings.json"); }
inline juce::File logFile()            { return appDataDir().getChildFile ("companion.log"); }

inline juce::String loadIpcSecret()
{
    auto f = ipcSecretFile();
    if (f.existsAsFile())
        return f.loadFileAsString().trim();
    return {};
}

inline juce::String ensureIpcSecret()
{
    auto existing = loadIpcSecret();
    if (existing.isNotEmpty())
        return existing;

    auto secret = juce::Uuid().toDashedString();
    ipcSecretFile().replaceWithText (secret);
    return secret;
}

inline int loadIpcPort()
{
    auto f = ipcPortFile();
    if (! f.existsAsFile())
        return kDefaultIpcPort;
    const int port = f.loadFileAsString().trim().getIntValue();
    return port > 0 ? port : kDefaultIpcPort;
}

inline void writeIpcPort (int port)
{
    ipcPortFile().replaceWithText (juce::String (port));
}

inline void writeCompanionPath (const juce::File& exe)
{
    companionPathFile().replaceWithText (exe.getFullPathName());
}

inline juce::String operatingSystemName()
{
   #if JUCE_WINDOWS
    return "Windows";
   #elif JUCE_MAC
    return "macOS";
   #elif JUCE_LINUX
    return "Linux";
   #else
    return "Unknown";
   #endif
}

} // namespace AsaphOps
