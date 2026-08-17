#include "SharedMemoryFifo.h"
#include <cstring>

#if JUCE_WINDOWS
 #include <windows.h>
#else
 #include <fcntl.h>
 #include <sys/mman.h>
 #include <sys/stat.h>
 #include <unistd.h>
#endif

namespace AsaphOps {

namespace {

juce::String osName (const juce::String& posixName)
{
   #if JUCE_WINDOWS
    return "Local\\" + posixName.substring (1);
   #else
    return posixName;
   #endif
}

} // namespace

SharedMemoryFifo::~SharedMemoryFifo()
{
    close();
}

uint32_t SharedMemoryFifo::getCapacityFrames() const
{
    return header() != nullptr ? header()->capacityFrames : 0;
}

uint32_t SharedMemoryFifo::getChannels() const
{
    return header() != nullptr ? header()->channels : 0;
}

uint32_t SharedMemoryFifo::getSampleRate() const
{
    return header() != nullptr ? header()->sampleRate : 0;
}

uint32_t SharedMemoryFifo::writeAvailable() const
{
    auto* h = header();
    if (h == nullptr)
        return 0;
    const uint32_t cap = h->capacityFrames;
    const uint32_t w = h->writeIndex.load (std::memory_order_relaxed);
    const uint32_t r = h->readIndex.load (std::memory_order_acquire);
    return (r + cap - w - 1u) % cap;
}

uint32_t SharedMemoryFifo::readAvailable() const
{
    auto* h = header();
    if (h == nullptr)
        return 0;
    const uint32_t cap = h->capacityFrames;
    const uint32_t w = h->writeIndex.load (std::memory_order_acquire);
    const uint32_t r = h->readIndex.load (std::memory_order_relaxed);
    return (w + cap - r) % cap;
}

bool SharedMemoryFifo::createWriter (const juce::String& newName, uint32_t capacityFrames,
                                     uint32_t channels, uint32_t sampleRate)
{
    close();
    isWriter = true;
    return map (newName, true, capacityFrames, channels, sampleRate);
}

bool SharedMemoryFifo::openReader (const juce::String& newName)
{
    close();
    isWriter = false;
    return map (newName, false, 0, 0, 0);
}

bool SharedMemoryFifo::map (const juce::String& newName, bool create,
                            uint32_t capacityFrames, uint32_t channels, uint32_t sampleRate)
{
    name = newName;
    if (create)
    {
        if (capacityFrames < 1024)
            capacityFrames = kDefaultCapacityFrames;
        if (channels == 0)
            channels = kChannels;
    }

   #if JUCE_WINDOWS
    const auto winName = osName (newName);
    if (create)
    {
        mappedBytes = sizeof (Header) + (size_t) capacityFrames * channels * sizeof (float);
        mappingHandle = CreateFileMappingW (INVALID_HANDLE_VALUE, nullptr, PAGE_READWRITE,
                                            0, (DWORD) mappedBytes, winName.toWideCharPointer());
        if (mappingHandle == nullptr)
            return false;
        mapped = MapViewOfFile (mappingHandle, FILE_MAP_ALL_ACCESS, 0, 0, mappedBytes);
        if (mapped == nullptr)
        {
            CloseHandle (mappingHandle);
            mappingHandle = nullptr;
            return false;
        }
        std::memset (mapped, 0, mappedBytes);
        auto* h = header();
        h->magic = kMagic;
        h->version = kVersion;
        h->capacityFrames = capacityFrames;
        h->channels = channels;
        h->sampleRate = sampleRate;
        h->writeIndex.store (0, std::memory_order_relaxed);
        h->readIndex.store (0, std::memory_order_relaxed);
        return true;
    }

    mappingHandle = OpenFileMappingW (FILE_MAP_ALL_ACCESS, FALSE, winName.toWideCharPointer());
    if (mappingHandle == nullptr)
        return false;
    mapped = MapViewOfFile (mappingHandle, FILE_MAP_ALL_ACCESS, 0, 0, 0);
    if (mapped == nullptr)
    {
        CloseHandle (mappingHandle);
        mappingHandle = nullptr;
        return false;
    }
    auto* h = header();
    if (h->magic != kMagic || h->version != kVersion)
    {
        close();
        return false;
    }
    mappedBytes = sizeof (Header) + (size_t) h->capacityFrames * h->channels * sizeof (float);
    return true;
   #else
    const auto posix = osName (newName).toRawUTF8();
    if (create)
    {
        shm_unlink (posix);
        fd = shm_open (posix, O_CREAT | O_RDWR | O_EXCL, 0600);
        if (fd < 0)
        {
            fd = shm_open (posix, O_CREAT | O_RDWR, 0600);
            if (fd < 0)
                return false;
        }
        mappedBytes = sizeof (Header) + (size_t) capacityFrames * channels * sizeof (float);
        if (ftruncate (fd, (off_t) mappedBytes) != 0)
        {
            ::close (fd);
            fd = -1;
            return false;
        }
        mapped = mmap (nullptr, mappedBytes, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
        if (mapped == MAP_FAILED)
        {
            mapped = nullptr;
            ::close (fd);
            fd = -1;
            return false;
        }
        std::memset (mapped, 0, mappedBytes);
        auto* h = header();
        h->magic = kMagic;
        h->version = kVersion;
        h->capacityFrames = capacityFrames;
        h->channels = channels;
        h->sampleRate = sampleRate;
        h->writeIndex.store (0, std::memory_order_relaxed);
        h->readIndex.store (0, std::memory_order_relaxed);
        return true;
    }

    fd = shm_open (posix, O_RDWR, 0600);
    if (fd < 0)
        return false;
    struct stat st {};
    if (fstat (fd, &st) != 0 || st.st_size < (off_t) sizeof (Header))
    {
        ::close (fd);
        fd = -1;
        return false;
    }
    mappedBytes = (size_t) st.st_size;
    mapped = mmap (nullptr, mappedBytes, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    if (mapped == MAP_FAILED)
    {
        mapped = nullptr;
        ::close (fd);
        fd = -1;
        return false;
    }
    auto* h = header();
    if (h->magic != kMagic || h->version != kVersion)
    {
        close();
        return false;
    }
    return true;
   #endif
}

void SharedMemoryFifo::close()
{
    const auto toUnlink = isWriter ? name : juce::String();
   #if JUCE_WINDOWS
    if (mapped != nullptr)
    {
        UnmapViewOfFile (mapped);
        mapped = nullptr;
    }
    if (mappingHandle != nullptr)
    {
        CloseHandle (mappingHandle);
        mappingHandle = nullptr;
    }
   #else
    if (mapped != nullptr)
    {
        munmap (mapped, mappedBytes);
        mapped = nullptr;
    }
    if (fd >= 0)
    {
        ::close (fd);
        fd = -1;
    }
    if (toUnlink.isNotEmpty())
        shm_unlink (osName (toUnlink).toRawUTF8());
   #endif
    mappedBytes = 0;
    isWriter = false;
    name.clear();
}

void SharedMemoryFifo::unlinkSegment()
{
    if (name.isEmpty())
        return;
   #if ! JUCE_WINDOWS
    shm_unlink (osName (name).toRawUTF8());
   #endif
}

bool SharedMemoryFifo::writePlanar (const float* const* channels, int numChannels, int numFrames)
{
    auto* h = header();
    if (h == nullptr || numFrames <= 0 || channels == nullptr)
        return false;

    const uint32_t cap = h->capacityFrames;
    const uint32_t ch = h->channels;
    if ((uint32_t) numFrames > writeAvailable())
        return false;

    uint32_t w = h->writeIndex.load (std::memory_order_relaxed);
    auto* buf = samples();
    const int useCh = juce::jmin (numChannels, (int) ch);

    for (int i = 0; i < numFrames; ++i)
    {
        const uint32_t base = w * ch;
        for (uint32_t c = 0; c < ch; ++c)
            buf[base + c] = (c < (uint32_t) useCh && channels[c] != nullptr) ? channels[c][i] : 0.0f;
        w = (w + 1u) % cap;
    }

    h->writeIndex.store (w, std::memory_order_release);
    return true;
}

int SharedMemoryFifo::readInterleaved (float* dest, int maxFrames)
{
    auto* h = header();
    if (h == nullptr || dest == nullptr || maxFrames <= 0)
        return 0;

    const uint32_t cap = h->capacityFrames;
    const uint32_t ch = h->channels;
    const uint32_t avail = readAvailable();
    const uint32_t n = juce::jmin ((uint32_t) maxFrames, avail);
    if (n == 0)
        return 0;

    uint32_t r = h->readIndex.load (std::memory_order_relaxed);
    auto* buf = samples();
    for (uint32_t i = 0; i < n; ++i)
    {
        const uint32_t base = r * ch;
        for (uint32_t c = 0; c < ch; ++c)
            dest[i * ch + c] = buf[base + c];
        r = (r + 1u) % cap;
    }
    h->readIndex.store (r, std::memory_order_release);
    return (int) n;
}

} // namespace AsaphOps
