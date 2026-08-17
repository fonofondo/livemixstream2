#pragma once

#include <juce_audio_processors/juce_audio_processors.h>
#include "PluginProcessor.h"

namespace AsaphOps {

class PluginEditor : public juce::AudioProcessorEditor,
                     private juce::Timer
{
public:
    explicit PluginEditor (PluginProcessor& processor);
    void paint (juce::Graphics& g) override;
    void resized() override;

private:
    void timerCallback() override;

    PluginProcessor& proc;
    juce::Label title, status, project, listen, hint;
};

} // namespace AsaphOps
