// darwin_telemetry.node: Mach / sysctl / IOKit / IOHID telemetry for Apple Silicon.
//
// Resource ownership rules (see docs/audit-darwin-memory-2026-09.md):
//   - Every CoreFoundation object obtained through a Create/Copy function is held by CFRef<T>.
//   - Every io_object_t is held by IOObject, every Mach send right by MachSendRight,
//     every vm_allocate'd kernel buffer by VmRegion.
//   - Long-lived handles (host port, HID client, thermal sensors, battery service) live in a
//     per-env AddonState, freed by the napi_set_instance_data finalizer.
//   - All entry points run on the JS thread. The only other thread is ThermalSampler's worker,
//     which owns the HID client exclusively and shares one ThermalReading under a mutex.

#include <node_api.h>
#include <mach/mach.h>
#include <mach/mach_host.h>
#include <mach/processor_info.h>
#include <sys/sysctl.h>
#include <CoreFoundation/CoreFoundation.h>
#include <IOKit/ps/IOPowerSources.h>
#include <IOKit/ps/IOPSKeys.h>
#include <IOKit/IOKitLib.h>

#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <iterator>
#include <memory>
#include <mutex>
#include <string>
#include <system_error>
#include <thread>
#include <utility>
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

// ---------------------------------------------------------------------------
// RAII wrappers (C++ Core Guidelines R.1, C.21: move-only owners)
// ---------------------------------------------------------------------------

/** Owns one +1 reference to a CoreFoundation object (Create/Copy rule). */
template <typename T>
class CFRef {
 public:
  CFRef() noexcept = default;
  explicit CFRef(T ref) noexcept : ref_(ref) {}
  ~CFRef() { reset(); }
  CFRef(const CFRef&) = delete;
  CFRef& operator=(const CFRef&) = delete;
  CFRef(CFRef&& other) noexcept : ref_(std::exchange(other.ref_, nullptr)) {}
  CFRef& operator=(CFRef&& other) noexcept {
    if (this != &other) {
      reset();
      ref_ = std::exchange(other.ref_, nullptr);
    }
    return *this;
  }
  void reset(T ref = nullptr) noexcept {
    if (ref_) {
      CFRelease(ref_);
    }
    ref_ = ref;
  }
  T get() const noexcept { return ref_; }
  explicit operator bool() const noexcept { return ref_ != nullptr; }

 private:
  T ref_ = nullptr;
};

/** Owns an io_object_t (service, registry entry, iterator). */
class IOObject {
 public:
  explicit IOObject(io_object_t obj = IO_OBJECT_NULL) noexcept : obj_(obj) {}
  ~IOObject() { reset(); }
  IOObject(const IOObject&) = delete;
  IOObject& operator=(const IOObject&) = delete;
  void reset(io_object_t obj = IO_OBJECT_NULL) noexcept {
    if (obj_ != IO_OBJECT_NULL) {
      IOObjectRelease(obj_);
    }
    obj_ = obj;
  }
  io_object_t get() const noexcept { return obj_; }
  explicit operator bool() const noexcept { return obj_ != IO_OBJECT_NULL; }

 private:
  io_object_t obj_;
};

/** Owns one user reference on a Mach send right (e.g. from mach_host_self()). */
class MachSendRight {
 public:
  explicit MachSendRight(mach_port_t port) noexcept : port_(port) {}
  ~MachSendRight() {
    if (MACH_PORT_VALID(port_)) {
      mach_port_deallocate(mach_task_self(), port_);
    }
  }
  MachSendRight(const MachSendRight&) = delete;
  MachSendRight& operator=(const MachSendRight&) = delete;
  mach_port_t get() const noexcept { return port_; }

 private:
  mach_port_t port_;
};

/** Owns a kernel-allocated out-of-line buffer (e.g. from host_processor_info). */
class VmRegion {
 public:
  VmRegion(vm_address_t addr, vm_size_t size) noexcept : addr_(addr), size_(size) {}
  ~VmRegion() {
    if (addr_ != 0) {
      vm_deallocate(mach_task_self(), addr_, size_);
    }
  }
  VmRegion(const VmRegion&) = delete;
  VmRegion& operator=(const VmRegion&) = delete;

 private:
  vm_address_t addr_;
  vm_size_t size_;
};

// ---------------------------------------------------------------------------
// Type-checked CoreFoundation / IOKit readers
// ---------------------------------------------------------------------------

bool GetInt(CFTypeRef value, int& out) {
  return value != nullptr && CFGetTypeID(value) == CFNumberGetTypeID() &&
         CFNumberGetValue(static_cast<CFNumberRef>(value), kCFNumberIntType, &out);
}

bool GetBool(CFTypeRef value, bool& out) {
  if (value == nullptr || CFGetTypeID(value) != CFBooleanGetTypeID()) {
    return false;
  }
  out = CFBooleanGetValue(static_cast<CFBooleanRef>(value));
  return true;
}

bool GetUtf8(CFTypeRef value, char* buf, CFIndex len) {
  return value != nullptr && CFGetTypeID(value) == CFStringGetTypeID() &&
         CFStringGetCString(static_cast<CFStringRef>(value), buf, len, kCFStringEncodingUTF8);
}

bool IsCFString(CFTypeRef value) {
  return value != nullptr && CFGetTypeID(value) == CFStringGetTypeID();
}

/** Reads an int from `dict[key]`, falling back to `dict[nested][key]` (e.g. AppleSmartBattery "BatteryData"). */
bool GetDictInt(CFDictionaryRef dict, CFStringRef key, int& out, CFStringRef nested = nullptr) {
  if (GetInt(CFDictionaryGetValue(dict, key), out)) return true;
  if (nested == nullptr) return false;
  CFTypeRef inner = CFDictionaryGetValue(dict, nested);
  return inner != nullptr && CFGetTypeID(inner) == CFDictionaryGetTypeID() &&
         GetInt(CFDictionaryGetValue(static_cast<CFDictionaryRef>(inner), key), out);
}

template <typename T>
bool SysctlByName(const char* name, T& out) {
  size_t len = sizeof(out);
  return sysctlbyname(name, &out, &len, nullptr, 0) == 0 && len == sizeof(out);
}

// ---------------------------------------------------------------------------
// N-API helpers
// ---------------------------------------------------------------------------

/** Throws a JS Error for a failed N-API call, unless an exception is already pending. */
void ThrowNapiError(napi_env env, const char* what) {
  const napi_extended_error_info* info = nullptr;
  napi_get_last_error_info(env, &info);  // must run first: every N-API call resets it
  std::string message = std::string("darwin_telemetry: ") + what;
  if (info != nullptr && info->error_message != nullptr) {
    message += ": ";
    message += info->error_message;
  }
  bool pending = false;
  napi_is_exception_pending(env, &pending);
  if (!pending) {
    napi_throw_error(env, nullptr, message.c_str());
  }
}

#define NAPI_CALL(env, call)          \
  do {                                \
    if ((call) != napi_ok) {          \
      ThrowNapiError((env), #call);   \
      return nullptr;                 \
    }                                 \
  } while (0)

napi_value Null(napi_env env) {
  napi_value value = nullptr;
  napi_get_null(env, &value);
  return value;
}

/** Builds a plain JS object; the first failing call is reported by Finish(). */
class JsObject {
 public:
  explicit JsObject(napi_env env) : env_(env) { Check(napi_create_object(env_, &obj_), "napi_create_object"); }

  JsObject& Int(const char* key, int64_t value) {
    napi_value v = nullptr;
    if (ok_ && Check(napi_create_int64(env_, value, &v), key)) Set(key, v);
    return *this;
  }
  JsObject& Double(const char* key, double value) {
    napi_value v = nullptr;
    if (ok_ && Check(napi_create_double(env_, value, &v), key)) Set(key, v);
    return *this;
  }
  JsObject& Bool(const char* key, bool value) {
    napi_value v = nullptr;
    if (ok_ && Check(napi_get_boolean(env_, value, &v), key)) Set(key, v);
    return *this;
  }
  JsObject& Str(const char* key, const char* value) {
    napi_value v = nullptr;
    if (ok_ && Check(napi_create_string_utf8(env_, value, NAPI_AUTO_LENGTH, &v), key)) Set(key, v);
    return *this;
  }

  /** Returns the object, or throws and returns nullptr if any call failed. */
  napi_value Finish() {
    if (!ok_) {
      ThrowNapiError(env_, failed_);
      return nullptr;
    }
    return obj_;
  }

 private:
  bool Check(napi_status status, const char* what) {
    if (status != napi_ok && ok_) {
      ok_ = false;
      failed_ = what;
    }
    return status == napi_ok;
  }
  void Set(const char* key, napi_value value) { Check(napi_set_named_property(env_, obj_, key, value), key); }

  napi_env env_;
  napi_value obj_ = nullptr;
  bool ok_ = true;
  const char* failed_ = "";
};

// ---------------------------------------------------------------------------
// Per-env addon state
// ---------------------------------------------------------------------------

enum class SensorKind { Die, Nand, Battery };

struct Sensor {
  IOHIDServiceClientRef service;  // non-owning: kept alive by AddonState::hid_services
  SensorKind kind;
  std::string name;
};

constexpr auto kThermalRescanInterval = std::chrono::seconds(60);
constexpr auto kBatteryRegistryRefresh = std::chrono::seconds(30);
constexpr auto kBatteryLookupRetry = std::chrono::seconds(60);
constexpr double kMinValidCelsius = 0.0;
constexpr double kMaxValidCelsius = 130.0;

/** One full thermal pass: SoC die average / peak, NAND and battery temperatures. */
struct ThermalReading {
  bool valid = false;
  double avg_celsius = 0.0;
  double peak_celsius = 0.0;
  std::string peak_sensor;
  int die_count = 0;
  double nand_celsius = -1.0;
  double battery_celsius = -1.0;
  Clock::time_point taken{};
};

/**
 * Owns the IOHID client and the classified temperature sensors. Used from a single thread
 * (ThermalSampler's worker), so it needs no locking.
 *
 * Each IOHIDServiceClientCopyEvent is an IPC round trip to the HID event server: measured on an
 * M4 at ~0.6 ms per tdie sensor, ~16 ms for the 26 sensors read per pass (hid_bench.cc).
 */
class ThermalHid {
 public:
  ThermalHid() = default;
  ThermalHid(const ThermalHid&) = delete;
  ThermalHid& operator=(const ThermalHid&) = delete;

  ThermalReading Sample() {
    ThermalReading reading;
    reading.taken = Clock::now();
    if (!EnsureSensors()) return reading;

    double sum_die = 0.0;
    const Sensor* peak = nullptr;
    for (const Sensor& sensor : sensors_) {
      switch (sensor.kind) {
        case SensorKind::Die: {
          const double temp = ReadCelsius(sensor.service);
          if (temp > 0.0) {
            sum_die += temp;
            ++reading.die_count;
            if (temp > reading.peak_celsius) {
              reading.peak_celsius = temp;
              peak = &sensor;
            }
          }
          break;
        }
        case SensorKind::Nand:
          if (reading.nand_celsius < 0.0) reading.nand_celsius = ReadCelsius(sensor.service);
          break;
        case SensorKind::Battery:
          if (reading.battery_celsius < 0.0) reading.battery_celsius = ReadCelsius(sensor.service);
          break;
      }
    }

    if (reading.die_count == 0) {
      // Sensors went away (e.g. HID event server restarted): rebuild everything on the next pass.
      Reset();
      next_scan_ = Clock::time_point{};
      return reading;
    }
    reading.valid = true;
    reading.avg_celsius = sum_die / reading.die_count;
    reading.peak_sensor = peak != nullptr ? peak->name : "tdie";
    return reading;
  }

 private:
  /** Drops cached sensors and the HID client (it does not recover if the HID event server restarts). */
  void Reset() {
    sensors_.clear();    // raw refs first
    services_.reset();   // then their owner
    client_.reset();     // then the client
  }

  /**
   * Creates the HID client and classifies the temperature services by product name. Rescans at
   * most every kThermalRescanInterval, so Macs without sensors do not pay for a full scan per pass.
   */
  bool EnsureSensors() {
    if (!sensors_.empty()) return true;

    const Clock::time_point now = Clock::now();
    if (now < next_scan_) return false;
    next_scan_ = now + kThermalRescanInterval;

    if (!client_) {
      CFRef<IOHIDEventSystemClientRef> client(IOHIDEventSystemClientCreate(kCFAllocatorDefault));
      if (!client) return false;

      int page = 0xff00;  // kHIDPage_AppleVendor
      int usage = 5;      // kHIDUsage_AppleVendor_TemperatureSensor
      CFRef<CFNumberRef> page_num(CFNumberCreate(kCFAllocatorDefault, kCFNumberIntType, &page));
      CFRef<CFNumberRef> usage_num(CFNumberCreate(kCFAllocatorDefault, kCFNumberIntType, &usage));
      if (!page_num || !usage_num) return false;

      const void* keys[2] = {CFSTR("PrimaryUsagePage"), CFSTR("PrimaryUsage")};
      const void* values[2] = {page_num.get(), usage_num.get()};
      CFRef<CFDictionaryRef> match(CFDictionaryCreate(kCFAllocatorDefault, keys, values, 2,
                                                      &kCFTypeDictionaryKeyCallBacks,
                                                      &kCFTypeDictionaryValueCallBacks));
      if (!match) return false;
      IOHIDEventSystemClientSetMatching(client.get(), match.get());
      client_ = std::move(client);
    }

    services_.reset(IOHIDEventSystemClientCopyServices(client_.get()));
    if (!services_) return false;

    bool has_die = false;
    const CFIndex count = CFArrayGetCount(services_.get());
    for (CFIndex i = 0; i < count; ++i) {
      auto service = static_cast<IOHIDServiceClientRef>(const_cast<void*>(CFArrayGetValueAtIndex(services_.get(), i)));
      if (service == nullptr) continue;

      CFRef<CFTypeRef> product(IOHIDServiceClientCopyProperty(service, CFSTR("Product")));
      char name[128] = {0};
      if (!GetUtf8(product.get(), name, sizeof(name))) continue;

      // tdev/tcal/als sensors are skipped: they are not SoC die readings (and cost ~1.5 ms each).
      if (std::strstr(name, "tdie") != nullptr) {
        sensors_.push_back({service, SensorKind::Die, name});
        has_die = true;
      } else if (std::strstr(name, "NAND") != nullptr || std::strstr(name, "nand") != nullptr) {
        sensors_.push_back({service, SensorKind::Nand, name});
      } else if (std::strstr(name, "gas gauge") != nullptr || std::strstr(name, "battery") != nullptr) {
        sensors_.push_back({service, SensorKind::Battery, name});
      }
    }

    if (!has_die) {
      Reset();
      return false;
    }
    return true;
  }

  /** Returns the sensor temperature in °C, or -1 when unreadable or out of range. */
  static double ReadCelsius(IOHIDServiceClientRef service) {
    CFRef<IOHIDEventRef> event(IOHIDServiceClientCopyEvent(service, kIOHIDEventTypeTemperature, 0, 0));
    if (!event) return -1.0;
    const double temp = IOHIDEventGetFloatValue(event.get(), IOHIDEventFieldBase(kIOHIDEventTypeTemperature));
    return (temp > kMinValidCelsius && temp < kMaxValidCelsius) ? temp : -1.0;
  }

  // Declaration order matters: sensors_ (raw refs) are destroyed before services_, then client_.
  CFRef<IOHIDEventSystemClientRef> client_;
  CFRef<CFArrayRef> services_;
  std::vector<Sensor> sensors_;
  Clock::time_point next_scan_{};
};

/**
 * Runs ThermalHid passes on a dedicated background thread so the JS thread never blocks on HID IPC.
 *
 * Get() returns the latest reading immediately and, if it is older than `max_age`, asks the worker
 * for a new pass (requests coalesce: at most one pass runs at a time). Only the very first call
 * waits, up to kFirstReadingWait, so the first tick can already show a temperature. The worker is
 * started lazily and joined in the destructor (N-API instance-data finalizer).
 */
class ThermalSampler {
 public:
  ThermalSampler() = default;
  ThermalSampler(const ThermalSampler&) = delete;
  ThermalSampler& operator=(const ThermalSampler&) = delete;

  ~ThermalSampler() {
    {
      std::lock_guard<std::mutex> lock(mutex_);
      stop_ = true;
    }
    wake_.notify_one();
    if (worker_.joinable()) worker_.join();  // waits for at most one in-flight pass (~20 ms)
  }

  /** JS thread only. */
  ThermalReading Get(Clock::duration max_age) {
    std::unique_lock<std::mutex> lock(mutex_);
    if (!started_) {
      started_ = true;
      try {
        worker_ = std::thread([this] { Run(); });
      } catch (const std::system_error&) {
        return ThermalReading{};  // no thread available: report "no temperature" rather than crash
      }
    }
    if (!worker_.joinable()) return ThermalReading{};

    const bool stale = !has_reading_ || Clock::now() - reading_.taken >= max_age;
    if (stale && !busy_ && !requested_) {
      requested_ = true;
      wake_.notify_one();
    }
    if (!has_reading_) {
      done_.wait_for(lock, kFirstReadingWait, [this] { return has_reading_; });
    }
    return reading_;
  }

 private:
  static constexpr auto kFirstReadingWait = std::chrono::milliseconds(250);

  void Run() {
    ThermalHid hid;  // lives and dies on this thread
    std::unique_lock<std::mutex> lock(mutex_);
    for (;;) {
      wake_.wait(lock, [this] { return stop_ || requested_; });
      if (stop_) return;
      requested_ = false;
      busy_ = true;
      lock.unlock();
      ThermalReading reading = hid.Sample();  // HID IPC runs without holding the lock
      lock.lock();
      busy_ = false;
      reading_ = std::move(reading);
      has_reading_ = true;
      done_.notify_all();
    }
  }

  std::mutex mutex_;
  std::condition_variable wake_;
  std::condition_variable done_;
  bool started_ = false;
  bool stop_ = false;
  bool requested_ = false;
  bool busy_ = false;
  bool has_reading_ = false;
  ThermalReading reading_;
  std::thread worker_;
};

struct AddonState {
  // Acquired once: fixes the mach_host_self() send-right leak (3 urefs per tick before).
  MachSendRight host{mach_host_self()};

  // Constant for the lifetime of the process: read once.
  vm_size_t page_size = 0;
  uint64_t total_ram = 0;

  // Thermal: sampled on a background thread (see ThermalSampler). Destroyed first among the
  // members that matter, joining the worker before anything else is torn down.
  ThermalSampler thermal;

  // Battery: service looked up once (retried if missing). The mAh / cycle details change slowly
  // and are refreshed from one registry snapshot every kBatteryRegistryRefresh.
  IOObject smart_battery;
  Clock::time_point next_battery_lookup{};
  Clock::time_point battery_registry_expiry{};
  int design_capacity = 0;
  int raw_max_capacity = 0;
  int raw_current_capacity = 0;
  int cycle_count = -1;
};

void FinalizeState(napi_env /*env*/, void* data, void* /*hint*/) {
  delete static_cast<AddonState*>(data);
}

AddonState* GetState(napi_env env, napi_callback_info info, size_t* argc = nullptr, napi_value* argv = nullptr) {
  void* data = nullptr;
  if (napi_get_cb_info(env, info, argc, argv, nullptr, &data) != napi_ok || data == nullptr) {
    ThrowNapiError(env, "napi_get_cb_info");
    return nullptr;
  }
  return static_cast<AddonState*>(data);
}

// ---------------------------------------------------------------------------
// CPU
// ---------------------------------------------------------------------------

static_assert(CPU_STATE_MAX == 4, "tick layout assumes 4 CPU states");
static_assert(sizeof(natural_t) == sizeof(uint32_t), "cpu_ticks must be 32-bit");

/**
 * getCpuTicks(out: Uint32Array): number
 *
 * Copies the cumulative Mach tick counters of every logical core into `out`, laid out as
 * out[core * 4 + state] with state = user(0), system(1), idle(2), nice(3), exactly as
 * processor_cpu_load_info. Returns the core count. If `out` is too small nothing is written
 * and the required core count is returned, so the caller can grow its buffer.
 * Returns 0 if the kernel query fails. Allocates nothing on the JS heap.
 */
napi_value GetCpuTicks(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1] = {nullptr};
  AddonState* state = GetState(env, info, &argc, argv);
  if (state == nullptr) return nullptr;

  bool is_typedarray = false;
  if (argc < 1 || napi_is_typedarray(env, argv[0], &is_typedarray) != napi_ok || !is_typedarray) {
    napi_throw_type_error(env, nullptr, "getCpuTicks(out): out must be a Uint32Array");
    return nullptr;
  }
  napi_typedarray_type type;
  size_t length = 0;
  void* data = nullptr;
  NAPI_CALL(env, napi_get_typedarray_info(env, argv[0], &type, &length, &data, nullptr, nullptr));
  if (type != napi_uint32_array) {
    napi_throw_type_error(env, nullptr, "getCpuTicks(out): out must be a Uint32Array");
    return nullptr;
  }

  natural_t processor_count = 0;
  processor_info_array_t processor_info = nullptr;
  mach_msg_type_number_t processor_info_count = 0;
  const kern_return_t kr = host_processor_info(state->host.get(), PROCESSOR_CPU_LOAD_INFO, &processor_count,
                                               &processor_info, &processor_info_count);

  napi_value result = nullptr;
  if (kr != KERN_SUCCESS || processor_info == nullptr) {
    NAPI_CALL(env, napi_create_uint32(env, 0, &result));
    return result;
  }
  VmRegion guard(reinterpret_cast<vm_address_t>(processor_info),
                 static_cast<vm_size_t>(processor_info_count) * sizeof(integer_t));

  const size_t needed = static_cast<size_t>(processor_count) * CPU_STATE_MAX;
  if (needed > processor_info_count) {
    // Malformed kernel reply: report failure rather than a stale buffer.
    NAPI_CALL(env, napi_create_uint32(env, 0, &result));
    return result;
  }
  if (length >= needed) {
    std::memcpy(data, processor_info, needed * sizeof(uint32_t));
  }
  NAPI_CALL(env, napi_create_uint32(env, processor_count, &result));
  return result;
}

/** Returns CPU model and Performance / Efficiency core counts. */
napi_value GetCpuTopology(napi_env env, napi_callback_info info) {
  if (GetState(env, info) == nullptr) return nullptr;

  char brand[128] = "Apple Silicon";
  size_t brand_len = sizeof(brand);
  if (sysctlbyname("machdep.cpu.brand_string", brand, &brand_len, nullptr, 0) != 0) {
    std::snprintf(brand, sizeof(brand), "Apple Silicon");
  }
  brand[sizeof(brand) - 1] = '\0';

  int ncpu = 0;
  int p_cores = 0;
  int e_cores = 0;
  SysctlByName("hw.ncpu", ncpu);
  SysctlByName("hw.perflevel0.logicalcpu", p_cores);
  SysctlByName("hw.perflevel1.logicalcpu", e_cores);

  return JsObject(env)
      .Str("model", brand)
      .Int("totalCores", ncpu)
      .Int("pCores", p_cores)
      .Int("eCores", e_cores)
      .Finish();
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

/**
 * Returns RAM page breakdown, swap usage and kernel memory pressure.
 *
 * pressurePercent = 100 - kern.memorystatus_level (the "memory free %" of `memory_pressure`),
 * pressureLevel   = kern.memorystatus_vm_pressure_level (1 normal, 2 warning, 4 critical).
 * Both are -1 / 0 when the sysctl is unavailable. vm.memory_pressure is not used: it is an
 * internal counter, not a percentage.
 */
napi_value GetMemoryStats(napi_env env, napi_callback_info info) {
  AddonState* state = GetState(env, info);
  if (state == nullptr) return nullptr;

  vm_statistics64_data_t vm_stat;
  mach_msg_type_number_t count = HOST_VM_INFO64_COUNT;
  const kern_return_t kr =
      host_statistics64(state->host.get(), HOST_VM_INFO64, reinterpret_cast<host_info64_t>(&vm_stat), &count);
  if (kr != KERN_SUCCESS || state->page_size == 0) {
    return Null(env);
  }

  const uint64_t page = state->page_size;
  const uint64_t active = static_cast<uint64_t>(vm_stat.active_count) * page;
  const uint64_t wired = static_cast<uint64_t>(vm_stat.wire_count) * page;
  const uint64_t compressed = static_cast<uint64_t>(vm_stat.compressor_page_count) * page;
  const uint64_t inactive = static_cast<uint64_t>(vm_stat.inactive_count) * page;
  const uint64_t free_bytes = static_cast<uint64_t>(vm_stat.free_count) * page;

  struct xsw_usage swap = {};
  uint64_t swap_total = 0;
  uint64_t swap_used = 0;
  uint64_t swap_free = 0;
  if (SysctlByName("vm.swapusage", swap)) {
    swap_total = swap.xsu_total;
    swap_used = swap.xsu_used;
    swap_free = swap.xsu_avail;
  }

  int free_level = -1;
  int pressure_percent = -1;
  if (SysctlByName("kern.memorystatus_level", free_level) && free_level >= 0 && free_level <= 100) {
    pressure_percent = 100 - free_level;
  }
  int pressure_level = 0;
  if (!SysctlByName("kern.memorystatus_vm_pressure_level", pressure_level)) {
    pressure_level = 0;
  }

  return JsObject(env)
      .Int("totalBytes", static_cast<int64_t>(state->total_ram))
      .Int("usedBytes", static_cast<int64_t>(active + wired + compressed))
      .Int("availableBytes", static_cast<int64_t>(inactive + free_bytes))
      .Int("activeBytes", static_cast<int64_t>(active))
      .Int("wiredBytes", static_cast<int64_t>(wired))
      .Int("compressedBytes", static_cast<int64_t>(compressed))
      .Int("inactiveBytes", static_cast<int64_t>(inactive))
      .Int("freeBytes", static_cast<int64_t>(free_bytes))
      .Int("swapTotalBytes", static_cast<int64_t>(swap_total))
      .Int("swapUsedBytes", static_cast<int64_t>(swap_used))
      .Int("swapFreeBytes", static_cast<int64_t>(swap_free))
      .Int("pressurePercent", pressure_percent)
      .Int("pressureLevel", pressure_level)
      .Finish();
}

// ---------------------------------------------------------------------------
// Battery
// ---------------------------------------------------------------------------

napi_value BatteryUnavailable(napi_env env) {
  return JsObject(env).Bool("isAvailable", false).Finish();
}

/** Returns battery state (IOPowerSources) plus mAh capacity, cycles and health (AppleSmartBattery). */
napi_value GetBatteryStats(napi_env env, napi_callback_info info) {
  AddonState* state = GetState(env, info);
  if (state == nullptr) return nullptr;

  CFRef<CFTypeRef> blob(IOPSCopyPowerSourcesInfo());
  if (!blob) return BatteryUnavailable(env);
  CFRef<CFArrayRef> sources(IOPSCopyPowerSourcesList(blob.get()));
  if (!sources || CFArrayGetCount(sources.get()) == 0) return BatteryUnavailable(env);
  // Prefer the internal battery (a UPS can be listed too); fall back to the first source.
  // Get rule: descriptions are owned by blob, which stays alive until the end of this function.
  CFDictionaryRef desc = nullptr;
  const CFIndex source_count = CFArrayGetCount(sources.get());
  for (CFIndex i = 0; i < source_count; ++i) {
    CFDictionaryRef candidate = IOPSGetPowerSourceDescription(blob.get(), CFArrayGetValueAtIndex(sources.get(), i));
    if (candidate == nullptr) continue;
    if (desc == nullptr) desc = candidate;
    CFTypeRef type = CFDictionaryGetValue(candidate, CFSTR(kIOPSTypeKey));
    if (IsCFString(type) &&
        CFStringCompare(static_cast<CFStringRef>(type), CFSTR(kIOPSInternalBatteryType), 0) == kCFCompareEqualTo) {
      desc = candidate;
      break;
    }
  }
  if (desc == nullptr) return BatteryUnavailable(env);

  int capacity = 0;
  GetInt(CFDictionaryGetValue(desc, CFSTR(kIOPSCurrentCapacityKey)), capacity);
  bool is_charging = false;
  GetBool(CFDictionaryGetValue(desc, CFSTR(kIOPSIsChargingKey)), is_charging);

  int time_remaining = -1;
  const CFStringRef time_key = is_charging ? CFSTR(kIOPSTimeToFullChargeKey) : CFSTR(kIOPSTimeToEmptyKey);
  if (!GetInt(CFDictionaryGetValue(desc, time_key), time_remaining)) {
    time_remaining = -1;
  }

  const char* status = "Discharging";
  if (is_charging) {
    status = "Charging";
  } else {
    CFTypeRef state_value = CFDictionaryGetValue(desc, CFSTR(kIOPSPowerSourceStateKey));
    if (IsCFString(state_value) &&
        CFStringCompare(static_cast<CFStringRef>(state_value), CFSTR(kIOPSACPowerValue), 0) == kCFCompareEqualTo) {
      status = capacity >= 100 ? "Full" : "AC Connected";
    }
  }

  // AppleSmartBattery details. Some keys (DesignCapacity, AppleRaw*) are only published in the
  // serialized property table, not through IORegistryEntryCreateCFProperty, so take one full
  // snapshot every kBatteryRegistryRefresh instead of per key (the old code copied it every tick).
  const Clock::time_point now = Clock::now();
  if (!state->smart_battery && now >= state->next_battery_lookup) {
    state->next_battery_lookup = now + kBatteryLookupRetry;
    // MACH_PORT_NULL == kIOMainPortDefault == kIOMasterPortDefault, and works on macOS 11.
    state->smart_battery.reset(IOServiceGetMatchingService(MACH_PORT_NULL, IOServiceMatching("AppleSmartBattery")));
    state->battery_registry_expiry = Clock::time_point{};
  }

  if (state->smart_battery && now >= state->battery_registry_expiry) {
    state->battery_registry_expiry = now + kBatteryRegistryRefresh;
    CFMutableDictionaryRef raw_props = nullptr;
    const kern_return_t kr =
        IORegistryEntryCreateCFProperties(state->smart_battery.get(), &raw_props, kCFAllocatorDefault, 0);
    CFRef<CFMutableDictionaryRef> props(kr == KERN_SUCCESS ? raw_props : nullptr);
    if (!props) {
      if (raw_props != nullptr) CFRelease(raw_props);
      // Entry terminated or re-registered: drop it and look it up again later.
      state->smart_battery.reset();
      state->design_capacity = state->raw_max_capacity = state->raw_current_capacity = 0;
      state->cycle_count = -1;
    } else {
      const CFDictionaryRef dict = props.get();
      const CFStringRef nested = CFSTR("BatteryData");
      int value = 0;
      state->design_capacity = GetDictInt(dict, CFSTR("DesignCapacity"), value, nested) ? value : 0;
      state->cycle_count = GetDictInt(dict, CFSTR("CycleCount"), value, nested) ? value : -1;
      state->raw_max_capacity = (GetDictInt(dict, CFSTR("AppleRawMaxCapacity"), value) ||
                                 GetDictInt(dict, CFSTR("NominalChargeCapacity"), value))
                                    ? value
                                    : 0;
      state->raw_current_capacity = GetDictInt(dict, CFSTR("AppleRawCurrentCapacity"), value) ? value : 0;
    }
  }
  const int raw_max_capacity = state->raw_max_capacity;
  const int raw_current_capacity = state->raw_current_capacity;

  double health_percent = -1.0;
  if (state->design_capacity > 0 && raw_max_capacity > 0) {
    health_percent = static_cast<double>(raw_max_capacity) / state->design_capacity * 100.0;
    if (health_percent > 100.0) health_percent = 100.0;
  }

  JsObject obj(env);
  obj.Bool("isAvailable", true)
      .Int("percent", capacity)
      .Str("status", status)
      .Int("timeRemainingMinutes", time_remaining)
      .Bool("isCharging", is_charging);
  if (state->design_capacity > 0) obj.Int("designCapacity", state->design_capacity);
  if (raw_max_capacity > 0) obj.Int("maxCapacity", raw_max_capacity);
  if (raw_current_capacity > 0) obj.Int("currentCapacity", raw_current_capacity);
  if (state->cycle_count >= 0) obj.Int("cycleCount", state->cycle_count);
  if (health_percent >= 0.0) obj.Double("healthPercent", health_percent);
  obj.Str("capacityUnit", "mAh");
  return obj.Finish();
}

// ---------------------------------------------------------------------------
// Thermal
// ---------------------------------------------------------------------------

constexpr double kDefaultThermalMaxAgeMs = 5000.0;

/**
 * getDieTemperature(maxAgeMs = 5000): returns the latest SoC die average / peak, NAND and battery
 * temperatures, or null if unavailable. Never blocks on HID IPC after the first call: a new pass
 * runs in the background when the latest reading is older than `maxAgeMs`, so values can be up to
 * maxAgeMs + one pass (~20 ms) old.
 */
napi_value GetDieTemperature(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1] = {nullptr};
  AddonState* state = GetState(env, info, &argc, argv);
  if (state == nullptr) return nullptr;

  double max_age_ms = kDefaultThermalMaxAgeMs;
  if (argc >= 1) {
    napi_valuetype type = napi_undefined;
    NAPI_CALL(env, napi_typeof(env, argv[0], &type));
    if (type == napi_number) {
      NAPI_CALL(env, napi_get_value_double(env, argv[0], &max_age_ms));
    } else if (type != napi_undefined) {
      napi_throw_type_error(env, nullptr, "getDieTemperature(maxAgeMs): maxAgeMs must be a number");
      return nullptr;
    }
  }
  if (!(max_age_ms >= 0.0)) max_age_ms = 0.0;  // also catches NaN
  if (max_age_ms > 3600e3) max_age_ms = 3600e3;

  const ThermalReading reading = state->thermal.Get(
      std::chrono::duration_cast<Clock::duration>(std::chrono::duration<double, std::milli>(max_age_ms)));
  if (!reading.valid) return Null(env);

  char label[64];
  std::snprintf(label, sizeof(label), "%d sensors (max %.1f C)", reading.die_count, reading.peak_celsius);

  JsObject obj(env);
  obj.Double("tempCelsius", reading.avg_celsius)
      .Double("peakCelsius", reading.peak_celsius)
      .Str("peakSensor", reading.peak_sensor.c_str())
      .Int("dieCount", reading.die_count)
      .Str("sensorName", "Apple Silicon Die")
      .Str("sensorLabel", label);
  if (reading.nand_celsius > 0.0) obj.Double("nandCelsius", reading.nand_celsius);
  if (reading.battery_celsius > 0.0) obj.Double("batteryCelsius", reading.battery_celsius);
  return obj.Finish();
}

}  // namespace

// ---------------------------------------------------------------------------
// Module init
// ---------------------------------------------------------------------------

NAPI_MODULE_INIT() {
  auto state = std::make_unique<AddonState>();

  int mib[2] = {CTL_HW, HW_MEMSIZE};
  size_t ram_len = sizeof(state->total_ram);
  if (sysctl(mib, 2, &state->total_ram, &ram_len, nullptr, 0) != 0) {
    state->total_ram = 0;
  }
  if (host_page_size(state->host.get(), &state->page_size) != KERN_SUCCESS) {
    state->page_size = 0;
  }

  AddonState* raw = state.get();
  if (napi_set_instance_data(env, raw, FinalizeState, nullptr) != napi_ok) {
    ThrowNapiError(env, "napi_set_instance_data");
    return nullptr;  // state still owned by unique_ptr: freed here
  }
  state.release();  // ownership moved to N-API (FinalizeState)

  const napi_property_descriptor props[] = {
      {"getCpuTicks", nullptr, GetCpuTicks, nullptr, nullptr, nullptr, napi_enumerable, raw},
      {"getCpuTopology", nullptr, GetCpuTopology, nullptr, nullptr, nullptr, napi_enumerable, raw},
      {"getMemoryStats", nullptr, GetMemoryStats, nullptr, nullptr, nullptr, napi_enumerable, raw},
      {"getBatteryStats", nullptr, GetBatteryStats, nullptr, nullptr, nullptr, napi_enumerable, raw},
      {"getDieTemperature", nullptr, GetDieTemperature, nullptr, nullptr, nullptr, napi_enumerable, raw},
  };
  if (napi_define_properties(env, exports, std::size(props), props) != napi_ok) {
    ThrowNapiError(env, "napi_define_properties");
    return nullptr;
  }
  return exports;
}
