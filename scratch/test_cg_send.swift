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
func findAskChatGPT(_ el: AXUIElement) {
    if comp != nil { return }
    let role = axString(el, kAXRoleAttribute)
    let desc = axString(el, kAXDescriptionAttribute).lowercased()
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

guard let c = comp else { print("No Ask ChatGPT found"); exit(1) }
print("Found Ask ChatGPT composer!")

let testPrompt = "State in 1 sentence the primary role of a Raft leader. [AB:test_cg_live_01]"
_ = AXUIElementSetAttributeValue(c, "AXSelectedText" as CFString, testPrompt as CFTypeRef)
_ = AXUIElementSetAttributeValue(c, kAXValueAttribute as CFString, testPrompt as CFTypeRef)

usleep(300_000)

var sendBtn: AXUIElement?
func findSend(_ el: AXUIElement) {
    if sendBtn != nil { return }
    let role = axString(el, kAXRoleAttribute)
    let desc = axString(el, kAXDescriptionAttribute).lowercased()
    let title = axString(el, kAXTitleAttribute).lowercased()
    if role == "AXButton" && axBool(el, kAXEnabledAttribute) {
        if desc == "send prompt" || desc == "send message" || desc == "send" || title == "send" || desc.contains("send") {
            print("Found send candidate: title='\(title)', desc='\(desc)'")
            sendBtn = el
            return
        }
    }
    var cv: AnyObject?
    if AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &cv) == .success,
       let kids = cv as? [AXUIElement] {
        for k in kids { findSend(k) }
    }
}
findSend(win)

if let btn = sendBtn {
    print("Pressing send button...")
    let err = AXUIElementPerformAction(btn, kAXPressAction as CFString)
    print("AXPress result: \(err.rawValue)")
} else {
    print("Send button NOT found!")
}
