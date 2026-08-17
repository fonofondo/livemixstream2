#include "Autostart.h"

namespace AsaphOps {

#if JUCE_LINUX
static juce::File autostartFile()
{
    return juce::File::getSpecialLocation (juce::File::userHomeDirectory)
        .getChildFile (".config/autostart/asaphops-companion.desktop");
}

bool isAutostartEnabled()
{
    return autostartFile().existsAsFile();
}

bool setAutostartEnabled (bool enabled, const juce::File& executable)
{
    auto file = autostartFile();
    if (! enabled)
        return ! file.existsAsFile() || file.deleteFile();

    file.getParentDirectory().createDirectory();
    juce::String desktop;
    desktop << "[Desktop Entry]\n"
            << "Type=Application\n"
            << "Name=AsaphOps Companion\n"
            << "Exec=\"" << executable.getFullPathName() << "\" --background\n"
            << "X-GNOME-Autostart-enabled=true\n"
            << "Terminal=false\n";
    return file.replaceWithText (desktop);
}

#elif JUCE_MAC
static juce::File launchAgentFile()
{
    return juce::File::getSpecialLocation (juce::File::userHomeDirectory)
        .getChildFile ("Library/LaunchAgents/com.asaphops.companion.plist");
}

bool isAutostartEnabled()
{
    return launchAgentFile().existsAsFile();
}

bool setAutostartEnabled (bool enabled, const juce::File& executable)
{
    auto file = launchAgentFile();
    if (! enabled)
        return ! file.existsAsFile() || file.deleteFile();

    file.getParentDirectory().createDirectory();
    juce::String plist;
    plist << "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n"
          << "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" "
          << "\"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n"
          << "<plist version=\"1.0\"><dict>"
          << "<key>Label</key><string>com.asaphops.companion</string>"
          << "<key>ProgramArguments</key><array>"
          << "<string>" << executable.getFullPathName() << "</string>"
          << "<string>--background</string></array>"
          << "<key>RunAtLoad</key><true/>"
          << "</dict></plist>\n";
    return file.replaceWithText (plist);
}

#elif JUCE_WINDOWS
static const char* kRunKey = "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\\AsaphOpsCompanion";

bool isAutostartEnabled()
{
    return juce::WindowsRegistry::getValue (kRunKey).isNotEmpty();
}

bool setAutostartEnabled (bool enabled, const juce::File& executable)
{
    if (! enabled)
        return juce::WindowsRegistry::deleteValue (kRunKey);
    return juce::WindowsRegistry::setValue (kRunKey, "\"" + executable.getFullPathName() + "\" --background");
}

#else
bool isAutostartEnabled() { return false; }
bool setAutostartEnabled (bool, const juce::File&) { return false; }
#endif

} // namespace AsaphOps
