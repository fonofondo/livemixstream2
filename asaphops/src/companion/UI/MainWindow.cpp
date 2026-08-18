#include "MainWindow.h"
#include "../App.h"
#include "../Autostart.h"
#include "../../shared/MachineIdentity.h"

namespace AsaphOps {

namespace {

juce::String formatTime (juce::int64 ms)
{
    if (ms <= 0)
        return "—";
    return juce::Time (ms).formatted ("%Y-%m-%d %H:%M");
}

} // namespace

class MainComponent : public juce::Component,
                      private juce::Timer,
                      private juce::ChangeListener
{
public:
    explicit MainComponent (CompanionApp& appIn)
        : app (appIn)
    {
        addAndMakeVisible (tabs);
        tabs.addTab ("Projects", juce::Colours::darkgrey, &projectsPage, false);
        tabs.addTab ("Connections", juce::Colours::darkgrey, &connectionsPage, false);
        tabs.addTab ("Settings", juce::Colours::darkgrey, &settingsPage, false);
        tabs.addTab ("Diagnostics", juce::Colours::darkgrey, &diagnosticsPage, false);

        projectsPage.addAndMakeVisible (projectsList);
        projectsList.setTextToShowWhenEmpty ("No projects yet. Open a DAW and insert the AsaphOps plugin.",
                                             juce::Colours::grey);
        projectsList.setReadOnly (true);
        projectsList.setMultiLine (true);

        connectionsPage.addAndMakeVisible (connectionsList);
        connectionsList.setTextToShowWhenEmpty ("No plugin connections.", juce::Colours::grey);
        connectionsList.setReadOnly (true);
        connectionsList.setMultiLine (true);

        diagnosticsPage.addAndMakeVisible (lastDebugLabel);
        lastDebugLabel.setText ("Last request", juce::dontSendNotification);
        diagnosticsPage.addAndMakeVisible (lastDebugView);
        lastDebugView.setMultiLine (true);
        lastDebugView.setReadOnly (true);
        lastDebugView.setFont (juce::Font (juce::Font::getDefaultMonospacedFontName(), 13.0f, juce::Font::plain));
        diagnosticsPage.addAndMakeVisible (logLabel);
        logLabel.setText ("Log", juce::dontSendNotification);
        diagnosticsPage.addAndMakeVisible (logView);
        logView.setMultiLine (true);
        logView.setReadOnly (true);
        logView.setFont (juce::Font (juce::Font::getDefaultMonospacedFontName(), 13.0f, juce::Font::plain));

        auto addLabel = [this] (juce::Label& label, const juce::String& text)
        {
            label.setText (text, juce::dontSendNotification);
            settingsPage.addAndMakeVisible (label);
        };

        addLabel (serverLabel, "AsaphOps server URL");
        settingsPage.addAndMakeVisible (serverUrl);
        addLabel (emailLabel, "Email");
        settingsPage.addAndMakeVisible (email);
        addLabel (passwordLabel, "Password");
        settingsPage.addAndMakeVisible (password);
        password.setPasswordCharacter ((juce::juce_wchar) 0x2022);
        settingsPage.addAndMakeVisible (loginButton);
        settingsPage.addAndMakeVisible (logoutButton);
        settingsPage.addAndMakeVisible (autostartToggle);
        settingsPage.addAndMakeVisible (statusLabel);
        statusLabel.setJustificationType (juce::Justification::topLeft);

        loginButton.setButtonText ("Sign in");
        logoutButton.setButtonText ("Sign out");
        autostartToggle.setButtonText ("Start companion when I log into this computer");
        logoutButton.setVisible (false);

        loginButton.onClick = [this] { doLogin(); };
        logoutButton.onClick = [this]
        {
            app.getOps().logout();
            app.getMedia().setOpsReady (false);
            refreshSettings();
        };
        autostartToggle.onClick = [this]
        {
            const bool on = autostartToggle.getToggleState();
            setAutostartEnabled (on, juce::File::getSpecialLocation (juce::File::currentExecutableFile));
            app.getOps().setAutostart (on);
        };
        serverUrl.onFocusLost = [this]
        {
            app.getOps().setServerUrl (serverUrl.getText());
            app.getMedia().setListenServerUrl (app.getOps().getSettings().serverUrl);
        };

        app.getRegistry().addChangeListener (this);
        app.getSessions().addChangeListener (this);
        app.getOps().addChangeListener (this);
        app.getMidi().addChangeListener (this);
        startTimerHz (1);
        refreshAll();
    }

    ~MainComponent() override
    {
        app.getRegistry().removeChangeListener (this);
        app.getSessions().removeChangeListener (this);
        app.getOps().removeChangeListener (this);
        app.getMidi().removeChangeListener (this);
    }

    void resized() override
    {
        tabs.setBounds (getLocalBounds());
        auto pad = [] (juce::Component& page, juce::Component& child)
        {
            child.setBounds (page.getLocalBounds().reduced (12));
        };
        pad (projectsPage, projectsList);
        pad (connectionsPage, connectionsList);

        auto diag = diagnosticsPage.getLocalBounds().reduced (12);
        lastDebugLabel.setBounds (diag.removeFromTop (22));
        lastDebugView.setBounds (diag.removeFromTop (200));
        diag.removeFromTop (8);
        logLabel.setBounds (diag.removeFromTop (22));
        logView.setBounds (diag);

        layoutSettings();
    }

private:
    void timerCallback() override
    {
        refreshLog();
        refreshLastDebug();
        refreshConnections();
    }
    void changeListenerCallback (juce::ChangeBroadcaster*) override { refreshAll(); }

    void refreshAll()
    {
        refreshProjects();
        refreshConnections();
        refreshSettings();
        refreshLog();
        refreshLastDebug();
    }

    void refreshProjects()
    {
        juce::String text;
        auto daws = app.getRegistry().getDaws();
        for (auto project : app.getRegistry().getProjects())
        {
            juce::String dawName;
            for (auto& daw : daws)
                if (daw.id == project.dawId)
                    dawName = daw.hostType + " " + daw.hostVersion;
            text << project.projectName << "\n"
                 << "  id: " << project.id << "\n"
                 << "  daw: " << dawName << "\n"
                 << "  path: " << project.projectPath << "\n"
                 << "  last seen: " << formatTime (project.lastSeenAt) << "\n\n";
        }
        if (projectsList.getText() != text)
            projectsList.setText (text, false);
    }

    void refreshConnections()
    {
        auto active = app.getSessions().getActiveSessions();
        juce::String text;
        if (active.isEmpty())
        {
            text = "No active plugins. Insert AsaphOps on a local DAW.\n";
        }
        else
        {
            bool hasMaster = false;
            for (auto& s : active)
                if (s.role == "master")
                    hasMaster = true;
            if (! hasMaster)
                text << "(no master plugin on the DAW master bus)\n\n";

            juce::StringArray daws;
            for (auto& s : active)
                if (! daws.contains (s.hostType))
                    daws.add (s.hostType);
            daws.sort (true);

            for (auto& daw : daws)
            {
                text << daw << "\n";
                juce::StringArray projects;
                for (auto& s : active)
                    if (s.hostType == daw && ! projects.contains (s.projectName))
                        projects.add (s.projectName.isNotEmpty() ? s.projectName : "Untitled");
                projects.sort (true);

                for (auto& project : projects)
                {
                    text << "  " << project << "\n";
                    for (auto& s : active)
                    {
                        const auto pname = s.projectName.isNotEmpty() ? s.projectName : juce::String ("Untitled");
                        if (s.hostType != daw || pname != project)
                            continue;
                        juce::String state = "idle";
                        if (s.streaming) state = "streaming";
                        else if (s.receivingAudio) state = "receiving audio";
                        text << "    " << s.pluginFormat << "  " << state;
                        if (s.role == "master" && s.listenUrl.isNotEmpty())
                            text << "\n           " << s.listenUrl;
                        text << "\n";
                    }
                }
                text << "\n";
            }
        }
        if (connectionsList.getText() != text)
            connectionsList.setText (text, false);
    }

    void layoutSettings()
    {
        const bool loggedIn = app.getOps().isLoggedIn();
        emailLabel.setVisible (! loggedIn);
        email.setVisible (! loggedIn);
        passwordLabel.setVisible (! loggedIn);
        password.setVisible (! loggedIn);
        loginButton.setVisible (! loggedIn);
        logoutButton.setVisible (loggedIn);

        auto area = settingsPage.getLocalBounds().reduced (16);
        auto row = [&area] (int h) { return area.removeFromTop (h); };
        serverLabel.setBounds (row (20));
        serverUrl.setBounds (row (28));
        area.removeFromTop (8);
        if (! loggedIn)
        {
            emailLabel.setBounds (row (20));
            email.setBounds (row (28));
            area.removeFromTop (8);
            passwordLabel.setBounds (row (20));
            password.setBounds (row (28));
            area.removeFromTop (12);
            loginButton.setBounds (row (32).removeFromLeft (120));
        }
        else
        {
            logoutButton.setBounds (row (32).removeFromLeft (120));
        }
        area.removeFromTop (12);
        autostartToggle.setBounds (row (28));
        area.removeFromTop (12);
        statusLabel.setBounds (area);
    }

    void refreshSettings()
    {
        auto s = app.getOps().getSettings();
        if (! serverUrl.hasKeyboardFocus (true))
            serverUrl.setText (s.serverUrl, false);
        if (! email.hasKeyboardFocus (true))
            email.setText (s.email, false);
        autostartToggle.setToggleState (isAutostartEnabled() || s.autostart, juce::dontSendNotification);
        loginButton.setEnabled (true);
        logoutButton.setEnabled (true);
        layoutSettings();

        juce::String status;
        MachineIdentity::get().loadOrCreate();
        status << "Machine ID: " << MachineIdentity::get().getMachineId() << "\n";
        if (app.getOps().isLoggedIn())
        {
            status << "Signed in as: " << (s.personName.isNotEmpty() ? s.personName : s.email) << "\n"
                   << "Endpoint: " << (s.endpointCode.isNotEmpty() ? s.endpointCode : "pending") << "\n"
                   << "Endpoint ID: " << s.endpointId << "\n"
                   << "Ops connection: " << (app.getOps().isLiveConnected() ? "live" : app.getOps().getLiveStatus()) << "\n"
                   << "MIDI ports: " << (app.getMidi().arePortsOpen() ? app.getMidi().getPortName() : "closed") << "\n"
                   << app.getMidi().getStatus() << "\n"
                   << "This app only passes MIDI (MCU + 3 extenders). Mixer logic lives in the web app.\n";
        }
        else
        {
            status << "Not signed in. Sign in to register this machine as an Endpoint.\n";
        }
        auto err = app.getOps().getLastError();
        if (err.isNotEmpty())
            status << "\n" << err;
        statusLabel.setText (status, juce::dontSendNotification);
    }

    void refreshLastDebug()
    {
        auto text = app.getOps().getLastDebug();
        if (text.isEmpty())
            text = "No requests yet. Sign in from Settings to see HTTP details here.";
        if (lastDebugView.getText() != text)
            lastDebugView.setText (text, false);
    }

    void refreshLog()
    {
        auto f = logFile();
        if (! f.existsAsFile())
            return;
        auto text = f.loadFileAsString();
        if (text.length() > 20000)
            text = text.substring (text.length() - 20000);
        if (logView.getText() != text)
        {
            logView.setText (text, false);
            logView.moveCaretToEnd();
        }
    }

    void doLogin()
    {
        app.getOps().setServerUrl (serverUrl.getText());
        if (! app.getOps().login (email.getText().trim(), password.getText()))
        {
            refreshLastDebug();
            tabs.setCurrentTabIndex (3);
        }
        else
        {
            app.getMedia().setListenServerUrl (app.getOps().getSettings().serverUrl);
            app.getMedia().setOpsReady (true);
        }
        password.clear();
        refreshSettings();
    }

    CompanionApp& app;
    juce::TabbedComponent tabs { juce::TabbedButtonBar::TabsAtTop };
    juce::Component projectsPage, connectionsPage, settingsPage, diagnosticsPage;
    juce::TextEditor projectsList, connectionsList, logView, lastDebugView;
    juce::Label serverLabel, emailLabel, passwordLabel, statusLabel, lastDebugLabel, logLabel;
    juce::TextEditor serverUrl, email, password;
    juce::TextButton loginButton, logoutButton;
    juce::ToggleButton autostartToggle;
};

MainWindow::MainWindow (CompanionApp& app)
    : juce::DocumentWindow ("AsaphOps",
                            juce::Desktop::getInstance().getDefaultLookAndFeel()
                                .findColour (juce::ResizableWindow::backgroundColourId),
                            juce::DocumentWindow::allButtons)
{
    setUsingNativeTitleBar (true);
    setContentOwned (new MainComponent (app), true);
    setResizable (true, true);
    centreWithSize (900, 560);
    setVisible (true);
}

void MainWindow::closeButtonPressed()
{
   #if JUCE_LINUX
    juce::JUCEApplication::getInstance()->systemRequestedQuit();
   #else
    setVisible (false);
   #endif
}

} // namespace AsaphOps
