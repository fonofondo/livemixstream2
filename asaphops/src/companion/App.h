#pragma once

#include <juce_gui_basics/juce_gui_basics.h>
#include "ProjectRegistry/ProjectRegistry.h"
#include "SessionManager/SessionManager.h"
#include "Network/OpsClient.h"
#include "IPCServer/IPCServer.h"
#include "Media/MediaEngine.h"
#include "Mackie/MackieSurface.h"
#include "UI/MainWindow.h"
#include "UI/TrayIcon.h"

namespace AsaphOps {

class CompanionApp : public juce::JUCEApplication
{
public:
    const juce::String getApplicationName() override { return "AsaphOps"; }
    const juce::String getApplicationVersion() override { return kAppVersion; }
    bool moreThanOneInstanceAllowed() override { return false; }

    void initialise (const juce::String& commandLine) override;
    void shutdown() override;
    ~CompanionApp() override;
    void systemRequestedQuit() override { quit(); }

    void showMainWindow();

    ProjectRegistry& getRegistry() { return registry; }
    SessionManager& getSessions() { return sessions; }
    OpsClient& getOps() { return *ops; }
    MediaEngine& getMedia() { return *media; }
    MackieSurface& getMackie() { return *mackie; }

private:
    std::unique_ptr<juce::InterProcessLock> instanceLock;
    std::unique_ptr<juce::FileLogger> logger;
    ProjectRegistry registry;
    SessionManager sessions;
    std::unique_ptr<OpsClient> ops;
    std::unique_ptr<MediaEngine> media;
    std::unique_ptr<MackieSurface> mackie;
    std::unique_ptr<IPCServer> ipc;
    std::unique_ptr<MainWindow> window;
    std::unique_ptr<TrayIcon> tray;
    bool startHidden = false;
};

} // namespace AsaphOps
