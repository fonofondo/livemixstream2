cmake_minimum_required(VERSION 3.22)
project(LiveMixStream VERSION 1.0.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

include(FetchContent)
FetchContent_Declare(
    JUCE
    GIT_REPOSITORY https://github.com/juce-framework/JUCE.git
    GIT_TAG        8.0.8
)
FetchContent_MakeAvailable(JUCE)

set(FORMATS VST3 Standalone)
if(APPLE)
    list(APPEND FORMATS AU)
endif()

juce_add_plugin(LiveMixStream
    COMPANY_NAME "LiveMixStream"
    IS_SYNTH FALSE
    NEEDS_MIDI_INPUT FALSE
    NEEDS_MIDI_OUTPUT FALSE
    IS_MIDI_EFFECT FALSE
    EDITOR_WANTS_KEYBOARD_FOCUS TRUE
    COPY_PLUGIN_AFTER_BUILD TRUE
    PLUGIN_MANUFACTURER_CODE Lmxs
    PLUGIN_CODE Lmxs
    FORMATS ${FORMATS}
    PRODUCT_NAME "LiveMixStream"
)

target_sources(LiveMixStream PRIVATE
    Source/Audio/AudioBufferQueue.h
    Source/Hierarchy/HierarchyTypes.h
    Source/Hierarchy/GainRamp.h
    Source/Session/SessionManager.h
    Source/Network/NetworkClient.h
    Source/Local/LocalProtocol.h
    Source/Local/MasterHub.h
    Source/Local/TrackClient.h
    Source/Plugin/PluginIdentity.h
    Source/Plugin/AudioProcessor.h
    Source/Plugin/AudioProcessor.cpp
    Source/UI/PluginEditor.h
    Source/UI/PluginEditor.cpp
)

find_package(CURL REQUIRED)
find_package(PkgConfig QUIET)
set(LMS_HAS_OPUS 0)
if(PkgConfig_FOUND)
    pkg_check_modules(OPUS opus)
    if(OPUS_FOUND)
        set(LMS_HAS_OPUS 1)
    endif()
endif()
if(NOT LMS_HAS_OPUS)
    find_path(OPUS_INCLUDE_DIR opus/opus.h)
    find_library(OPUS_LIBRARY opus)
    if(OPUS_INCLUDE_DIR AND OPUS_LIBRARY)
        set(LMS_HAS_OPUS 1)
        set(OPUS_INCLUDE_DIRS ${OPUS_INCLUDE_DIR})
        set(OPUS_LIBRARIES ${OPUS_LIBRARY})
    endif()
endif()

target_compile_definitions(LiveMixStream PRIVATE
    JUCE_WEB_BROWSER=0
    JUCE_USE_CURL=1
    JUCE_VST3_CAN_REPLACE_VST2=0
)

target_link_libraries(LiveMixStream PRIVATE
    juce::juce_audio_utils
    juce::juce_audio_processors
    juce::juce_gui_basics
    CURL::libcurl
)

if(LMS_HAS_OPUS)
    target_include_directories(LiveMixStream PRIVATE ${OPUS_INCLUDE_DIRS})
    target_link_libraries(LiveMixStream PRIVATE ${OPUS_LIBRARIES})
    message(STATUS "LiveMixStream: linking libopus")
else()
    message(WARNING "LiveMixStream: libopus not found — PCM fallback encoder will be used")
endif()

# Gain ramp unit test (optional executable)
add_executable(lms_gain_ramp_test Tests/gain_ramp_test.cpp)
target_include_directories(lms_gain_ramp_test PRIVATE Source)

juce_generate_juce_header(LiveMixStream)
