// iohid.h: private IOHIDEventSystemClient declarations and temperature sensor classification, shared by
// the addon (src/addon.cc) and the standalone benchmark (tools/hid_bench.cc).
//
// The IOHIDEventSystemClient API is not in the public macOS SDK headers; the symbols are exported by
// IOKit.framework, so linking with -framework IOKit is enough.

#ifndef MIRABAR_DARWIN_IOHID_H_
#define MIRABAR_DARWIN_IOHID_H_

#include <CoreFoundation/CoreFoundation.h>

#include <cstdint>
#include <cstring>

extern "C" {
typedef struct __IOHIDEvent *IOHIDEventRef;
typedef struct __IOHIDServiceClient *IOHIDServiceClientRef;
typedef struct __IOHIDEventSystemClient *IOHIDEventSystemClientRef;

#define IOHIDEventFieldBase(type) ((type) << 16)
#define kIOHIDEventTypeTemperature 15

IOHIDEventSystemClientRef IOHIDEventSystemClientCreate(CFAllocatorRef allocator);
int IOHIDEventSystemClientSetMatching(IOHIDEventSystemClientRef client, CFDictionaryRef match);
CFArrayRef IOHIDEventSystemClientCopyServices(IOHIDEventSystemClientRef client);
CFTypeRef IOHIDServiceClientCopyProperty(IOHIDServiceClientRef service, CFStringRef key);
IOHIDEventRef IOHIDServiceClientCopyEvent(IOHIDServiceClientRef service, int64_t type, int32_t options, int64_t matching);
double IOHIDEventGetFloatValue(IOHIDEventRef event, int32_t field);
}

namespace mirabar {

/** Temperature sensor categories, by HID product name. The addon reads Die, Nand and Battery only. */
enum class SensorKind { Die, Nand, Battery, Other };

/**
 * Classifies a temperature service by its "Product" name: SoC die ("tdie"), NAND flash, battery
 * ("gas gauge" / "battery"). Everything else (tdev, tcal, als) is Other: not a SoC die reading, and
 * ~1.5 ms each.
 */
inline SensorKind ClassifySensor(const char* product) {
  if (std::strstr(product, "tdie") != nullptr) return SensorKind::Die;
  if (std::strstr(product, "NAND") != nullptr || std::strstr(product, "nand") != nullptr) return SensorKind::Nand;
  if (std::strstr(product, "gas gauge") != nullptr || std::strstr(product, "battery") != nullptr) {
    return SensorKind::Battery;
  }
  return SensorKind::Other;
}

}  // namespace mirabar

#endif  // MIRABAR_DARWIN_IOHID_H_
