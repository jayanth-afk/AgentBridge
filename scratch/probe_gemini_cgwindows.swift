import Cocoa
import CoreGraphics

let windowList = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] ?? []
let geminiWindows = windowList.filter { ($0[kCGWindowOwnerPID as String] as? pid_t) == 11774 }

print("Found \(geminiWindows.count) CGWindows for Gemini (PID 11774):")
for w in geminiWindows {
    let name = w[kCGWindowName as String] as? String ?? ""
    let bounds = w[kCGWindowBounds as String] as? [String: Any] ?? [:]
    let layer = w[kCGWindowLayer as String] as? Int ?? -1
    let isOnscreen = w[kCGWindowIsOnscreen as String] as? Bool ?? false
    let alpha = w[kCGWindowAlpha as String] as? Double ?? -1
    print("  Window ID: \(w[kCGWindowNumber as String] ?? ""), Layer: \(layer), Onscreen: \(isOnscreen), Alpha: \(alpha), Bounds: \(bounds), Name: '\(name)'")
}
