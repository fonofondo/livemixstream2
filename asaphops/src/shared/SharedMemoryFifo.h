#pragma once

#include <juce_core/juce_core.h>
#include <atomic>
#include <cstdint>

namespace AsaphOps {

inline juce::String shmNameForPlugin (const juce::String& instanceId)
{
    auto hex = instanceId.removeCharacters ("-").toLowerCase();
    return "/ao" + hex.substring (0, 20);
}

class SharedMemoryFifo
{
public:
    static constexpr uint32_t kMagic = 0x41305348; // AOSH
    static constexpr uint32_t kVersion = 1;
    static constexpr uint32_t kDefaultCapacityFrames = 16384;
    static constexpr uint32_t kChannels = 2;

    SharedMemoryFifo() = default;
    ~SharedMemoryFifo();

    SharedMemoryFifo (const SharedMemoryFifo&) = delete;
    SharedMemoryFifo& operator= (const SharedMemoryFifo&) = delete;

    bool createWriter (const juce::String& name,
                       uint32_t capacityFrames,
                       uint32_t channels,
                       uint32_t sampleRate);
    bool openReader (const juce::String& name);
    void close();
    void unlinkSegment();

    bool isOpen() const { return mapped != nullptr; }
    juce::String getName() const { return name; }
    uint32_t getCapacityFrames() const;
    uint32_t getChannels() const;
    uint32_t getSampleRate() const;

    // Audio thread: never allocates or blocks.
    bool writePlanar (const float* const* channels, int numChannels, int numFrames);

    // Companion reader thread.
    int readInterleaved (float* dest, int maxFrames);

private:
    struct Header
    {
        uint32_t magic;
        uint32_t version;
        uint32_t capacityFrames;
        uint32_t channels;
        uint32_t sampleRate;
        uint8_t pad0[44];
        std::atomic<uint32_t> writeIndex;
        uint8_t pad1[60];
        std::atomic<uint32_t> readIndex;
        uint8_t pad2[60];
    };

    static_assert (sizeof (Header) == 192, "SHM header must stay 192 bytes");

    bool map (const juce::String& name, bool create, uint32_t capacityFrames, uint32_t channels, uint32_t sampleRate);
    Header* header() const { return static_cast<Header*> (mapped); }
    float* samples() const { return reinterpret_cast<float*> (static_cast<char*> (mapped) + sizeof (Header)); }
    uint32_t writeAvailable() const;
    uint32_t readAvailable() const;

    juce::String name;
    void* mapped = nullptr;
    size_t mappedBytes = 0;
    bool isWriter = false;
   #if JUCE_WINDOWS
    void* mappingHandle = nullptr;
   #else
    int fd = -1;
   #endif
};

} // namespace AsaphOps
