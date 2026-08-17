#pragma once

#include <atomic>
#include <algorithm>
#include <cmath>

namespace LiveMixStream {

/**
 * Sample-accurate gain ramp for hierarchy ducking.
 * setTarget() is safe from non-audio threads; apply() is audio-thread only.
 */
class GainRamp
{
public:
    GainRamp()
    {
        m_currentGain.store (1.0f, std::memory_order_relaxed);
        m_targetGain.store (1.0f, std::memory_order_relaxed);
        m_fadeMs.store (200, std::memory_order_relaxed);
        m_sampleRate.store (48000.0, std::memory_order_relaxed);
        m_step.store (0.0f, std::memory_order_relaxed);
    }

    void prepare (double sampleRate)
    {
        m_sampleRate.store (sampleRate > 0.0 ? sampleRate : 48000.0, std::memory_order_relaxed);
        recalculateStep();
    }

    void setTarget (float targetGain, int fadeDurationMs)
    {
        targetGain = std::clamp (targetGain, 0.0f, 1.0f);
        fadeDurationMs = std::clamp (fadeDurationMs, 50, 1000);
        m_targetGain.store (targetGain, std::memory_order_release);
        m_fadeMs.store (fadeDurationMs, std::memory_order_release);
        recalculateStep();
    }

    void setFadeMs (int fadeDurationMs)
    {
        m_fadeMs.store (std::clamp (fadeDurationMs, 50, 1000), std::memory_order_release);
        recalculateStep();
    }

    float getCurrentGain() const { return m_currentGain.load (std::memory_order_relaxed); }
    float getTargetGain() const { return m_targetGain.load (std::memory_order_relaxed); }

    void apply (float* const* channels, int numChannels, int numSamples)
    {
        float current = m_currentGain.load (std::memory_order_relaxed);
        const float target = m_targetGain.load (std::memory_order_acquire);
        float step = m_step.load (std::memory_order_relaxed);

        if (std::abs (current - target) < 1.0e-6f)
        {
            current = target;
            if (std::abs (current - 1.0f) > 1.0e-6f)
            {
                for (int ch = 0; ch < numChannels; ++ch)
                {
                    float* data = channels[ch];
                    for (int i = 0; i < numSamples; ++i)
                        data[i] *= current;
                }
            }
            m_currentGain.store (current, std::memory_order_relaxed);
            return;
        }

        if ((target > current && step < 0.0f) || (target < current && step > 0.0f) || step == 0.0f)
        {
            const double sr = m_sampleRate.load (std::memory_order_relaxed);
            const int fadeMs = m_fadeMs.load (std::memory_order_relaxed);
            const double frames = std::max (1.0, (sr * fadeMs) / 1000.0);
            step = static_cast<float> ((target - current) / frames);
            m_step.store (step, std::memory_order_relaxed);
        }

        for (int i = 0; i < numSamples; ++i)
        {
            if (step > 0.0f)
                current = std::min (current + step, target);
            else
                current = std::max (current + step, target);

            for (int ch = 0; ch < numChannels; ++ch)
                channels[ch][i] *= current;
        }

        m_currentGain.store (current, std::memory_order_relaxed);
    }

private:
    void recalculateStep()
    {
        const double sr = m_sampleRate.load (std::memory_order_relaxed);
        const int fadeMs = m_fadeMs.load (std::memory_order_relaxed);
        const float current = m_currentGain.load (std::memory_order_relaxed);
        const float target = m_targetGain.load (std::memory_order_relaxed);
        const double frames = std::max (1.0, (sr * fadeMs) / 1000.0);
        m_step.store (static_cast<float> ((target - current) / frames), std::memory_order_relaxed);
    }

    std::atomic<float> m_currentGain;
    std::atomic<float> m_targetGain;
    std::atomic<int> m_fadeMs;
    std::atomic<double> m_sampleRate;
    std::atomic<float> m_step;
};

} // namespace LiveMixStream
