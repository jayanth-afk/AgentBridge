import Cocoa
import ApplicationServices

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
_ = AXUIElementCopyAttributeValue(axApp, kAXMainWindowAttribute as CFString, &winVal)
if winVal == nil {
    _ = AXUIElementCopyAttributeValue(axApp, kAXWindowsAttribute as CFString, &winVal)
    if let wins = winVal as? [AXUIElement] { winVal = wins.first }
}
guard let win = winVal as! AXUIElement? else { print("No win"); exit(1) }

var composer: AXUIElement?
func findComp(_ el: AXUIElement) {
    if composer != nil { return }
    let role = axString(el, kAXRoleAttribute)
    if role == "AXTextArea" {
        composer = el
        return
    }
    var cv: AnyObject?
    if AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &cv) == .success,
       let kids = cv as? [AXUIElement] {
        for k in kids { findComp(k) }
    }
}
findComp(win)

guard let comp = composer else { print("No composer"); exit(1) }
print("Found composer: desc=\(axString(comp, kAXDescriptionAttribute))")

// Set AXSelectedText
let testText = "What is 2+2? [AB:test_calc_001]"
_ = AXUIElementSetAttributeValue(comp, "AXSelectedText" as CFString, testText as CFTypeRef)
_ = AXUIElementSetAttributeValue(comp, kAXValueAttribute as CFString, testText as CFTypeRef)

usleep(300_000)

print("\nSearching for all enabled buttons in ChatGPT window:")
func findButtons(_ el: AXUIElement, depth: Int) {
    if depth > 40 { return }
    let role = axString(el, kAXRoleAttribute)
    if role == "AXButton" && axBool(el, kAXEnabledAttribute) {
        let desc = axString(el, kAXDescriptionAttribute)
        let title = axString(el, kAXTitleAttribute)
        if desc.lowercased().contains("send") || desc.lowercased().contains("prompt") || desc.lowercased().contains("submit") || title.lowercased().contains("send") {
            print("  BUTTON [\(depth)]: title='\(title)', desc='\(desc)'")
        }
    }
    var cv: AnyObject?
    if AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &cv) == .success,
       let kids = cv as? [AXUIElement] {
        for k in kids { findButtons(k, depth: depth + 1) }
    }
}
findButtons(win, depth: 0)
