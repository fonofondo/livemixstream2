#include "MixerBoard.h"

namespace AsaphOps {

namespace {
constexpr int kStripW = 64;
constexpr int kStripGap = 6;
}

class MixerBoard::FaderStrip : public juce::Component
{
public:
    FaderStrip (MackieSurface& surface, MackieSurface::MixerTrack trackIn)
        : mackie (surface), track (std::move (trackIn))
    {
        name.setJustificationType (juce::Justification::centred);
        name.setFont (juce::Font (12.0f, juce::Font::bold));
        value.setJustificationType (juce::Justification::centred);
        value.setFont (juce::Font (11.0f));
        addAndMakeVisible (name);
        addAndMakeVisible (value);
        addAndMakeVisible (fader);
        fader.setSliderStyle (juce::Slider::LinearVertical);
        fader.setTextBoxStyle (juce::Slider::NoTextBox, true, 0, 0);
        fader.setRange (-60.0, 10.0, 0.1);
        fader.setDoubleClickReturnValue (true, 0.0);
        fader.setScrollWheelEnabled (true);
        fader.onValueChange = [this]
        {
            if (! fader.isMouseButtonDown() && ! fader.hasKeyboardFocus (true))
                return;
            auto db = (float) fader.getValue();
            if (db <= -59.9f)
                db = -144.0f;
            const bool touching = fader.isMouseButtonDown();
            if (track.isMaster)
                mackie.setMasterDb (db, touching);
            else
                mackie.setTrackDb (track.index, db, touching);
            value.setText (formatDb (db), juce::dontSendNotification);
        };
        sync (track);
    }

    void resized() override
    {
        auto area = getLocalBounds().reduced (2);
        name.setBounds (area.removeFromTop (36));
        value.setBounds (area.removeFromBottom (18));
        fader.setBounds (area);
    }

    void sync (const MackieSurface::MixerTrack& t)
    {
        track = t;
        name.setText (t.name, juce::dontSendNotification);
        if (fader.isMouseButtonDown())
            return;
        const double v = t.known ? juce::jlimit (-60.0, 10.0, (double) t.db) : -60.0;
        fader.setValue (v, juce::dontSendNotification);
        value.setText (t.known ? formatDb (t.db) : "—", juce::dontSendNotification);
    }

    void sendReleaseIfNeeded()
    {
        if (wasTouching && ! fader.isMouseButtonDown())
        {
            auto db = (float) fader.getValue();
            if (db <= -59.9f)
                db = -144.0f;
            if (track.isMaster)
                mackie.setMasterDb (db, false);
            else
                mackie.setTrackDb (track.index, db, false);
        }
        wasTouching = fader.isMouseButtonDown();
    }

private:
    static juce::String formatDb (float db)
    {
        if (db <= -120.0f)
            return "-inf";
        return juce::String (db, 1) + " dB";
    }

    MackieSurface& mackie;
    MackieSurface::MixerTrack track;
    juce::Label name, value;
    juce::Slider fader;
    bool wasTouching = false;
};

MixerBoard::MixerBoard (MackieSurface& surface)
    : mackie (surface)
{
    addAndMakeVisible (viewport);
    viewport.setViewedComponent (&stripRow, false);
    viewport.setScrollBarsShown (false, true);
    startTimerHz (20);
}

MixerBoard::~MixerBoard()
{
    stopTimer();
    viewport.setViewedComponent (nullptr, false);
}

void MixerBoard::paint (juce::Graphics& g)
{
    g.fillAll (juce::Colours::transparentBlack);
}

void MixerBoard::resized()
{
    viewport.setBounds (getLocalBounds());
    stripRow.setSize (juce::jmax (getWidth(), strips.size() * (kStripW + kStripGap) + 12),
                      juce::jmax (120, getHeight()));
    auto area = stripRow.getLocalBounds().reduced (6, 4);
    for (auto* s : strips)
        s->setBounds (area.removeFromLeft (kStripW));
}

void MixerBoard::timerCallback()
{
    auto tracks = mackie.getTracks();
    juce::String key;
    for (auto& t : tracks)
        key << t.index << ":" << t.name << ":" << (int) t.isMaster << "|";
    if (key != lastLayoutKey)
        rebuild (tracks);
    else
    {
        const int n = juce::jmin (strips.size(), tracks.size());
        for (int i = 0; i < n; ++i)
            strips[i]->sync (tracks.getReference (i));
    }
    for (auto* s : strips)
        s->sendReleaseIfNeeded();
}

void MixerBoard::rebuild (const juce::Array<MackieSurface::MixerTrack>& tracks)
{
    lastLayoutKey.clear();
    strips.clear();
    for (auto& t : tracks)
    {
        auto* s = strips.add (new FaderStrip (mackie, t));
        stripRow.addAndMakeVisible (s);
        lastLayoutKey << t.index << ":" << t.name << ":" << (int) t.isMaster << "|";
    }
    resized();
}

} // namespace AsaphOps
