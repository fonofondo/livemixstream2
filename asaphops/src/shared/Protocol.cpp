#include "Protocol.h"

// Header-only protocol helpers; this translation unit keeps the shared library non-empty.
namespace AsaphOps {
static int protocolVersion() { return kProtocolVersion; }
}
