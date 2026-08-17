#pragma once

#include <juce_gui_basics/juce_gui_basics.h>
#include "../Plugin/AudioProcessor.h"

namespace LiveMixStream {

class StudioLookAndFeel : public juce::LookAndFeel_V4
{
public:
    static juce::Colour bg()        { return juce::Colour (0xff33363b); }
    static juce::Colour bgDark()    { return juce::Colour (0xff25282b); }
    static juce::Colour bgSelected(){ return juce::Colour (0xff444b54); }
    static juce::Colour cyan()      { return juce::Colour (0xff00b4ff); }
    static juce::Colour liveGreen() { return juce::Colour (0xff2ee66b); }
    static juce::Colour text()      { return juce::Colour (0xffd1d1d1); }
    static juce::Colour muted()     { return juce::Colour (0xff9aa0a6); }

    StudioLookAndFeel()
    {
        setColour (juce::ResizableWindow::backgroundColourId, bg());
        setColour (juce::Label::textColourId, muted());
        setColour (juce::TextEditor::backgroundColourId, bgDark());
        setColour (juce::TextEditor::textColourId, text());
        setColour (juce::TextEditor::highlightColourId, cyan().withAlpha (0.35f));
        setColour (juce::TextEditor::highlightedTextColourId, juce::Colours::white);
        setColour (juce::TextEditor::outlineColourId, juce::Colours::transparentBlack);
        setColour (juce::TextEditor::focusedOutlineColourId, juce::Colours::transparentBlack);
        setColour (juce::CaretComponent::caretColourId, cyan());
        setColour (juce::TextButton::buttonColourId, bgDark());
        setColour (juce::TextButton::buttonOnColourId, cyan().withAlpha (0.22f));
        setColour (juce::TextButton::textColourOffId, text());
        setColour (juce::TextButton::textColourOnId, cyan());
        setColour (juce::ComboBox::backgroundColourId, bgDark());
        setColour (juce::ComboBox::textColourId, text());
        setColour (juce::ComboBox::outlineColourId, juce::Colours::transparentBlack);
        setColour (juce::ComboBox::arrowColourId, cyan());
        setColour (juce::PopupMenu::backgroundColourId, bgDark());
        setColour (juce::PopupMenu::textColourId, text());
        setColour (juce::PopupMenu::highlightedBackgroundColourId, bgSelected());
        setColour (juce::PopupMenu::highlightedTextColourId, cyan());
        setColour (juce::ListBox::backgroundColourId, bgDark());
        setColour (juce::ListBox::outlineColourId, juce::Colours::transparentBlack);
        setColour (juce::ScrollBar::thumbColourId, cyan());
        setColour (juce::ScrollBar::backgroundColourId, bgDark());
        setColour (juce::Slider::thumbColourId, juce::Colours::white);
        setColour (juce::Slider::trackColourId, cyan());
        setColour (juce::Slider::backgroundColourId, bgDark());
        setColour (juce::Slider::textBoxTextColourId, text());
        setColour (juce::Slider::textBoxBackgroundColourId, bgDark());
        setColour (juce::Slider::textBoxOutlineColourId, juce::Colours::transparentBlack);
        setColour (juce::ToggleButton::textColourId, text());
        setColour (juce::ToggleButton::tickColourId, cyan());
        setColour (juce::ToggleButton::tickDisabledColourId, muted());
    }

    void fillTextEditorBackground (juce::Graphics& g, int w, int h, juce::TextEditor&) override
    {
        g.setColour (bgDark());
        g.fillRect (0, 0, w, h);
    }

    void drawTextEditorOutline (juce::Graphics&, int, int, juce::TextEditor&) override {}

    void drawButtonBackground (juce::Graphics& g, juce::Button& button, const juce::Colour&,
                               bool shouldDrawButtonAsHighlighted, bool shouldDrawButtonAsDown) override
    {
        auto r = button.getLocalBounds().toFloat().reduced (0.5f);
        auto fill = button.findColour (juce::TextButton::buttonColourId);
        const bool glow = (bool) button.getProperties()["actionGlow"];

        if (glow)
        {
            for (int i = 3; i >= 1; --i)
            {
                g.setColour (liveGreen().withAlpha (0.10f * (float) i));
                g.fillRoundedRectangle (r.expanded ((float) i * 2.0f), 3.0f);
            }
            fill = liveGreen();
            if (shouldDrawButtonAsHighlighted || shouldDrawButtonAsDown)
                fill = fill.brighter (0.12f);
        }
        else if (shouldDrawButtonAsDown)
            fill = fill.darker (0.15f);
        else if (shouldDrawButtonAsHighlighted)
            fill = fill.brighter (0.12f);

        g.setColour (fill);
        g.fillRoundedRectangle (r, 2.0f);
    }

    void drawButtonText (juce::Graphics& g, juce::TextButton& button,
                         bool, bool) override
    {
        g.setColour (button.findColour (juce::TextButton::textColourOffId));
        g.setFont (juce::Font (12.0f, juce::Font::bold));
        g.drawFittedText (button.getButtonText(), button.getLocalBounds(),
                          juce::Justification::centred, 1);
    }

    void drawComboBox (juce::Graphics& g, int width, int height, bool,
                       int, int, int, int, juce::ComboBox&) override
    {
        g.setColour (bgDark());
        g.fillRect (0, 0, width, height);
        juce::Path p;
        const float x = (float) width - 16.0f;
        const float y = (float) height * 0.42f;
        p.addTriangle (x, y, x + 8.0f, y, x + 4.0f, y + 6.0f);
        g.setColour (cyan());
        g.fillPath (p);
    }

    void drawTickBox (juce::Graphics& g, juce::Component&, float x, float y, float w, float h,
                      bool ticked, bool, bool, bool) override
    {
        auto r = juce::Rectangle<float> (x, y, w, h).reduced (1.0f);
        g.setColour (bgDark());
        g.fillRoundedRectangle (r, 2.0f);
        if (ticked)
        {
            g.setColour (cyan());
            g.fillRoundedRectangle (r.reduced (3.0f), 1.5f);
        }
    }

    void drawLinearSlider (juce::Graphics& g, int x, int y, int width, int height,
                           float sliderPos, float, float, const juce::Slider::SliderStyle,
                           juce::Slider& slider) override
    {
        auto track = juce::Rectangle<float> ((float) x, (float) y + (float) height * 0.4f,
                                             (float) width, 4.0f);
        g.setColour (bgDark());
        g.fillRect (track);
        g.setColour (cyan());
        g.fillRect (track.withWidth (juce::jmax (0.0f, sliderPos - (float) x)));
        auto thumb = juce::Rectangle<float> (sliderPos - 5.0f, (float) y + 4.0f, 10.0f, (float) height - 8.0f);
        g.setColour (juce::Colours::whitesmoke);
        g.fillRect (thumb);
        g.setColour (cyan());
        g.fillRect (thumb.withHeight (2.0f).withY (thumb.getCentreY() - 1.0f));
        juce::ignoreUnused (slider);
    }

    void drawScrollbar (juce::Graphics& g, juce::ScrollBar&, int x, int y, int width, int height,
                        bool isScrollbarVertical, int thumbStartPosition, int thumbSize,
                        bool, bool) override
    {
        g.setColour (bgDark());
        g.fillRect (x, y, width, height);
        g.setColour (cyan());
        if (isScrollbarVertical)
            g.fillRect (x + 1, thumbStartPosition, juce::jmax (3, width - 2), thumbSize);
        else
            g.fillRect (thumbStartPosition, y + 1, thumbSize, juce::jmax (3, height - 2));
    }

    int getDefaultScrollbarWidth() override { return 8; }
};

class LiveMixStreamPluginEditor  : public juce::AudioProcessorEditor,
                                    private juce::Timer
{
public:
    explicit LiveMixStreamPluginEditor (LiveMixStreamAudioProcessor&);
    ~LiveMixStreamPluginEditor() override;

    void paint (juce::Graphics&) override;
    void resized() override;

private:
    void timerCallback() override;
    void updateUIState();
    void syncFromProcessor();

    LiveMixStreamAudioProcessor& audioProcessor;
    StudioLookAndFeel m_lnf;

    juce::Label m_titleLabel;
    juce::Label m_statusBadge;

    juce::Label m_trackNameLabel;
    juce::TextEditor m_trackNameInput;

    juce::ToggleButton m_masterToggle;

    juce::Label m_duckStateLabel;
    struct DuckStateBox : public juce::Component
    {
        std::function<void()> onClick;
        juce::String trackName { "Track" };
        bool unducked = true;
        bool linked = false;

        void setState (const juce::String& name, bool isUnducked, bool isLinked)
        {
            trackName = name;
            unducked = isUnducked;
            linked = isLinked;
            repaint();
        }

        void paint (juce::Graphics& g) override
        {
            auto r = getLocalBounds().toFloat().reduced (1.0f);
            const auto green = juce::Colour (0xff10b981);
            if (unducked)
            {
                g.setColour (green.withAlpha (linked ? 0.18f : 0.10f));
                g.fillRoundedRectangle (r, 10.0f);
                g.setColour (green.withAlpha (linked ? 0.28f : 0.15f));
                g.drawRoundedRectangle (r.expanded (1.5f), 11.0f, 2.0f);
                g.setColour (green.withAlpha (linked ? 1.0f : 0.55f));
                g.drawRoundedRectangle (r, 10.0f, 1.5f);
                g.setColour (StudioLookAndFeel::text().withAlpha (linked ? 1.0f : 0.7f));
            }
            else
            {
                g.setColour (juce::Colour (0xff0f172a).withAlpha (0.65f));
                g.fillRoundedRectangle (r, 10.0f);
                g.setColour (juce::Colour (0xff6366f1).withAlpha (0.35f));
                g.drawRoundedRectangle (r, 10.0f, 1.0f);
                g.setColour (StudioLookAndFeel::muted().withAlpha (0.55f));
            }

            g.setFont (juce::Font (juce::Font::getDefaultSansSerifFontName(), 14.0f, juce::Font::bold));
            g.drawFittedText (trackName.isNotEmpty() ? trackName : "Track",
                              getLocalBounds().reduced (8, 4),
                              juce::Justification::centred, 2);
        }

        void mouseDown (const juce::MouseEvent&) override
        {
            if (onClick)
                onClick();
        }

        void mouseEnter (const juce::MouseEvent&) override { setMouseCursor (juce::MouseCursor::PointingHandCursor); }
        void mouseExit (const juce::MouseEvent&) override { setMouseCursor (juce::MouseCursor::NormalCursor); }
    };
    DuckStateBox m_duckStateBox;
    juce::Label m_duckStateHint;

    juce::Label m_duckLabel;
    juce::Slider m_duckSlider;
    juce::Label m_fadeLabel;
    juce::Slider m_fadeSlider;

    juce::Label m_serverUrlLabel;
    juce::TextEditor m_serverUrlInput;

    juce::Label m_sessionNameLabel;
    juce::TextEditor m_sessionNameInput;
    juce::TextButton m_actionButton;
    juce::Label m_urlLabel;
    juce::TextEditor m_urlDisplay;
    juce::TextButton m_copyUrlButton;

    juce::Label m_qualityLabel;
    juce::ComboBox m_qualitySelector;

    juce::Label m_listenersMetricLabel;
    juce::Label m_latencyMetricLabel;
    juce::Label m_bitrateMetricLabel;
    juce::Label m_connectionLabel;

    juce::Label m_tracksLabel;
    juce::Label m_tracksHint;

    struct TrackGridPanel : public juce::Component
    {
        std::function<void(const std::string&)> onTrackClick;

        void setTracks (std::vector<ListedTrack> tracks)
        {
            m_tracks = std::move (tracks);
            repaint();
        }

        juce::Rectangle<float> cellBounds (size_t index) const
        {
            constexpr int cols = 3;
            constexpr int gap = 8;
            constexpr int pad = 8;
            const int rows = (int) ((m_tracks.size() + (size_t) cols - 1) / (size_t) cols);
            const int cellW = juce::jmax (1, (getWidth() - pad * 2 - gap * (cols - 1)) / cols);
            const int cellH = juce::jmax (1, (getHeight() - pad * 2 - gap * juce::jmax (0, rows - 1)) / juce::jmax (1, rows));
            const int col = (int) (index % (size_t) cols);
            const int row = (int) (index / (size_t) cols);
            return juce::Rectangle<float> ((float) (pad + col * (cellW + gap)),
                                          (float) (pad + row * (cellH + gap)),
                                          (float) cellW,
                                          (float) cellH);
        }

        void paint (juce::Graphics& g) override
        {
            g.fillAll (StudioLookAndFeel::bgDark());
            if (m_tracks.empty())
            {
                g.setColour (StudioLookAndFeel::muted());
                g.setFont (juce::Font (juce::Font::getDefaultSansSerifFontName(), 12.0f, juce::Font::plain));
                g.drawText ("No Track Control plugins linked", getLocalBounds().reduced (8),
                            juce::Justification::centred);
                return;
            }

            for (size_t i = 0; i < m_tracks.size(); ++i)
            {
                auto r = cellBounds (i);
                const bool lit = m_tracks[i].unducked;
                const auto green = juce::Colour (0xff10b981);

                if (lit)
                {
                    g.setColour (green.withAlpha (0.18f));
                    g.fillRoundedRectangle (r, 10.0f);
                    g.setColour (green.withAlpha (0.28f));
                    g.drawRoundedRectangle (r.expanded (1.5f), 11.0f, 2.0f);
                    g.setColour (green);
                    g.drawRoundedRectangle (r, 10.0f, 1.5f);
                    g.setColour (StudioLookAndFeel::text());
                }
                else
                {
                    g.setColour (juce::Colour (0xff0f172a).withAlpha (0.65f));
                    g.fillRoundedRectangle (r, 10.0f);
                    g.setColour (juce::Colour (0xff6366f1).withAlpha (0.35f));
                    g.drawRoundedRectangle (r, 10.0f, 1.0f);
                    g.setColour (StudioLookAndFeel::muted().withAlpha (0.55f));
                }

                g.setFont (juce::Font (juce::Font::getDefaultSansSerifFontName(), 12.0f, juce::Font::bold));
                g.drawFittedText (juce::String (m_tracks[i].trackName),
                                  r.toNearestIntEdges().reduced (4),
                                  juce::Justification::centred, 2);
            }
        }

        void mouseDown (const juce::MouseEvent& e) override
        {
            if (! onTrackClick)
                return;
            for (size_t i = 0; i < m_tracks.size(); ++i)
            {
                if (cellBounds (i).contains (e.position))
                {
                    onTrackClick (m_tracks[i].instanceId);
                    return;
                }
            }
        }

        void mouseMove (const juce::MouseEvent& e) override
        {
            bool over = false;
            for (size_t i = 0; i < m_tracks.size(); ++i)
            {
                if (cellBounds (i).contains (e.position))
                {
                    over = true;
                    break;
                }
            }
            setMouseCursor (over ? juce::MouseCursor::PointingHandCursor
                                 : juce::MouseCursor::NormalCursor);
        }

        std::vector<ListedTrack> m_tracks;
    };

    TrackGridPanel m_trackGrid;

    std::vector<ListedTrack> m_cachedTracks;

    bool m_copyFlash = false;
    bool m_lastStreamingLayout = false;
    bool m_lastShowMaster = true;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (LiveMixStreamPluginEditor)
};

} // namespace LiveMixStream
