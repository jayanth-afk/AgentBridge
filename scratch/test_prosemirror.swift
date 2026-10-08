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

var comp: AXUIElement?
var sendBtn: AXUIElement?

func walk(_ el: AXUIElement) {
    let role = axString(el, kAXRoleAttribute)
    let desc = axString(el, kAXDescriptionAttribute).lowercased()
    let title = axString(el, kAXTitleAttribute).lowercased()
    if role == "AXTextArea" && (desc.contains("ask chatgpt") || title.contains("ask chatgpt")) {
        comp = el
    }
    if role == "AXButton" && (title == "send" || desc == "send") {
        sendBtn = el
    }
    var cv: AnyObject?
    if AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &cv) == .success,
       let kids = cv as? [AXUIElement] {
        for k in kids { walk(k) }
    }
}
walk(win)
guard let c = comp, let btn = sendBtn else { print("Missing comp or btn"); exit(1) }

// Select entire range (0, 50)
var range = CFRange(location: 0, length: 50)
if let rangeVal = AXValueCreate(.cfRange, &range) {
    let rErr = AXUIElementSetAttributeValue(c, kAXSelectedTextRangeAttribute as CFString, rangeVal)
    print("Set selected text range result: \(rErr.rawValue)")
}

let testText = "Raft consensus leader thesis in 1 sentence. [AB:test_cg_003]"
let selErr = AXUIElementSetAttributeValue(c, "AXSelectedText" as CFString, testText as CFTypeRef)
print("Set AXSelectedText result: \(selErr.rawValue)")

usleep(250_000)

print("Comp value now: \(axString(c, kAXValueAttribute))")
print("Send button enabled: \(axBool(btn, kAXEnabledAttribute))")

if axBool(btn, kAXEnabledAttribute) {
    let pressErr = AXUIElementPerformAction(btn, kAXPressAction as CFString)
    print("AXPress result: \(pressErr.rawValue)")
}
