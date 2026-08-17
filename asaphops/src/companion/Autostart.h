#pragma once

#include <juce_core/juce_core.h>

namespace AsaphOps {

bool isAutostartEnabled();
bool setAutostartEnabled (bool enabled, const juce::File& executable);

} // namespace AsaphOps
