#pragma once

#include <juce_gui_extra/juce_gui_extra.h>

namespace AsaphOps {

class CompanionApp;

class TrayIcon : public juce::SystemTrayIconComponent
{
public:
    explicit TrayIcon (CompanionApp& app);
    void mouseDown (const juce::MouseEvent& event) override;

private:
    static juce::Image makeIcon();
    CompanionApp& app;
};

} // namespace AsaphOps
