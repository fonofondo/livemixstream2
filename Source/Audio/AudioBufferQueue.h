#pragma once

#include <atomic>
#include <vector>
#include <cstddef>
#include <cstring>

namespace LiveMixStream {

/**
 * @brief Lock-Free Ring Buffer (Single-Producer Single-Consumer)
 * 
 * CRITICAL REQUIREMENTS (FR-080, FR-081, Sec 19/20/38):
 * - Guarantees ZERO memory allocation and ZERO blocking on real-time DAW audio thread.
 * - Decouples audio processing callback from asynchronous network thread.
 */
class LockFreeAudioQueue {
public:
    explicit LockFreeAudioQueue(size_t capacityFrames = 16384, size_t numChannels = 2)
        : m_capacity(capacityFrames * numChannels),
          m_numChannels(numChannels),
          m_buffer(capacityFrames * numChannels, 0.0f),
          m_writeIndex(0),
          m_readIndex(0)
    {
    }

    /**
     * Real-time audio thread producer write operation.
     * NON-BLOCKING & LOCK-FREE.
     */
    bool write(const float* const* inputChannelData, size_t numChannels, size_t numSamples) {
        if (numChannels != m_numChannels) return false;

        size_t available = getWriteAvailable();
        size_t totalSamplesToWrite = numSamples * m_numChannels;
        if (available < totalSamplesToWrite) {
            // Buffer overrun protection (drop samples, never block DAW)
            return false;
        }

        size_t currentWrite = m_writeIndex.load(std::memory_order_relaxed);

        for (size_t i = 0; i < numSamples; ++i) {
            for (size_t ch = 0; ch < m_numChannels; ++ch) {
                m_buffer[currentWrite] = inputChannelData[ch][i];
                currentWrite = (currentWrite + 1) % m_capacity;
            }
        }

        m_writeIndex.store(currentWrite, std::memory_order_release);
        return true;
    }

    /**
     * Asynchronous network worker thread consumer read operation.
     */
    size_t read(float* outputInterleaved, size_t maxSamples) {
        size_t available = getReadAvailable();
        size_t totalSamplesToRead = std::min(maxSamples * m_numChannels, available);
        size_t framesToRead = totalSamplesToRead / m_numChannels;

        size_t currentRead = m_readIndex.load(std::memory_order_relaxed);

        for (size_t i = 0; i < framesToRead * m_numChannels; ++i) {
            outputInterleaved[i] = m_buffer[currentRead];
            currentRead = (currentRead + 1) % m_capacity;
        }

        m_readIndex.store(currentRead, std::memory_order_release);
        return framesToRead;
    }

    size_t getReadAvailable() const {
        size_t write = m_writeIndex.load(std::memory_order_acquire);
        size_t read = m_readIndex.load(std::memory_order_relaxed);
        if (write >= read) {
            return write - read;
        }
        return m_capacity - (read - write);
    }

    size_t getWriteAvailable() const {
        return (m_capacity - 1) - getReadAvailable();
    }

    void reset() {
        m_writeIndex.store(0, std::memory_order_release);
        m_readIndex.store(0, std::memory_order_release);
    }

private:
    const size_t m_capacity;
    const size_t m_numChannels;
    std::vector<float> m_buffer;
    std::atomic<size_t> m_writeIndex;
    std::atomic<size_t> m_readIndex;
};

} // namespace LiveMixStream
