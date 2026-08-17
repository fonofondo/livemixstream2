#include "TrayIcon.h"
#include "../App.h"

namespace AsaphOps {

juce::Image TrayIcon::makeIcon()
{
    juce::Image img (juce::Image::ARGB, 32, 32, true);
    juce::Graphics g (img);
    g.setColour (juce::Colour (0xff3d7ea6));
    g.fillEllipse (2.0f, 2.0f, 28.0f, 28.0f);
    g.setColour (juce::Colours::white);
    g.setFont (juce::Font (16.0f, juce::Font::bold));
    g.drawText ("A", juce::Rectangle<int> (0, 0, 32, 32), juce::Justification::centred, false);
    return img;
}

TrayIcon::TrayIcon (CompanionApp& appIn)
    : app (appIn)
{
    auto icon = makeIcon();
    setIconImage (icon, icon);
    setIconTooltip ("AsaphOps Companion");
}

void TrayIcon::mouseDown (const juce::MouseEvent&)
{
    juce::PopupMenu menu;
    menu.addItem ("Open AsaphOps", [this] { app.showMainWindow(); });
    menu.addSeparator();
    menu.addItem ("Quit", [] { juce::JUCEApplication::getInstance()->systemRequestedQuit(); });
   #if JUCE_MAC
    showDropdownMenu (menu);
   #else
    menu.showMenuAsync (juce::PopupMenu::Options().withTargetComponent (this));
   #endif
}

} // namespace AsaphOps
