#include "App.h"
#include "UI/MainWindow.h"
#include "UI/TrayIcon.h"
#include "Media/MediaEngine.h"
#include "../shared/MachineIdentity.h"

namespace AsaphOps {

namespace {

juce::String midiToHex (const juce::MidiMessage& message)
{
    const auto* data = message.getRawData();
    const int n = message.getRawDataSize();
    juce::String hex;
    hex.preallocateBytes ((size_t) n * 2 + 8);
    for (int i = 0; i < n; ++i)
        hex << juce::String::toHexString ((int) data[i]).paddedLeft ('0', 2);
    return hex;
}

} // namespace

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
    midi = std::make_unique<MidiPassthrough>();
    midi->addChangeListener (this);
    ops->addChangeListener (this);
    midi->start();
    midi->setIncomingMidiHandler ([this] (int surface, const juce::MidiMessage& message)
    {
        if (ops != nullptr)
            ops->sendLiveLine ("MIDI " + juce::String (surface) + " " + midiToHex (message));
    });
    ops->setLiveLineHandler ([this] (juce::String line)
    {
        if (midi == nullptr)
            return;
        if (line.startsWith ("MIDI "))
        {
            auto rest = line.fromFirstOccurrenceOf ("MIDI ", false, false).trim();
            int surface = 0;
            if (rest.length() >= 2 && rest[0] >= '0' && rest[0] <= '3' && rest[1] == ' ')
            {
                surface = (int) (rest[0] - '0');
                rest = rest.substring (2).trim();
            }
            midi->sendHex (surface, rest);
        }
    });
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
        pushPortStatus();
    }

   #if ! JUCE_LINUX
    tray = std::make_unique<TrayIcon> (*this);
    if (! startHidden)
   #endif
        showMainWindow();

    juce::Logger::writeToLog ("companion ready machine=" + MachineIdentity::get().getMachineId());
}

void CompanionApp::shutdown()
{
    if (midi != nullptr)
        midi->removeChangeListener (this);
    if (ops != nullptr)
        ops->removeChangeListener (this);
    if (ops != nullptr)
    {
        ops->setLiveLineHandler ({});
        if (media != nullptr)
            media->setOpsReady (false);
        ops->stopLive();
        ops->goOffline();
    }
    window.reset();
    tray.reset();
    ipc.reset();
    if (midi != nullptr)
        midi->stop();
    midi.reset();
    media.reset();
    ops.reset();
    juce::Logger::setCurrentLogger (nullptr);
    logger.reset();
    if (instanceLock != nullptr)
        instanceLock->exit();
}

void CompanionApp::changeListenerCallback (juce::ChangeBroadcaster*)
{
    pushPortStatus();
}

void CompanionApp::pushPortStatus()
{
    if (ops == nullptr || midi == nullptr)
        return;
    ops->sendLiveLine ("PORT " + midi->portSnapshotJson());
}

void CompanionApp::showMainWindow()
{
    if (window == nullptr)
        window = std::make_unique<MainWindow> (*this);
    window->setVisible (true);
    window->toFront (true);
}

} // namespace AsaphOps
