import Cocoa
import ApplicationServices

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

var comp: AXUIElement?
func findAskChatGPT(_ el: AXUIElement) {
    if comp != nil { return }
    var roleVal: AnyObject?
    AXUIElementCopyAttributeValue(el, kAXRoleAttribute as CFString, &roleVal)
    var descVal: AnyObject?
    AXUIElementCopyAttributeValue(el, kAXDescriptionAttribute as CFString, &descVal)
    let role = (roleVal as? String) ?? ""
    let desc = ((descVal as? String) ?? "").lowercased()
    if role == "AXTextArea" && desc.contains("ask chatgpt") {
        comp = el
        return
    }
    var cv: AnyObject?
    if AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &cv) == .success,
       let kids = cv as? [AXUIElement] {
        for k in kids { findAskChatGPT(k) }
    }
}
findAskChatGPT(win)
guard let c = comp else { print("No comp"); exit(1) }

var attrNames: CFArray?
AXUIElementCopyAttributeNames(c, &attrNames)
if let names = attrNames as? [String] {
    print("All attributes of composer:")
    for n in names {
        var isSettable: DarwinBoolean = false
        AXUIElementIsAttributeSettable(c, n as CFString, &isSettable)
        var val: AnyObject?
        AXUIElementCopyAttributeValue(c, n as CFString, &val)
        let sVal = String(describing: val as Any)
        print("  \(n) (settable=\(isSettable.boolValue)): \(sVal.prefix(50))")
    }
}
