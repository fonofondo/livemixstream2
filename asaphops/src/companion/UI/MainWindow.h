#pragma once

#include <juce_gui_basics/juce_gui_basics.h>
#include <juce_gui_extra/juce_gui_extra.h>

namespace AsaphOps {

class CompanionApp;

class MainWindow : public juce::DocumentWindow
{
public:
    explicit MainWindow (CompanionApp& app);
    void closeButtonPressed() override;
};

} // namespace AsaphOps
