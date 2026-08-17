#include "PluginEditor.h"

namespace LiveMixStream {

LiveMixStreamPluginEditor::LiveMixStreamPluginEditor (LiveMixStreamAudioProcessor& p)
    : AudioProcessorEditor (&p), audioProcessor (p)
{
    setLookAndFeel (&m_lnf);
    setSize (380, 500);

    auto styleLabel = [](juce::Label& l, const juce::String& text, float size = 12.0f) {
        l.setText(text, juce::dontSendNotification);
        l.setFont(juce::Font (juce::Font::getDefaultSansSerifFontName(), size, juce::Font::plain));
        l.setColour(juce::Label::textColourId, StudioLookAndFeel::muted());
    };

    auto styleEditor = [](juce::TextEditor& e) {
        e.setColour(juce::TextEditor::backgroundColourId, StudioLookAndFeel::bgDark());
        e.setColour(juce::TextEditor::textColourId, StudioLookAndFeel::text());
        e.setColour(juce::TextEditor::outlineColourId, juce::Colours::transparentBlack);
        e.setColour(juce::TextEditor::focusedOutlineColourId, juce::Colours::transparentBlack);
        e.setColour(juce::TextEditor::highlightColourId, StudioLookAndFeel::cyan().withAlpha (0.35f));
        e.setIndents (8, 0);
        e.setBorder (juce::BorderSize<int> (0));
        e.setJustification (juce::Justification::centredLeft);
        e.setFont (juce::Font (juce::Font::getDefaultSansSerifFontName(), 13.0f, juce::Font::plain));
    };

    m_titleLabel.setText("LiveMixStream", juce::dontSendNotification);
    m_titleLabel.setFont(juce::Font (juce::Font::getDefaultSansSerifFontName(), 18.0f, juce::Font::bold));
    m_titleLabel.setColour(juce::Label::textColourId, StudioLookAndFeel::text());
    addAndMakeVisible(m_titleLabel);

    m_statusBadge.setFont(juce::Font (juce::Font::getDefaultSansSerifFontName(), 11.0f, juce::Font::bold));
    m_statusBadge.setJustificationType(juce::Justification::centredRight);
    m_statusBadge.setColour(juce::Label::textColourId, StudioLookAndFeel::cyan());
    addAndMakeVisible(m_statusBadge);

    styleLabel(m_trackNameLabel, "Track Name");
    addAndMakeVisible(m_trackNameLabel);
    m_trackNameInput.setText(audioProcessor.getTrackName());
    styleEditor(m_trackNameInput);
    m_trackNameInput.onTextChange = [this] {
        audioProcessor.setTrackName(m_trackNameInput.getText().toStdString(),
                                    LiveMixStreamAudioProcessor::NameSource::User);
    };
    addAndMakeVisible(m_trackNameInput);

    m_masterToggle.setButtonText("Master");
    m_masterToggle.setToggleState(audioProcessor.getMode() == PluginMode::Streaming, juce::dontSendNotification);
    m_masterToggle.setColour(juce::ToggleButton::textColourId, StudioLookAndFeel::text());
    m_masterToggle.onClick = [this] {
        audioProcessor.setMode(m_masterToggle.getToggleState() ? PluginMode::Streaming
                                                               : PluginMode::TrackControl);
        updateUIState();
    };
    addAndMakeVisible(m_masterToggle);

    styleLabel(m_duckStateLabel, "Duck State");
    addAndMakeVisible(m_duckStateLabel);
    m_duckStateBox.onClick = [this] {
        audioProcessor.toggleDuck();
        updateUIState();
    };
    addAndMakeVisible(m_duckStateBox);
    styleLabel(m_duckStateHint, "Click the box to duck / unduck · mirrors the web listener UI", 11.0f);
    addAndMakeVisible(m_duckStateHint);

    styleLabel(m_duckLabel, "Duck Level");
    addAndMakeVisible(m_duckLabel);
    m_duckSlider.setRange(-60.0, 0.0, 0.1);
    m_duckSlider.setValue(juce::Decibels::gainToDecibels(audioProcessor.getLocalDuckGain(), -60.0f));
    m_duckSlider.setTextBoxStyle(juce::Slider::TextBoxRight, false, 64, 20);
    m_duckSlider.textFromValueFunction = [](double v) {
        if (v <= -60.0)
            return juce::String("-inf dB");
        return juce::String(v, 1) + " dB";
    };
    m_duckSlider.valueFromTextFunction = [](const juce::String& t) {
        auto s = t.trim().toLowerCase();
        if (s.contains("inf"))
            return -60.0;
        return s.getDoubleValue();
    };
    m_duckSlider.onValueChange = [this] {
        const float db = (float) m_duckSlider.getValue();
        audioProcessor.setLocalDuckGain(juce::Decibels::decibelsToGain(db, -60.0f));
    };
    addAndMakeVisible(m_duckSlider);

    styleLabel(m_fadeLabel, "Fade (ms)");
    addAndMakeVisible(m_fadeLabel);
    m_fadeSlider.setRange(50.0, 1000.0, 10.0);
    m_fadeSlider.setValue(audioProcessor.getLocalFadeMs());
    m_fadeSlider.setTextBoxStyle(juce::Slider::TextBoxRight, false, 50, 20);
    m_fadeSlider.onValueChange = [this] {
        audioProcessor.setLocalFadeMs((int) m_fadeSlider.getValue());
    };
    addAndMakeVisible(m_fadeSlider);

    styleLabel(m_serverUrlLabel, "Server Host URL");
    addAndMakeVisible(m_serverUrlLabel);
    m_serverUrlInput.setText(audioProcessor.getSessionManager().getServerUrl());
    styleEditor(m_serverUrlInput);
    m_serverUrlInput.onTextChange = [this] {
        audioProcessor.getSessionManager().saveServerUrlConfig(m_serverUrlInput.getText().toStdString());
    };
    addAndMakeVisible(m_serverUrlInput);

    styleLabel(m_sessionNameLabel, "Session Name");
    addAndMakeVisible(m_sessionNameLabel);
    m_sessionNameInput.setText(audioProcessor.getSessionManager().getConfig().title);
    styleEditor(m_sessionNameInput);
    m_sessionNameInput.onTextChange = [this] {
        audioProcessor.getSessionManager().getConfig().title = m_sessionNameInput.getText().toStdString();
    };
    addAndMakeVisible(m_sessionNameInput);

    m_actionButton.setButtonText("CONNECT");
    m_actionButton.setPaintingIsUnclipped(true);
    m_actionButton.setColour(juce::TextButton::buttonColourId, StudioLookAndFeel::cyan());
    m_actionButton.setColour(juce::TextButton::textColourOffId, juce::Colour (0xff121416));
    m_actionButton.onClick = [this] {
        audioProcessor.getSessionManager().saveServerUrlConfig(m_serverUrlInput.getText().toStdString());
        audioProcessor.getSessionManager().getConfig().title = m_sessionNameInput.getText().toStdString();
        audioProcessor.getSessionManager().getConfig().quality =
            m_qualitySelector.getSelectedId() == 2 ? "Efficient" : "High";

        if (!audioProcessor.isStreaming())
            audioProcessor.startStreamingSession();
        else
            audioProcessor.stopStreamingSession();
        updateUIState();
    };
    addAndMakeVisible(m_actionButton);

    styleLabel(m_urlLabel, "Listener Shareable URL");
    addAndMakeVisible(m_urlLabel);
    m_urlDisplay.setReadOnly(true);
    styleEditor(m_urlDisplay);
    addAndMakeVisible(m_urlDisplay);

    m_copyUrlButton.setButtonText("COPY");
    m_copyUrlButton.onClick = [this] {
        juce::SystemClipboard::copyTextToClipboard(m_urlDisplay.getText());
        m_copyUrlButton.setButtonText("COPIED");
        m_copyFlash = true;
        startTimer(1200);
    };
    addAndMakeVisible(m_copyUrlButton);

    styleLabel(m_qualityLabel, "Quality");
    addAndMakeVisible(m_qualityLabel);
    m_qualitySelector.addItem ("High (128-256 kbps)", 1);
    m_qualitySelector.addItem ("Efficient (64-96 kbps)", 2);
    m_qualitySelector.setSelectedId(
        audioProcessor.getSessionManager().getConfig().quality == "Efficient" ? 2 : 1);
    addAndMakeVisible(m_qualitySelector);

    auto styleMetric = [](juce::Label& l) {
        l.setColour(juce::Label::textColourId, StudioLookAndFeel::text());
        l.setFont(juce::Font (juce::Font::getDefaultSansSerifFontName(), 12.0f, juce::Font::plain));
    };
    styleMetric(m_listenersMetricLabel);
    styleMetric(m_latencyMetricLabel);
    styleMetric(m_bitrateMetricLabel);
    styleMetric(m_connectionLabel);

    addAndMakeVisible(m_listenersMetricLabel);
    addAndMakeVisible(m_latencyMetricLabel);
    addAndMakeVisible(m_bitrateMetricLabel);
    addAndMakeVisible(m_connectionLabel);

    styleLabel(m_tracksLabel, "Tracks");
    addAndMakeVisible(m_tracksLabel);
    styleLabel(m_tracksHint, "Click a track to duck / unduck · Lit = full · dim = ducked", 11.0f);
    m_tracksHint.setColour(juce::Label::textColourId, StudioLookAndFeel::muted());
    addAndMakeVisible(m_tracksHint);
    m_trackGrid.onTrackClick = [this](const std::string& instanceId) {
        audioProcessor.toggleTrackDuck(instanceId);
        m_cachedTracks = audioProcessor.getListedTracks();
        m_trackGrid.setTracks(m_cachedTracks);
    };
    addAndMakeVisible(m_trackGrid);

    startTimerHz(4);
    updateUIState();
    resized();
}

LiveMixStreamPluginEditor::~LiveMixStreamPluginEditor()
{
    stopTimer();
    setLookAndFeel (nullptr);
}

void LiveMixStreamPluginEditor::paint (juce::Graphics& g)
{
    g.fillAll (StudioLookAndFeel::bg());
    g.setColour (StudioLookAndFeel::cyan());
    g.fillRect (0, 0, getWidth(), 3);
    g.setColour (StudioLookAndFeel::bgDark());
    g.fillRect (0, 3, getWidth(), 36);
}

void LiveMixStreamPluginEditor::resized()
{
    const bool streaming = audioProcessor.getMode() == PluginMode::Streaming;
    const bool showMaster = m_masterToggle.isVisible();
    setSize (380, streaming ? 700 : (showMaster ? 500 : 470));

    auto bounds = getLocalBounds();
    bounds.removeFromTop (3);
    auto header = bounds.removeFromTop (36);
    m_titleLabel.setBounds (header.removeFromLeft (200).reduced (12, 6));
    m_statusBadge.setBounds (header.reduced (12, 6));

    auto area = bounds.reduced (16, 10);

    if (showMaster)
    {
        area.removeFromTop(4);
        m_masterToggle.setBounds(area.removeFromTop(24));
    }

    if (! streaming)
    {
        area.removeFromTop(8);
        m_trackNameLabel.setBounds(area.removeFromTop(16));
        m_trackNameInput.setBounds(area.removeFromTop(28));
        area.removeFromTop(8);
        m_duckStateLabel.setBounds(area.removeFromTop(16));
        m_duckStateBox.setBounds(area.removeFromTop(52));
        area.removeFromTop(2);
        m_duckStateHint.setBounds(area.removeFromTop(16));
        area.removeFromTop(8);
        m_duckLabel.setBounds(area.removeFromTop(16));
        m_duckSlider.setBounds(area.removeFromTop(28));
        m_fadeLabel.setBounds(area.removeFromTop(16));
        m_fadeSlider.setBounds(area.removeFromTop(28));
    }

    if (streaming)
    {
        area.removeFromTop(8);
        m_serverUrlLabel.setBounds(area.removeFromTop(16));
        m_serverUrlInput.setBounds(area.removeFromTop(28));
        area.removeFromTop(4);
        m_sessionNameLabel.setBounds(area.removeFromTop(16));
        m_sessionNameInput.setBounds(area.removeFromTop(28));
        area.removeFromTop(6);
        m_urlLabel.setBounds(area.removeFromTop(16));
        auto urlRow = area.removeFromTop(28);
        m_copyUrlButton.setBounds(urlRow.removeFromRight(70));
        urlRow.removeFromRight(4);
        m_urlDisplay.setBounds(urlRow);
        area.removeFromTop(6);
        m_qualityLabel.setBounds(area.removeFromTop(16));
        m_qualitySelector.setBounds(area.removeFromTop(28));
        area.removeFromTop(10);
        m_actionButton.setBounds(area.removeFromTop(32).reduced (2, 0));
        area.removeFromTop(8);
        m_tracksLabel.setBounds(area.removeFromTop(16));
        m_tracksHint.setBounds(area.removeFromTop(18));
        area.removeFromTop(4);
        m_trackGrid.setBounds(area.removeFromTop(150));
        area.removeFromTop(8);
        m_listenersMetricLabel.setBounds(area.removeFromTop(18));
        m_latencyMetricLabel.setBounds(area.removeFromTop(18));
        m_bitrateMetricLabel.setBounds(area.removeFromTop(18));
    }
    else
    {
        area.removeFromTop(8);
        m_connectionLabel.setBounds(area.removeFromTop(36));
    }
}

void LiveMixStreamPluginEditor::timerCallback()
{
    if (m_copyFlash) {
        m_copyUrlButton.setButtonText("COPY");
        m_copyFlash = false;
    }
    updateUIState();
}

void LiveMixStreamPluginEditor::updateUIState()
{
    auto& sm = audioProcessor.getSessionManager();
    const bool streaming = audioProcessor.getMode() == PluginMode::Streaming;

    m_serverUrlLabel.setVisible(streaming);
    m_serverUrlInput.setVisible(streaming);
    m_sessionNameLabel.setVisible(streaming);
    m_sessionNameInput.setVisible(streaming);
    m_actionButton.setVisible(streaming);
    m_urlLabel.setVisible(streaming);
    m_urlDisplay.setVisible(streaming);
    m_copyUrlButton.setVisible(streaming);
    m_qualityLabel.setVisible(streaming);
    m_qualitySelector.setVisible(streaming);
    m_listenersMetricLabel.setVisible(streaming);
    m_latencyMetricLabel.setVisible(streaming);
    m_bitrateMetricLabel.setVisible(streaming);
    m_tracksLabel.setVisible(streaming);
    m_tracksHint.setVisible(streaming);
    m_trackGrid.setVisible(streaming);
    m_trackNameLabel.setVisible(!streaming);
    m_trackNameInput.setVisible(!streaming);
    m_duckStateLabel.setVisible(!streaming);
    m_duckStateBox.setVisible(!streaming);
    m_duckStateHint.setVisible(!streaming);
    m_duckLabel.setVisible(!streaming);
    m_duckSlider.setVisible(!streaming);
    m_fadeLabel.setVisible(!streaming);
    m_fadeSlider.setVisible(!streaming);
    m_connectionLabel.setVisible(!streaming);

    const bool showMaster = audioProcessor.canOfferMasterMode();
    m_masterToggle.setVisible(showMaster);
    if (showMaster)
        m_masterToggle.setToggleState(streaming, juce::dontSendNotification);

    if (streaming != m_lastStreamingLayout || showMaster != m_lastShowMaster)
    {
        m_lastStreamingLayout = streaming;
        m_lastShowMaster = showMaster;
        resized();
    }

    if (!streaming && ! m_trackNameInput.hasKeyboardFocus(true))
        m_trackNameInput.setText(audioProcessor.getTrackName(), juce::dontSendNotification);

    if (!streaming)
    {
        m_duckStateBox.setState(audioProcessor.getTrackName(),
                                audioProcessor.isUnducked(),
                                audioProcessor.isLinkedToMaster());
    }

    if (!streaming && ! m_duckSlider.isMouseButtonDown() && ! m_duckSlider.hasKeyboardFocus(true))
    {
        const double db = juce::Decibels::gainToDecibels(audioProcessor.getLocalDuckGain(), -60.0f);
        if (std::abs(m_duckSlider.getValue() - db) > 0.05)
            m_duckSlider.setValue(db, juce::dontSendNotification);
    }

    const auto sid = sm.getSessionId();

    juce::String url = sm.getListenerUrl();
    if (url.isEmpty()) {
        juce::String base = m_serverUrlInput.getText();
        if (base.endsWithChar('/')) base = base.dropLastCharacters(1);
        url = base + "/s/" + (sid.empty() ? "------" : juce::String(sid));
    }
    m_urlDisplay.setText(url, juce::dontSendNotification);

    if (streaming) {
        m_statusBadge.setText("STREAMING MASTER", juce::dontSendNotification);
        m_statusBadge.setColour(juce::Label::textColourId, StudioLookAndFeel::cyan());
        const bool live = audioProcessor.isStreaming() && sm.getState() == SessionState::Live;
        const bool connecting = audioProcessor.isStreaming() && sm.getState() == SessionState::Connecting;
        if (live)
            m_actionButton.setButtonText("STOP STREAM");
        else if (connecting)
            m_actionButton.setButtonText("CONNECTING...");
        else
            m_actionButton.setButtonText("CONNECT");

        m_actionButton.getProperties().set("actionGlow", live);
        m_actionButton.setColour(juce::TextButton::buttonColourId,
                                 live ? StudioLookAndFeel::liveGreen() : StudioLookAndFeel::cyan());
        m_actionButton.setColour(juce::TextButton::textColourOffId, juce::Colour (0xff121416));
        m_actionButton.repaint();
    } else {
        m_statusBadge.setText("TRACK CONTROL", juce::dontSendNotification);
        m_statusBadge.setColour(juce::Label::textColourId,
            audioProcessor.isLinkedToMaster() ? StudioLookAndFeel::cyan() : juce::Colour(0xffe8a317));
    }

    if (!streaming) {
        m_connectionLabel.setText(
            audioProcessor.isLinkedToMaster()
                ? "Linked to the Master plugin on this machine"
                : "Waiting for a Master plugin on this machine...",
            juce::dontSendNotification);
    } else {
        m_cachedTracks = audioProcessor.getListedTracks();
        m_trackGrid.setTracks(m_cachedTracks);
    }

    auto telem = sm.getTelemetry();
    m_listenersMetricLabel.setText("Listeners: " + juce::String(telem.activeListeners), juce::dontSendNotification);
    m_latencyMetricLabel.setText("Latency: ~" + juce::String(telem.roundTripLatencyMs) + " ms", juce::dontSendNotification);
    m_bitrateMetricLabel.setText("Bitrate: " + juce::String(telem.bitrateKbps) + " kbps", juce::dontSendNotification);
}

} // namespace LiveMixStream
