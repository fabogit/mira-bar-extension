// hid_bench: measures the cost of reading Apple Silicon temperature sensors via IOHIDEventSystemClient.
//
// Standalone diagnostic, not part of the addon. Build and run on the Mac:
//   clang++ -std=c++17 -O2 -framework CoreFoundation -framework IOKit \
//     native/darwin/tools/hid_bench.cc -o /tmp/hid_bench && /tmp/hid_bench [rounds]
//
// Reports, per sensor, the min / median / max latency of IOHIDServiceClientCopyEvent, then the
// cost per category (tdie / NAND / battery / other) of one full pass, and the one-off setup costs
// (client creation, CopyServices, product-name lookup) that the addon now pays only once.

#include <CoreFoundation/CoreFoundation.h>

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

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

namespace {

using Clock = std::chrono::steady_clock;

double ElapsedUs(Clock::time_point start) {
  return std::chrono::duration<double, std::micro>(Clock::now() - start).count();
}

enum class Kind { Die, Nand, Battery, Other };

const char* KindName(Kind kind) {
  switch (kind) {
    case Kind::Die: return "tdie";
    case Kind::Nand: return "NAND";
    case Kind::Battery: return "battery";
    case Kind::Other: return "other";
  }
  return "?";
}

// Same classification as addon.cc.
Kind Classify(const char* name) {
  if (std::strstr(name, "tdie") != nullptr) return Kind::Die;
  if (std::strstr(name, "NAND") != nullptr || std::strstr(name, "nand") != nullptr) return Kind::Nand;
  if (std::strstr(name, "gas gauge") != nullptr || std::strstr(name, "battery") != nullptr) return Kind::Battery;
  return Kind::Other;
}

struct Sensor {
  IOHIDServiceClientRef service;
  std::string name;
  Kind kind;
  std::vector<double> samples_us;
  double last_celsius = -1.0;
  int failures = 0;
};

double Percentile(std::vector<double> values, double p) {
  if (values.empty()) return 0.0;
  std::sort(values.begin(), values.end());
  const size_t index = static_cast<size_t>(p * static_cast<double>(values.size() - 1) + 0.5);
  return values[std::min(index, values.size() - 1)];
}

}  // namespace

int main(int argc, char** argv) {
  const int rounds = argc > 1 ? std::max(1, std::atoi(argv[1])) : 20;

  auto t = Clock::now();
  IOHIDEventSystemClientRef client = IOHIDEventSystemClientCreate(kCFAllocatorDefault);
  const double create_us = ElapsedUs(t);
  if (client == nullptr) {
    std::fprintf(stderr, "IOHIDEventSystemClientCreate failed\n");
    return 1;
  }

  int page = 0xff00;  // kHIDPage_AppleVendor
  int usage = 5;      // kHIDUsage_AppleVendor_TemperatureSensor
  CFNumberRef page_num = CFNumberCreate(kCFAllocatorDefault, kCFNumberIntType, &page);
  CFNumberRef usage_num = CFNumberCreate(kCFAllocatorDefault, kCFNumberIntType, &usage);
  const void* keys[2] = {CFSTR("PrimaryUsagePage"), CFSTR("PrimaryUsage")};
  const void* values[2] = {page_num, usage_num};
  CFDictionaryRef match = CFDictionaryCreate(kCFAllocatorDefault, keys, values, 2, &kCFTypeDictionaryKeyCallBacks,
                                             &kCFTypeDictionaryValueCallBacks);
  IOHIDEventSystemClientSetMatching(client, match);

  t = Clock::now();
  CFArrayRef services = IOHIDEventSystemClientCopyServices(client);
  const double copy_services_us = ElapsedUs(t);
  if (services == nullptr) {
    std::fprintf(stderr, "IOHIDEventSystemClientCopyServices returned NULL\n");
    return 1;
  }

  std::vector<Sensor> sensors;
  t = Clock::now();
  const CFIndex count = CFArrayGetCount(services);
  for (CFIndex i = 0; i < count; ++i) {
    auto service = static_cast<IOHIDServiceClientRef>(const_cast<void*>(CFArrayGetValueAtIndex(services, i)));
    CFTypeRef product = IOHIDServiceClientCopyProperty(service, CFSTR("Product"));
    char name[128] = "(unnamed)";
    if (product != nullptr) {
      if (CFGetTypeID(product) == CFStringGetTypeID()) {
        CFStringGetCString(static_cast<CFStringRef>(product), name, sizeof(name), kCFStringEncodingUTF8);
      }
      CFRelease(product);
    }
    sensors.push_back({service, name, Classify(name), {}, -1.0, 0});
  }
  const double names_us = ElapsedUs(t);

  // Warm-up pass (first IPC to each service can be slower), then timed rounds.
  for (Sensor& s : sensors) {
    IOHIDEventRef event = IOHIDServiceClientCopyEvent(s.service, kIOHIDEventTypeTemperature, 0, 0);
    if (event != nullptr) CFRelease(event);
  }

  std::vector<double> pass_us;
  for (int r = 0; r < rounds; ++r) {
    const auto pass_start = Clock::now();
    for (Sensor& s : sensors) {
      const auto start = Clock::now();
      IOHIDEventRef event = IOHIDServiceClientCopyEvent(s.service, kIOHIDEventTypeTemperature, 0, 0);
      s.samples_us.push_back(ElapsedUs(start));
      if (event != nullptr) {
        s.last_celsius = IOHIDEventGetFloatValue(event, IOHIDEventFieldBase(kIOHIDEventTypeTemperature));
        CFRelease(event);
      } else {
        ++s.failures;
      }
    }
    pass_us.push_back(ElapsedUs(pass_start));
  }

  std::sort(sensors.begin(), sensors.end(),
            [](const Sensor& a, const Sensor& b) { return Percentile(a.samples_us, 0.5) > Percentile(b.samples_us, 0.5); });

  std::printf("hid_bench: %zu temperature services, %d rounds\n\n", sensors.size(), rounds);
  std::printf("%-8s %-28s %9s %9s %9s %8s %5s\n", "kind", "sensor", "min us", "median us", "max us", "last C", "fail");
  for (const Sensor& s : sensors) {
    std::printf("%-8s %-28.28s %9.1f %9.1f %9.1f %8.2f %5d\n", KindName(s.kind), s.name.c_str(),
                Percentile(s.samples_us, 0.0), Percentile(s.samples_us, 0.5), Percentile(s.samples_us, 1.0),
                s.last_celsius, s.failures);
  }

  std::printf("\nMedian cost of one full pass, by category (what the addon pays per tick):\n");
  double total = 0.0;
  for (Kind kind : {Kind::Die, Kind::Nand, Kind::Battery, Kind::Other}) {
    int n = 0;
    double sum = 0.0;
    for (const Sensor& s : sensors) {
      if (s.kind == kind) {
        ++n;
        sum += Percentile(s.samples_us, 0.5);
      }
    }
    if (n == 0) continue;
    total += sum;
    std::printf("  %-8s %3d sensors  %9.1f us  (%.1f us each)\n", KindName(kind), n, sum, sum / n);
  }
  std::printf("  %-8s %3zu sensors  %9.1f us  (sum of medians)\n", "all", sensors.size(), total);
  std::printf("  full pass measured: median %.1f us, max %.1f us\n", Percentile(pass_us, 0.5), Percentile(pass_us, 1.0));
  std::printf("  addon reads: tdie + first NAND + first battery (\"other\" sensors are skipped)\n");

  std::printf("\nOne-off setup (the addon now pays these once):\n");
  std::printf("  IOHIDEventSystemClientCreate  %9.1f us\n", create_us);
  std::printf("  CopyServices                  %9.1f us\n", copy_services_us);
  std::printf("  Product names (%zu services)   %9.1f us\n", sensors.size(), names_us);

  CFRelease(services);
  CFRelease(match);
  CFRelease(page_num);
  CFRelease(usage_num);
  CFRelease(client);
  return 0;
}
