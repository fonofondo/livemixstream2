#include "PluginProcessor.h"
#include "PluginEditor.h"

namespace AsaphOps {

namespace {

juce::String wrapperFormatName (juce::AudioProcessor::WrapperType type)
{
    switch (type)
    {
        case juce::AudioProcessor::wrapperType_VST3: return "VST3";
        case juce::AudioProcessor::wrapperType_AudioUnit: return "AU";
        case juce::AudioProcessor::wrapperType_Standalone: return "Standalone";
        case juce::AudioProcessor::wrapperType_Undefined:
        case juce::AudioProcessor::wrapperType_VST:
        case juce::AudioProcessor::wrapperType_AudioUnitv3:
        case juce::AudioProcessor::wrapperType_AAX:
        case juce::AudioProcessor::wrapperType_Unity:
        case juce::AudioProcessor::wrapperType_LV2:
        default: return "Plugin";
    }
}

} // namespace

PluginProcessor::PluginProcessor()
    : juce::AudioProcessor (BusesProperties()
                            .withInput  ("Input",  juce::AudioChannelSet::stereo(), true)
                            .withOutput ("Output", juce::AudioChannelSet::stereo(), true))
{
    refreshHostInfo();
    client.addChangeListener (this);
    client.setRequestedRole ("master");
    client.startThread();
}

PluginProcessor::~PluginProcessor()
{
    client.removeChangeListener (this);
    teardownMasterRing();
    client.stopThread (2000);
}

void PluginProcessor::refreshHostInfo()
{
    juce::PluginHostType host;
    auto projectName = juce::File (host.getHostPath()).getFileNameWithoutExtension();
    if (projectName.isEmpty())
        projectName = host.getHostDescription();
    client.setPluginInfo (instanceId,
                          wrapperFormatName (wrapperType),
                          host.getHostDescription(),
                          {},
                          host.getHostPath(),
                          {},
                          projectName);
}

void PluginProcessor::updateTrackProperties (const TrackProperties& properties)
{
    client.setTrackName (properties.name);
}

void PluginProcessor::setupMasterRing()
{
    if (client.isConnectedToCompanion() && ! client.isMaster())
        return;

    const auto name = shmNameForPlugin (instanceId);
    const auto sr = (uint32_t) juce::jmax (1.0, currentSampleRate.load());
    if (! shm.createWriter (name, SharedMemoryFifo::kDefaultCapacityFrames, 2, sr))
        return;

    juce::MessageManager::callAsync ([this, name, sr]
    {
        if (client.isConnected())
        {
            client.sendStreamConfig (name, sr, 2, SharedMemoryFifo::kDefaultCapacityFrames);
            client.sendStreamStart();
        }
    });
}

void PluginProcessor::teardownMasterRing()
{
    if (client.isConnected())
        client.sendStreamStop();
    shm.close();
}

void PluginProcessor::changeListenerCallback (juce::ChangeBroadcaster*)
{
    if (client.getAssignedRole() == "master" && prepared.load() && ! shm.isOpen())
        setupMasterRing();
    if (client.getAssignedRole() != "master" && shm.isOpen())
        teardownMasterRing();
}

void PluginProcessor::prepareToPlay (double sampleRate, int samplesPerBlock)
{
    currentSampleRate = sampleRate;
    currentBlockSize = samplesPerBlock;
    prepared = true;
    refreshHostInfo();
    if (client.getRequestedRole() == "master" || client.getAssignedRole() == "master")
        setupMasterRing();
}

void PluginProcessor::releaseResources()
{
    prepared = false;
    teardownMasterRing();
}

bool PluginProcessor::isBusesLayoutSupported (const BusesLayout& layouts) const
{
    if (layouts.getMainOutputChannelSet() != juce::AudioChannelSet::stereo())
        return false;
    if (layouts.getMainInputChannelSet() != juce::AudioChannelSet::stereo())
        return false;
    return true;
}

void PluginProcessor::processBlock (juce::AudioBuffer<float>& buffer, juce::MidiBuffer&)
{
    juce::ScopedNoDenormals noDenormals;
    const auto totalNumInputChannels  = getTotalNumInputChannels();
    const auto totalNumOutputChannels = getTotalNumOutputChannels();
    for (auto i = totalNumInputChannels; i < totalNumOutputChannels; ++i)
        buffer.clear (i, 0, buffer.getNumSamples());

    const int n = buffer.getNumSamples();
    const int ch = juce::jmin (2, buffer.getNumChannels());
    const float* chans[2] = {
        ch > 0 ? buffer.getReadPointer (0) : nullptr,
        ch > 1 ? buffer.getReadPointer (1) : nullptr
    };

    if (client.isMaster() && shm.isOpen())
        shm.writePlanar (chans, ch, n);
}

juce::AudioProcessorEditor* PluginProcessor::createEditor()
{
    return new PluginEditor (*this);
}

void PluginProcessor::getStateInformation (juce::MemoryBlock& destData)
{
    auto xml = std::make_unique<juce::XmlElement> ("AsaphOpsPlugin");
    xml->setAttribute ("instanceId", instanceId);
    copyXmlToBinary (*xml, destData);
}

void PluginProcessor::setStateInformation (const void* data, int sizeInBytes)
{
    auto xml = getXmlFromBinary (data, sizeInBytes);
    if (xml == nullptr)
        return;
    const auto saved = xml->getStringAttribute ("instanceId");
    if (saved.isNotEmpty())
        instanceId = saved;
    client.setRequestedRole ("master");
    refreshHostInfo();
}

} // namespace AsaphOps

juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter()
{
    return new AsaphOps::PluginProcessor();
}
