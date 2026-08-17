#include "MachineIdentity.h"

namespace AsaphOps {
// MachineIdentity is implemented in the header; this unit is kept for the shared library.
static void ensureMachineIdentityLoaded() { MachineIdentity::get().loadOrCreate(); }
}
