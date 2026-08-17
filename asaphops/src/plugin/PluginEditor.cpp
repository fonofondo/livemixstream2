#include "PluginEditor.h"

namespace AsaphOps {

PluginEditor::PluginEditor (PluginProcessor& p)
    : juce::AudioProcessorEditor (&p),
      proc (p)
{
    setSize (400, 180);
    title.setText ("AsaphOps", juce::dontSendNotification);
    title.setFont (juce::Font { juce::FontOptions (22.0f, juce::Font::bold) });
    title.setColour (juce::Label::textColourId, juce::Colours::white);
    hint.setFont (juce::Font { juce::FontOptions (13.0f) });
    hint.setColour (juce::Label::textColourId, juce::Colours::grey);
    hint.setText ("Put this on the master bus. Track faders are in the companion Mixer tab.",
                  juce::dontSendNotification);

    for (auto* label : { &title, &status, &project, &listen, &hint })
    {
        label->setJustificationType (juce::Justification::centredLeft);
        addAndMakeVisible (label);
    }

    startTimerHz (8);
}

void PluginEditor::paint (juce::Graphics& g)
{
    g.fillAll (juce::Colour (0xff1b1f24));
}

void PluginEditor::resized()
{
    auto area = getLocalBounds().reduced (16);
    title.setBounds (area.removeFromTop (28));
    area.removeFromTop (8);
    status.setBounds (area.removeFromTop (22));
    project.setBounds (area.removeFromTop (22));
    listen.setBounds (area.removeFromTop (22));
    area.removeFromTop (8);
    hint.setBounds (area);
}

void PluginEditor::timerCallback()
{
    auto& c = proc.getClient();
    juce::String st = "Companion: " + c.getStatus();
    if (c.getRoleNote().isNotEmpty())
        st << "  ·  " << c.getRoleNote();
    status.setText (st, juce::dontSendNotification);

    const auto projectId = c.getProjectId();
    project.setText (projectId.isNotEmpty() ? ("Master  ·  " + projectId) : juce::String ("Master"),
                     juce::dontSendNotification);

    auto url = c.getListenUrl();
    listen.setText (url.isNotEmpty() ? ("Listen: " + url) : "Listen: —", juce::dontSendNotification);
}

} // namespace AsaphOps
