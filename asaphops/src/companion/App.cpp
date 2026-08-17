#include "App.h"
#include "UI/MainWindow.h"
#include "UI/TrayIcon.h"
#include "Media/MediaEngine.h"
#include "../shared/MachineIdentity.h"

namespace AsaphOps {

CompanionApp::~CompanionApp() = default;

void CompanionApp::initialise (const juce::String& commandLine)
{
    startHidden = commandLine.containsIgnoreCase ("--background")
                  || commandLine.containsIgnoreCase ("--hidden");

    instanceLock = std::make_unique<juce::InterProcessLock> ("AsaphOpsCompanionSingleton");
    if (! instanceLock->enter (200))
    {
        juce::Logger::writeToLog ("another companion instance is already running");
        quit();
        return;
    }

    logger = std::make_unique<juce::FileLogger> (logFile(),
                                                 "AsaphOps companion " + juce::String (kAppVersion));
    juce::Logger::setCurrentLogger (logger.get());

    MachineIdentity::get().loadOrCreate();
    const auto secret = ensureIpcSecret();
    writeCompanionPath (juce::File::getSpecialLocation (juce::File::currentExecutableFile));
    registry.load();

    ops = std::make_unique<OpsClient>();
    media = std::make_unique<MediaEngine> (sessions);
    media->setListenServerUrl (ops->getSettings().serverUrl);
    mackie = std::make_unique<MackieSurface>();
    mackie->start();
    ipc = std::make_unique<IPCServer> (registry, sessions, *media, secret);
    media->onListenUrl = [this] (const juce::String& url)
    {
        if (ipc != nullptr)
            ipc->pushListenUrl (url);
    };
    if (! ipc->start())
    {
        juce::Logger::writeToLog ("failed to start IPC server");
        quit();
        return;
    }

    if (ops->isLoggedIn())
    {
        if (ops->registerEndpoint())
            ops->startLive();
        media->setOpsReady (true);
    }

    // JUCE's X11 system-tray dock can crash GNOME/KDE sessions. Keep a normal
    // window on Linux; tray is macOS/Windows only.
   #if ! JUCE_LINUX
    tray = std::make_unique<TrayIcon> (*this);
    if (! startHidden)
   #endif
        showMainWindow();

    juce::Logger::writeToLog ("companion ready machine=" + MachineIdentity::get().getMachineId());
}

void CompanionApp::shutdown()
{
    if (ops != nullptr)
    {
        if (media != nullptr)
            media->setOpsReady (false);
        ops->stopLive();
        ops->goOffline();
    }
    window.reset();
    tray.reset();
    ipc.reset();
    if (mackie != nullptr)
        mackie->stop();
    mackie.reset();
    media.reset();
    ops.reset();
    juce::Logger::setCurrentLogger (nullptr);
    logger.reset();
    if (instanceLock != nullptr)
        instanceLock->exit();
}

void CompanionApp::showMainWindow()
{
    if (window == nullptr)
        window = std::make_unique<MainWindow> (*this);
    window->setVisible (true);
    window->toFront (true);
}

} // namespace AsaphOps
