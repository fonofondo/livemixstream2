#pragma once

#include <juce_gui_basics/juce_gui_basics.h>
#include "../Mackie/MackieSurface.h"

namespace AsaphOps {

class MixerBoard : public juce::Component,
                   private juce::Timer
{
public:
    explicit MixerBoard (MackieSurface& surface);
    ~MixerBoard() override;

    void resized() override;
    void paint (juce::Graphics& g) override;

private:
    class FaderStrip;
    void timerCallback() override;
    void rebuild (const juce::Array<MackieSurface::MixerTrack>& tracks);

    MackieSurface& mackie;
    juce::Viewport viewport;
    juce::Component stripRow;
    juce::OwnedArray<FaderStrip> strips;
    juce::String lastLayoutKey;
};

} // namespace AsaphOps
