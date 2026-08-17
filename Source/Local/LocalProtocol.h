#pragma once

#include <juce_core/juce_core.h>
#include <string>
#include <cctype>
#include <sstream>
#include <locale>
#include <iomanip>

namespace LiveMixStream {
namespace Local {

inline constexpr int kDefaultPort = 18765;
inline constexpr int kPortScanMax = 18775;

inline juce::File portFile()
{
    auto dir = juce::File::getSpecialLocation (juce::File::userApplicationDataDirectory)
                   .getChildFile ("LiveMixStream");
    dir.createDirectory();
    return dir.getChildFile ("master.port");
}

inline void writePortFile (int port)
{
    portFile().replaceWithText (juce::String (port));
}

inline int readPortFile()
{
    auto f = portFile();
    if (! f.existsAsFile())
        return kDefaultPort;
    return f.loadFileAsString().trim().getIntValue();
}

inline std::string jsonFloat (double v)
{
    std::ostringstream os;
    os.imbue (std::locale::classic());
    os << std::setprecision (6) << v;
    return os.str();
}

inline std::string jsonEscape (const std::string& s)
{
    std::string o;
    o.reserve (s.size() + 8);
    for (unsigned char c : s)
    {
        switch (c)
        {
            case '"':  o += "\\\""; break;
            case '\\': o += "\\\\"; break;
            case '\n': o += "\\n"; break;
            case '\r': o += "\\r"; break;
            default:   o += (char) c; break;
        }
    }
    return o;
}

inline std::string extractJsonString (const std::string& src, const std::string& key)
{
    const std::string needle = "\"" + key + "\":\"";
    size_t pos = src.find (needle);
    if (pos == std::string::npos)
        return {};
    pos += needle.size();
    std::string out;
    while (pos < src.size())
    {
        char c = src[pos++];
        if (c == '\\' && pos < src.size())
        {
            out += src[pos++];
            continue;
        }
        if (c == '"')
            break;
        out += c;
    }
    return out;
}

inline int extractJsonInt (const std::string& src, const std::string& key, int fallback = 0)
{
    const std::string needle = "\"" + key + "\":";
    size_t pos = src.find (needle);
    if (pos == std::string::npos)
        return fallback;
    pos += needle.size();
    while (pos < src.size() && (src[pos] == ' ' || src[pos] == '"'))
        ++pos;
    try { return std::stoi (src.substr (pos)); }
    catch (...) { return fallback; }
}

inline float extractJsonFloat (const std::string& src, const std::string& key, float fallback = 0.0f)
{
    const std::string needle = "\"" + key + "\":";
    size_t pos = src.find (needle);
    if (pos == std::string::npos)
        return fallback;
    pos += needle.size();
    while (pos < src.size() && src[pos] == ' ')
        ++pos;
    try { return std::stof (src.substr (pos)); }
    catch (...) { return fallback; }
}

inline bool extractJsonBool (const std::string& src, const std::string& key, bool fallback = false)
{
    const std::string needle = "\"" + key + "\":";
    size_t pos = src.find (needle);
    if (pos == std::string::npos)
        return fallback;
    pos += needle.size();
    while (pos < src.size() && src[pos] == ' ')
        ++pos;
    if (src.compare (pos, 4, "true") == 0)
        return true;
    if (src.compare (pos, 5, "false") == 0)
        return false;
    return fallback;
}

} // namespace Local
} // namespace LiveMixStream
