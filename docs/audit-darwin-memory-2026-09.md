# MiraBar: memory leak and refactor audit, darwin (2026-09-29, rev. 2)

Scope: native/darwin/src/addon.cc, native/darwin/compile.sh + binding.gyp, src/platform/darwin/*, src/extension.ts (darwin-relevant paths).
Baseline: the analysed sources (native/, src/) are byte-identical to `origin/develop` 0e09a22 of fabogit/mira-bar-extension, so every file:line reference applies to develop. The analysis ran on an untracked copy of the sources.
Rev. 2 re-verified every rev. 1 finding against the code and added the items marked **NEW**. The sections below are the original report (file:line references point to develop 0e09a22). The work plan was kept in a separate Claude Doc.
Skills applied: cpp-coding-standards (R.1 RAII, P.8, C.21), memory-safety-patterns, nodejs-core (napi, native-memory).

## Resolution status (2026-10-01)

All 11 items are fixed on the branch `fix/darwin-memory` of mira-bar-extension (from `develop` 0e09a22), merged into the local `develop` on 2026-10-01 (`c5ebaba`, not pushed) together with Phase 1.2. The decisions are recorded as ADR-0002 to ADR-0006, ADR-0011 and ADR-0014 in `docs/adr/`. Confirmed on the Apple M4 with `test/leak-darwin.mjs`: Mach host port references stable, no RSS growth, memory pressure 62% "Warning" matching the kernel, `getDieTemperature` 2.1 µs per call (was 18,046 µs). Also verified on Linux with mocked Apple APIs under ASan/UBSan (0 live CF objects, 0 host urefs at exit) and TSan.

| # | Resolution |
|---|------------|
| 1 | Host port acquired once in `AddonState`, released by `MachSendRight` |
| 2 | `disposed` guard checked before re-arming; timer and config debounce cleared in `deactivate()` |
| 3 | Items disposed and tracked outside `context.subscriptions` |
| 4 | Hidden widgets not sampled; battery, disk and temperature sampled at their section interval |
| 5 | HID client and classified sensors cached; reads moved to a background `ThermalSampler` thread (a pass costs ~16-18 ms, measured with `tools/hid_bench.cc`) |
| 6 | Different fix than proposed in §5: on the M4 the mAh values are only in the `BatteryData` sub-dictionary, not readable key by key, so the full snapshot is kept but taken at most every 30 s; `IOPowerSources` runs only when the battery is sampled |
| 7 | Type-checked getters (`GetInt`, `GetBool`, `GetUtf8`, `GetDictInt`) |
| 8 | `MACH_PORT_NULL` |
| 9 | Same flags in `compile.sh` and `binding.gyp`; `DEBUG=1` ASan build |
| 10 | `100 - kern.memorystatus_level` plus `pressureLevel` from `kern.memorystatus_vm_pressure_level` |
| 11 | `getCpuTicks(Uint32Array)` double buffer, `>>> 0` deltas |

Still open: the `ResourceMonitor` class of §6 (deferred, see docs/ROADMAP.md Phase 1.1). The refresh model, settings panel and widget order added on the same branch are described in docs/ARCHITECTURE.md; the decisions and their reasons are in the Claude Doc plan.

## Priority summary

| # | Issue | Type | Where | Effort |
|---|-------|------|-------|--------|
| 1 | `mach_host_self()` send-right leak, 3 per tick | Leak (Mach urefs) | addon.cc:40,130,134 | S |
| 2 | Timer re-armed after `deactivate()` | Leak (timer + closure) | extension.ts:910-913 | S |
| 3 | Disposed StatusBarItems kept in `context.subscriptions` | Leak (small, per config change) | extension.ts:377, 986 | S |
| 4 | **NEW** Temperature/battery sampled even when widget is hidden | Waste on every tick | extension.ts:580, 734 | XS |
| 5 | HID client + service list created/destroyed every tick | Churn | addon.cc:357-442 | M |
| 6 | Full AppleSmartBattery dictionary copied every tick (via `isBatteryAvailable`) | Churn | addon.cc:280-307, darwin_provider.ts:447 | S |
| 7 | CF values not type-checked before `CFNumberGetValue`/`CFBooleanGetValue` | Crash risk (Extension Host) | addon.cc:240-295 | S |
| 8 | **NEW** `kIOMainPortDefault` is macOS 12+ but target is 11.0 | Crash on macOS 11 | addon.cc:280 | XS |
| 9 | **NEW** Release binary is built by compile.sh, which ignores binding.gyp settings | Build correctness | compile.sh | XS |
| 10 | `vm.memory_pressure` exposed as `pressurePercent` | Wrong metric (confirmed) | addon.cc:165-167 | S |
| 11 | Per-core objects allocated every tick, 32-bit tick wrap clamped to 0 | GC churn / lossy | addon.cc:55-74, darwin_provider.ts:228 | S |

## 1. Leaks (confirmed)

### 1.1 `mach_host_self()` never released (addon.cc:40, 130, 134)
Each call returns the host port with one more user reference (uref) on the send right. Nobody calls `mach_port_deallocate`, so every tick adds 3 urefs: 1 in `getCpuTicks`, 2 in `getMemoryStats`. At the default 2 s interval that is about 5,400 per hour.
This is a leak of kernel port references, not of heap memory, so RSS will not show it. Recent XNU kernels probably cap urefs at `MACH_PORT_UREFS_MAX` instead of failing, but it is still a P.8 violation, and it happens inside the Extension Host process that other extensions share.
Verify: `sudo lsmp -p <pid> | grep -i host` before and after (test/leak-darwin.mjs does this).
Fix: get the port once, store it in addon state and release it in the finalizer (see §5).

### 1.2 Timer re-armed after deactivate (extension.ts:910-913)
```ts
updateTimer = setTimeout(async () => { await update(); scheduleNext(); }, ms);
```
If `deactivate()` runs while `await update()` is in flight (disk sampling is async), `scheduleNext()` starts a new timer afterwards. The `activate` closure then stays alive (provider, widgets, caches) and keeps polling native code.
Fix: a `disposed` flag checked in `scheduleNext()` and in the callback, or better the `ResourceMonitor implements vscode.Disposable` class from §6.

### 1.3 `context.subscriptions` grows (extension.ts:377, 986)
`createWidgets` pushes 6 items into `context.subscriptions` on every alignment/priority change. The old items are disposed but stay referenced in the array until the extension is deactivated.
Fix: do not push widgets. Register one `Disposable` that disposes the *current* widgets.

## 2. Unnecessary work per tick

### 2.1 **NEW** Sampling hidden widgets (extension.ts:580, 734)
```ts
const cpuTemp = platformProvider.sampleTemp();          // runs even if showCpuTemp === false
if (platformProvider.isBatteryAvailable() && config.showBattery)  // battery query runs first
```
With temperature or battery hidden, the most expensive native calls (HID, IOKit battery) still run on every tick. Fix:
```ts
const cpuTemp = config.showCpuTemp ? platformProvider.sampleTemp() : null;
if (config.showBattery && platformProvider.isBatteryAvailable()) { ... }
```

### 2.2 HID client rebuilt every tick (addon.cc:357-442)
Every tick: `IOHIDEventSystemClientCreate`, 2 `CFNumberCreate`, `CFDictionaryCreate`, `SetMatching`, `CopyServices`, then `CopyProperty("Product")` plus a UTF-8 conversion for **every** sensor. All of it is released correctly, but it is the most expensive native path.
Fix: create the client and matching once. Classify services by name once (tdie / NAND / battery) and cache the refs. Keep the `CFArrayRef` alive, because it owns the service refs. Each tick then only calls `IOHIDServiceClientCopyEvent` on the cached services. Rebuild the cache when a tick finds 0 valid tdie readings.

### 2.3 Battery: full dictionary copy on every tick (addon.cc:280-307)
`isBatteryAvailable()` calls the full `getBatteryStats()` on every tick, so decimation never applies. That means `IOPSCopyPowerSourcesInfo` (an XPC round trip to powerd), plus `IORegistryEntryCreateCFProperties`, which copies the whole AppleSmartBattery dictionary (dozens of keys, including nested dictionaries) just to read 4 integers.
Fix:
- Compute battery presence once in the provider constructor and cache it.
- Read the 4 keys with `IORegistryEntryCreateCFProperty`, keeping the `io_service_t` in addon state.
- `DesignCapacity` and `CycleCount` change very rarely, so refresh them every few minutes.

## 3. Correctness and robustness

- **CF type checks (addon.cc:240-295).** Values are cast without checking `CFGetTypeID`. If a key ever holds another type (this has happened across macOS versions for battery keys), `CFNumberGetValue` on a non-number is undefined behaviour and can crash the Extension Host. Use the typed getters in §5.
- **NEW: `kIOMainPortDefault` (addon.cc:280).** Marked `API_AVAILABLE(macos(12.0))`, while binding.gyp targets 11.0. On macOS 11 the weak symbol resolves to null and reading it crashes. Pass `MACH_PORT_NULL`, which is the same value (0) as both `kIOMainPortDefault` and `kIOMasterPortDefault`.
- **NEW: build (compile.sh).** The shipped `.node` comes from compile.sh: on develop, release.yml builds it on `macos-14` via `pnpm run compile:native` and `package:darwin-arm64`. compile.sh ignores binding.gyp and has no `-mmacosx-version-min`, no `NAPI_VERSION`, no `-Wextra`. So the 11.0 target is not applied and availability warnings never appear. Add:
  `-mmacosx-version-min=11.0 -DNAPI_VERSION=8 -Wextra -Wunguarded-availability-new -fvisibility=hidden`
- **`vm.memory_pressure` (addon.cc:167): CONFIRMED wrong.** Measured on the Mac (2026-09-29): `vm.memory_pressure: 6`, `kern.memorystatus_level: 36`, `kern.memorystatus_vm_pressure_level: 2`. The UI shows 6% "Normal" while the kernel is in Warning at about 64% pressure. Fix: `pressurePercent = 100 - kern.memorystatus_level`, and a new `pressureLevel` field (1/2/4) that drives the Normal/Warning/Critical label instead of the 60/80 thresholds (extension.ts:686).
- **napi.** `napi_status` is never checked. Every failure path returns `null` without throwing, so JS cannot tell "no data" from "error". `update(true)` is silently dropped while `isUpdating` is set, so a refresh click in Static mode can do nothing. `catch {}` in `update()` swallows everything: at least log once through an OutputChannel.
- **CPU ticks.** `cpu_ticks` are 32-bit and wrap. The provider clamps negative deltas to 0 and loses that sample. `(cur - prev) >>> 0` gives the correct modular delta.
- **P/E mapping.** Assumes E-cores come first by index. It holds on current M-series, but the reliable source is `IODeviceTree:/cpus/cpuN` → `cluster-type` ('E'/'P'). Compute `coreTypes` once, not on every tick (darwin_provider.ts:246).
- **native_loader.** The last candidate path uses `process.cwd()`, which can load a `.node` from any workspace. Drop it in production builds.

## 4. Allocation churn on the JS side

- `getCpuTicks` creates N objects with 4 properties each on every tick (about 50 allocations on a 10-core Mac). Proposal: fill a `Uint32Array` that JS passes in. The layout `out[i*4 + state]` matches `cpu_ticks` exactly, so the native side is one `memcpy` from `processor_info`. The provider keeps two buffers and swaps them, so there are zero allocations per tick.
- `getConfig()` is called twice per tick (`update` and `scheduleNext`). Cache it and invalidate it in `onDidChangeConfiguration`.
- Tooltip Markdown in Live mode is rebuilt for all widgets on every tick. Throttle to >= 1 s.

## 5. Proposed native refactor (RAII + addon state)

```cpp
// --- RAII wrappers (R.1, C.21: move-only) ---------------------------------
template <typename T>  // T = any CF*Ref; adopts a +1 ref (Create/Copy rule)
class CFRef {
 public:
  CFRef() noexcept = default;
  explicit CFRef(T r) noexcept : ref_(r) {}
  ~CFRef() { reset(); }
  CFRef(const CFRef&) = delete;
  CFRef& operator=(const CFRef&) = delete;
  CFRef(CFRef&& o) noexcept : ref_(std::exchange(o.ref_, nullptr)) {}
  CFRef& operator=(CFRef&& o) noexcept {
    if (this != &o) { reset(); ref_ = std::exchange(o.ref_, nullptr); }
    return *this;
  }
  void reset(T r = nullptr) noexcept { if (ref_) CFRelease(ref_); ref_ = r; }
  T get() const noexcept { return ref_; }
  explicit operator bool() const noexcept { return ref_ != nullptr; }
 private:
  T ref_ = nullptr;
};

class IOObject {            // io_service_t / io_registry_entry_t
 public:
  explicit IOObject(io_object_t o = IO_OBJECT_NULL) noexcept : obj_(o) {}
  ~IOObject() { if (obj_) IOObjectRelease(obj_); }
  IOObject(const IOObject&) = delete;
  IOObject& operator=(const IOObject&) = delete;
  io_object_t get() const noexcept { return obj_; }
 private:
  io_object_t obj_;
};

class MachSendRight {       // fixes leak 1.1
 public:
  explicit MachSendRight(mach_port_t p) noexcept : port_(p) {}
  ~MachSendRight() { if (MACH_PORT_VALID(port_)) mach_port_deallocate(mach_task_self(), port_); }
  MachSendRight(const MachSendRight&) = delete;
  MachSendRight& operator=(const MachSendRight&) = delete;
  mach_port_t get() const noexcept { return port_; }
 private:
  mach_port_t port_;
};

// --- Type-checked CF getters (fixes §3 crash risk) -------------------------
static bool GetInt(CFTypeRef v, int& out) {
  return v && CFGetTypeID(v) == CFNumberGetTypeID() &&
         CFNumberGetValue(static_cast<CFNumberRef>(v), kCFNumberIntType, &out);
}
static bool GetBool(CFTypeRef v, bool& out) {
  if (!v || CFGetTypeID(v) != CFBooleanGetTypeID()) return false;
  out = CFBooleanGetValue(static_cast<CFBooleanRef>(v));
  return true;
}
static bool ReadRegistryInt(io_registry_entry_t e, CFStringRef key, int& out) {
  CFRef<CFTypeRef> v(IORegistryEntryCreateCFProperty(e, key, kCFAllocatorDefault, 0));
  return GetInt(v.get(), out);
}

// --- Per-env state, freed on Extension Host teardown ------------------------
enum class SensorKind { Die, Nand, Battery };
struct Sensor { IOHIDServiceClientRef svc; SensorKind kind; std::string name; };  // svc owned by services

struct AddonState {
  MachSendRight host{mach_host_self()};          // acquired ONCE
  vm_size_t page_size = 0;                        // constant: read once
  uint64_t total_ram = 0;                         // constant: read once
  CFRef<IOHIDEventSystemClientRef> hid_client;
  CFRef<CFArrayRef> hid_services;                 // keeps Sensor::svc alive
  std::vector<Sensor> sensors;                    // classified once
  IOObject smart_battery{IOServiceGetMatchingService(
      MACH_PORT_NULL, IOServiceMatching("AppleSmartBattery"))};  // no kIOMainPortDefault
};

static void FinalizeState(napi_env, void* data, void*) {
  delete static_cast<AddonState*>(data);
}

NAPI_MODULE_INIT() {
  auto state = std::make_unique<AddonState>();
  // ... fill page_size / total_ram once ...
  if (napi_set_instance_data(env, state.get(), FinalizeState, nullptr) != napi_ok) return nullptr;
  AddonState* s = state.release();                // ownership moved to napi
  const napi_property_descriptor props[] = {
    {"getCpuTicks", nullptr, GetCpuTicks, nullptr, nullptr, nullptr, napi_default, s},
    // ... same for the other 4, passing s as data (read back with napi_get_cb_info)
  };
  if (napi_define_properties(env, exports, std::size(props), props) != napi_ok) return nullptr;
  return exports;
}
```

Also:
- Wrap the `host_processor_info` buffer in a small `VmRegion` RAII, so `vm_deallocate` runs on every path.
- Add a `CHECK_NAPI(call)` macro that throws a JS error on non-`napi_ok`.
- Only if measurements after caching show HID or battery > ~1 ms per call: move them to `napi_async_work` or a native sampler thread. With a background thread the cached HID state needs a mutex, or must be used from that thread only.

## 6. Proposed TypeScript refactor (darwin-relevant)

- `ResourceMonitor implements vscode.Disposable`: owns the timer, the widgets, the provider and a `disposed` flag. Fixes 1.2 and 1.3. `activate` becomes `context.subscriptions.push(new ResourceMonitor(...))`.
- Split `update()` (about 500 lines) into one renderer per widget: `renderCpu(sample, config, withTooltip)`, and so on.
- `TelemetryPlatformProvider.dispose?()`. Darwin: cache battery presence, double-buffer CPU ticks, compute `coreTypes` once.
- Order of checks per §2.1. Cache the config.

## 7. How to verify on the Mac

1. Baseline before any change (current code):
   ```
   pnpm run compile:native
   node --expose-gc test/leak-darwin.mjs --pause
   # in a second terminal
   sudo lsmp -p <PID> | grep -i host          # host send-right urefs grow with calls
   MallocStackLogging=1 leaks <PID>            # native CF/heap leaks (expect 0 today)
   sysctl vm.memory_pressure kern.memorystatus_level kern.memorystatus_vm_pressure_level
   ```
   Note the `µs/call` column. `getDieTemperature` and `getBatteryStats` should be the most expensive.
2. After the fixes: host urefs stay flat, `µs/call` for HID and battery should drop sharply, and `leaks` still reports 0.
3. Optional ASan build: add `-fsanitize=address -g -O1` to compile.sh and run with `DYLD_INSERT_LIBRARIES=$(clang -print-file-name=libclang_rt.asan_osx_dynamic.dylib)`. This works with an nvm/Homebrew node, not a SIP-protected binary.
4. In VS Code: change `mirabar.alignment` 20 times, then run Developer: Reload Window during a tick. The `[MiraBar]` logs must stop after deactivate.

Work on a branch from develop (`git switch -c develop origin/develop && git switch -c fix/darwin-memory`). The macos-14 CI job already runs `test:darwin` and `test:integration`; test/leak-darwin.mjs can be added there.
The session's device_bash runs in a Linux VM, so the macOS addon cannot be compiled or run from the session. The user runs the tests on the Mac.
