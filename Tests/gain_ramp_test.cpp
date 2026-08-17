#include "../Source/Hierarchy/GainRamp.h"
#include <cassert>
#include <cmath>
#include <iostream>
#include <vector>

using LiveMixStream::GainRamp;

int main()
{
    GainRamp ramp;
    ramp.prepare(48000.0);
    ramp.setTarget(0.3f, 200);

    std::vector<float> L(480, 1.0f);
    std::vector<float> R(480, 1.0f);
    float* ch[2] = { L.data(), R.data() };

    // 200ms @ 48k = 9600 samples; process in blocks
    for (int b = 0; b < 25; ++b)
        ramp.apply(ch, 2, 480);

    assert(std::abs(ramp.getCurrentGain() - 0.3f) < 0.02f);

    // Interrupt mid-fade: from ~0.3 toward 1.0
    ramp.setTarget(1.0f, 100);
    float before = ramp.getCurrentGain();
    ramp.apply(ch, 2, 480);
    float after = ramp.getCurrentGain();
    assert(after >= before);

    // Hold at target
    for (int b = 0; b < 20; ++b)
        ramp.apply(ch, 2, 480);
    assert(std::abs(ramp.getCurrentGain() - 1.0f) < 0.02f);

    std::cout << "gain_ramp_test OK\n";
    return 0;
}
