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

func pressNewChat(_ el: AXUIElement, depth: Int) -> Bool {
    if depth > 40 { return false }
    if axString(el, kAXRoleAttribute) == "AXButton" {
        let title = axString(el, kAXTitleAttribute)
        let desc = axString(el, kAXDescriptionAttribute)
        if (title == "New chat" || desc == "New chat") && axBool(el, kAXEnabledAttribute) {
            print("Pressing New chat button at depth \(depth)...")
            let err = AXUIElementPerformAction(el, kAXPressAction as CFString)
            print("AXPress result: \(err.rawValue)")
            return true
        }
    }
    var cv: AnyObject?
    if AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &cv) == .success,
       let kids = cv as? [AXUIElement] {
        for k in kids { if pressNewChat(k, depth: depth + 1) { return true } }
    }
    return false
}

_ = pressNewChat(win, depth: 0)
