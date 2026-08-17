#pragma once

#include <juce_core/juce_core.h>
#include "Paths.h"

namespace AsaphOps {

class MachineIdentity
{
public:
    static MachineIdentity& get()
    {
        static MachineIdentity instance;
        return instance;
    }

    juce::String getMachineId() const { return machineId; }

    void loadOrCreate()
    {
        auto f = machineFile();
        if (f.existsAsFile())
        {
            auto json = juce::JSON::parse (f.loadFileAsString());
            machineId = json.getProperty ("machineId", {}).toString();
        }
        if (machineId.isEmpty())
        {
            machineId = juce::Uuid().toDashedString();
            save();
        }
    }

    void save() const
    {
        auto* obj = new juce::DynamicObject();
        obj->setProperty ("machineId", machineId);
        machineFile().replaceWithText (juce::JSON::toString (juce::var (obj), true));
    }

private:
    MachineIdentity() = default;
    juce::String machineId;
};

} // namespace AsaphOps
