import Cocoa
import ApplicationServices

guard let app = NSWorkspace.shared.runningApplications.first(where: {
    ($0.bundleIdentifier == "com.google.GeminiMacOS" || $0.localizedName == "Gemini") && $0.activationPolicy == .regular
}) else {
    print("Gemini not running")
    exit(1)
}

print("Gemini PID:", app.processIdentifier)
let ax = AXUIElementCreateApplication(app.processIdentifier)
_ = AXUIElementSetAttributeValue(ax, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
_ = AXUIElementSetAttributeValue(ax, "AXManualAccessibility" as CFString, kCFBooleanTrue)

var v1: AnyObject?
let e1 = AXUIElementCopyAttributeValue(ax, kAXMainWindowAttribute as CFString, &v1)
print("kAXMainWindowAttribute: err =", e1.rawValue, "val =", v1 != nil)

var v2: AnyObject?
let e2 = AXUIElementCopyAttributeValue(ax, kAXFocusedWindowAttribute as CFString, &v2)
print("kAXFocusedWindowAttribute: err =", e2.rawValue, "val =", v2 != nil)

var v3: AnyObject?
let e3 = AXUIElementCopyAttributeValue(ax, kAXWindowsAttribute as CFString, &v3)
let wins = v3 as? [AXUIElement] ?? []
print("kAXWindowsAttribute: err =", e3.rawValue, "count =", wins.count)

for (idx, w) in wins.enumerated() {
    var titleVal: AnyObject?
    _ = AXUIElementCopyAttributeValue(w, kAXTitleAttribute as CFString, &titleVal)
    var roleVal: AnyObject?
    _ = AXUIElementCopyAttributeValue(w, kAXRoleAttribute as CFString, &roleVal)
    print("  Window \(idx): role = \(roleVal ?? "nil" as AnyObject), title = \(titleVal ?? "nil" as AnyObject)")
}
