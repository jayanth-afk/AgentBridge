import Cocoa
import ApplicationServices

// Run with bridge-ax-helper logic
func axString(_ el: AXUIElement, _ attr: String) -> String {
    var v: AnyObject?
    if AXUIElementCopyAttributeValue(el, attr as CFString, &v) == .success, let x = v as? String { return x }
    return ""
}
func axBool(_ el: AXUIElement, _ attr: String) -> Bool {
    var v: AnyObject?
    if AXUIElementCopyAttributeValue(el, attr as CFString, &v) == .success, let x = v as? Bool { return x }
    return false
}

let apps = NSRunningApplication.runningApplications(withBundleIdentifier: "com.openai.codex")
guard let app = apps.first else { print("No app"); exit(1) }
let axApp = AXUIElementCreateApplication(app.processIdentifier)
_ = AXUIElementSetAttributeValue(axApp, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
_ = AXUIElementSetAttributeValue(axApp, "AXManualAccessibility" as CFString, kCFBooleanTrue)

var winVal: AnyObject?
_ = AXUIElementCopyAttributeValue(axApp, kAXWindowsAttribute as CFString, &winVal)
guard let wins = winVal as? [AXUIElement], let win = wins.first else { print("No win"); exit(1) }

let names: Set<String> = ["send", "send message", "submit"]
func walk(_ el: AXUIElement, _ depth: Int) {
    if depth > 90 { return }
    if axString(el, kAXRoleAttribute) == "AXButton" {
        let title = axString(el, kAXTitleAttribute).lowercased()
        let desc = axString(el, kAXDescriptionAttribute).lowercased()
        let enabled = axBool(el, kAXEnabledAttribute)
        if names.contains(title) || names.contains(desc) || title.contains("send") || desc.contains("send") {
            print("FOUND BUTTON: title='\(title)', desc='\(desc)', enabled=\(enabled)")
        }
    }
    var cv: AnyObject?
    if AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &cv) == .success,
       let kids = cv as? [AXUIElement] {
        for k in kids { walk(k, depth + 1) }
    }
}

walk(win, 0)
