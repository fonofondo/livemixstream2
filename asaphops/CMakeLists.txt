cmake_minimum_required(VERSION 3.22)
project(AsaphOps VERSION 0.1.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

if(APPLE)
    # No paid Apple Developer account required. Ad-hoc sign after build.
    if(NOT CMAKE_OSX_DEPLOYMENT_TARGET)
        set(CMAKE_OSX_DEPLOYMENT_TARGET "10.15" CACHE STRING "Minimum macOS")
    endif()
    if(NOT CMAKE_OSX_ARCHITECTURES)
        set(CMAKE_OSX_ARCHITECTURES "arm64;x86_64" CACHE STRING "Universal2")
    endif()
    set(CMAKE_XCODE_ATTRIBUTE_CODE_SIGN_IDENTITY "-" CACHE STRING "")
    set(CMAKE_XCODE_ATTRIBUTE_CODE_SIGNING_REQUIRED "NO" CACHE STRING "")
    set(CMAKE_XCODE_ATTRIBUTE_DEVELOPMENT_TEAM "" CACHE STRING "")
endif()

include(FetchContent)
FetchContent_Declare(
    JUCE
    GIT_REPOSITORY https://github.com/juce-framework/JUCE.git
    GIT_TAG        8.0.8
    GIT_SHALLOW    TRUE
)
FetchContent_MakeAvailable(JUCE)

set(ASAPHOPS_SHARED_SOURCES
    src/shared/Protocol.cpp
    src/shared/MachineIdentity.cpp
    src/shared/SharedMemoryFifo.cpp
)

if(WIN32)
    set(_asaphops_needs_curl FALSE)
    set(_asaphops_use_curl 0)
else()
    set(_asaphops_needs_curl TRUE)
    set(_asaphops_use_curl 1)
endif()

juce_add_gui_app(AsaphOpsCompanion
    COMPANY_NAME "AsaphOps"
    BUNDLE_ID "com.asaphops.companion"
    PRODUCT_NAME "AsaphOps"
    NEEDS_CURL ${_asaphops_needs_curl}
    HARDENED_RUNTIME_ENABLED FALSE
    DOCUMENT_EXTENSIONS ""
)

target_sources(AsaphOpsCompanion PRIVATE
    ${ASAPHOPS_SHARED_SOURCES}
    src/companion/Main.cpp
    src/companion/App.cpp
    src/companion/Autostart.cpp
    src/companion/IPCServer/IPCServer.cpp
    src/companion/ProjectRegistry/ProjectRegistry.cpp
    src/companion/SessionManager/SessionManager.cpp
    src/companion/Network/OpsClient.cpp
    src/companion/Network/LiveConnection.cpp
    src/companion/Media/MediaEngine.cpp
    src/companion/Mackie/MackieSurface.cpp
    src/companion/UI/MainWindow.cpp
    src/companion/UI/MixerBoard.cpp
    src/companion/UI/TrayIcon.cpp
)

target_include_directories(AsaphOpsCompanion PRIVATE src src/companion)

if(APPLE)
    set(_asaphops_alsa 0)
else()
    set(_asaphops_alsa 1)
endif()

target_compile_definitions(AsaphOpsCompanion PRIVATE
    JUCE_WEB_BROWSER=0
    JUCE_USE_CURL=${_asaphops_use_curl}
    JUCE_ALSA=${_asaphops_alsa}
    JUCE_JACK=0
    JUCE_APPLICATION_NAME_STRING="$<TARGET_PROPERTY:AsaphOpsCompanion,JUCE_PRODUCT_NAME>"
    JUCE_APPLICATION_VERSION_STRING="$<TARGET_PROPERTY:AsaphOpsCompanion,JUCE_VERSION>"
)

target_link_libraries(AsaphOpsCompanion PRIVATE
    juce::juce_gui_extra
    juce::juce_audio_devices
    juce::juce_recommended_config_flags
    juce::juce_recommended_lto_flags
    juce::juce_recommended_warning_flags
)

if(UNIX AND NOT APPLE)
    target_link_libraries(AsaphOpsCompanion PRIVATE rt)
endif()

find_package(PkgConfig QUIET)
set(ASAPHOPS_HAS_OPUS 0)
if(PkgConfig_FOUND)
    pkg_check_modules(OPUS IMPORTED_TARGET opus)
    if(OPUS_FOUND)
        set(ASAPHOPS_HAS_OPUS 1)
    endif()
endif()
if(NOT ASAPHOPS_HAS_OPUS)
    find_path(OPUS_INCLUDE_DIR opus/opus.h)
    find_library(OPUS_LIBRARY opus)
    if(OPUS_INCLUDE_DIR AND OPUS_LIBRARY)
        set(ASAPHOPS_HAS_OPUS 1)
        set(OPUS_INCLUDE_DIRS ${OPUS_INCLUDE_DIR})
        set(OPUS_LIBRARIES ${OPUS_LIBRARY})
    endif()
endif()
if(ASAPHOPS_HAS_OPUS)
    if(TARGET PkgConfig::OPUS)
        target_link_libraries(AsaphOpsCompanion PRIVATE PkgConfig::OPUS)
    else()
        target_include_directories(AsaphOpsCompanion PRIVATE ${OPUS_INCLUDE_DIRS})
        target_link_libraries(AsaphOpsCompanion PRIVATE ${OPUS_LIBRARIES})
    endif()
    message(STATUS "AsaphOps companion: linking libopus")
else()
    message(WARNING "AsaphOps companion: libopus not found — PCM WebSocket fallback only")
endif()

set(ASAPHOPS_PLUGIN_FORMATS VST3)
if(APPLE)
    list(APPEND ASAPHOPS_PLUGIN_FORMATS AU)
endif()

option(ASAPHOPS_COPY_PLUGIN "Copy plugin into the system plug-ins folder after build" ON)
if(DEFINED ENV{GITHUB_ACTIONS})
    set(ASAPHOPS_COPY_PLUGIN OFF)
endif()

juce_add_plugin(AsaphOpsPlugin
    COMPANY_NAME "AsaphOps"
    BUNDLE_ID "com.asaphops.plugin"
    IS_SYNTH FALSE
    NEEDS_MIDI_INPUT FALSE
    NEEDS_MIDI_OUTPUT FALSE
    IS_MIDI_EFFECT FALSE
    EDITOR_WANTS_KEYBOARD_FOCUS TRUE
    COPY_PLUGIN_AFTER_BUILD ${ASAPHOPS_COPY_PLUGIN}
    HARDENED_RUNTIME_ENABLED FALSE
    PLUGIN_MANUFACTURER_CODE Asph
    PLUGIN_CODE Aop1
    FORMATS ${ASAPHOPS_PLUGIN_FORMATS}
    PRODUCT_NAME "AsaphOps"
)

target_sources(AsaphOpsPlugin PRIVATE
    ${ASAPHOPS_SHARED_SOURCES}
    src/plugin/PluginProcessor.cpp
    src/plugin/PluginEditor.cpp
    src/plugin/IPCClient/IPCClient.cpp
)

target_include_directories(AsaphOpsPlugin PRIVATE src src/plugin)

target_compile_definitions(AsaphOpsPlugin PUBLIC
    JUCE_WEB_BROWSER=0
    JUCE_USE_CURL=0
    JUCE_VST3_CAN_REPLACE_VST2=0
)

target_link_libraries(AsaphOpsPlugin PRIVATE
    juce::juce_audio_utils
    juce::juce_audio_processors
    juce::juce_gui_basics
    juce::juce_recommended_config_flags
    juce::juce_recommended_lto_flags
    juce::juce_recommended_warning_flags
)

if(UNIX AND NOT APPLE)
    target_link_libraries(AsaphOpsPlugin PRIVATE rt)
endif()

if(APPLE)
    foreach(_asaphops_bundle AsaphOpsCompanion AsaphOpsPlugin_VST3 AsaphOpsPlugin_AU)
        if(TARGET ${_asaphops_bundle})
            add_custom_command(TARGET ${_asaphops_bundle} POST_BUILD
                COMMAND codesign --force --deep --sign - --timestamp=none "$<TARGET_BUNDLE_DIR:${_asaphops_bundle}>"
                COMMENT "Ad-hoc codesign ${_asaphops_bundle} (no Developer ID)"
                VERBATIM)
        endif()
    endforeach()
endif()
