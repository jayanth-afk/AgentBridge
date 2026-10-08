import Cocoa
import ApplicationServices

func axString(_ el: AXUIElement, _ attr: String) -> String {
    var v: AnyObject?
    if AXUIElementCopyAttributeValue(el, attr as CFString, &v) == .success, let x = v as? String { return x }
    return ""
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

var sendBtn: AXUIElement?
func findSend(_ el: AXUIElement) {
    if sendBtn != nil { return }
    let role = axString(el, kAXRoleAttribute)
    let title = axString(el, kAXTitleAttribute)
    if role == "AXButton" && title == "Send" {
        sendBtn = el
        return
    }
    var cv: AnyObject?
    if AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &cv) == .success,
       let kids = cv as? [AXUIElement] {
        for k in kids { findSend(k) }
    }
}
findSend(win)
guard let btn = sendBtn else { print("No send button"); exit(1) }

var actionNames: CFArray?
AXUIElementCopyActionNames(btn, &actionNames)
print("Supported actions on Send button: \(actionNames as? [String] ?? [])")

let pressErr = AXUIElementPerformAction(btn, kAXPressAction as CFString)
print("AXPress result: \(pressErr.rawValue)")
