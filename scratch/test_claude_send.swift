import Cocoa
import ApplicationServices

guard let app = NSWorkspace.shared.runningApplications.first(where: { $0.bundleIdentifier == "com.anthropic.claudefordesktop" || $0.localizedName == "Claude" }) else {
    print("Claude not found")
    exit(1)
}

let axApp = AXUIElementCreateApplication(app.processIdentifier)
_ = AXUIElementSetAttributeValue(axApp, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
_ = AXUIElementSetAttributeValue(axApp, "AXManualAccessibility" as CFString, kCFBooleanTrue)

var winVal: AnyObject?
AXUIElementCopyAttributeValue(axApp, kAXMainWindowAttribute as CFString, &winVal)
if winVal == nil {
    var winsVal: AnyObject?
    AXUIElementCopyAttributeValue(axApp, kAXWindowsAttribute as CFString, &winsVal)
    if let wins = winsVal as? [AXUIElement], !wins.isEmpty { winVal = wins[0] }
}
guard let win = winVal else {
    print("No window found")
    exit(1)
}
let winEl = win as! AXUIElement

func findInput(_ el: AXUIElement) -> AXUIElement? {
    var roleVal: AnyObject?
    AXUIElementCopyAttributeValue(el, kAXRoleAttribute as CFString, &roleVal)
    let role = (roleVal as? String) ?? ""
    if role == "AXTextArea" { return el }
    var childrenVal: AnyObject?
    if AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &childrenVal) == .success,
       let children = childrenVal as? [AXUIElement] {
        for c in children {
            if let found = findInput(c) { return found }
        }
    }
    return nil
}

func findSendBtn(_ el: AXUIElement) -> (AXUIElement?, Bool) {
    var foundBtn: AXUIElement? = nil
    var isEnabled = false
    func walk(_ e: AXUIElement) {
        if foundBtn != nil { return }
        var descVal: AnyObject?
        AXUIElementCopyAttributeValue(e, kAXDescriptionAttribute as CFString, &descVal)
        let desc = ((descVal as? String) ?? "").lowercased()
        var titleVal: AnyObject?
        AXUIElementCopyAttributeValue(e, kAXTitleAttribute as CFString, &titleVal)
        let title = ((titleVal as? String) ?? "").lowercased()
        if desc == "send message" || desc == "send" || title == "send" || title == "send message" {
            foundBtn = e
            var enVal: AnyObject?
            if AXUIElementCopyAttributeValue(e, kAXEnabledAttribute as CFString, &enVal) == .success,
               let en = enVal as? Bool {
                isEnabled = en
            }
            return
        }
        var cv: AnyObject?
        if AXUIElementCopyAttributeValue(e, kAXChildrenAttribute as CFString, &cv) == .success,
           let kids = cv as? [AXUIElement] {
            for k in kids { walk(k) }
        }
    }
    walk(el)
    return (foundBtn, isEnabled)
}

guard let input = findInput(winEl) else {
    print("Input not found")
    exit(1)
}

let testText = "Say ClaudeOK [AB:req_test_claude_001]"

// Try setting AXSelectedText and kAXValueAttribute
let selErr = AXUIElementSetAttributeValue(input, "AXSelectedText" as CFString, testText as CFTypeRef)
let valErr = AXUIElementSetAttributeValue(input, kAXValueAttribute as CFString, testText as CFTypeRef)
print("selErr: \(selErr.rawValue), valErr: \(valErr.rawValue)")

usleep(300_000)

let (btn, enabled) = findSendBtn(winEl)
print("Send button found: \(btn != nil), enabled: \(enabled)")

if let b = btn, enabled {
    let pressErr = AXUIElementPerformAction(b, kAXPressAction as CFString)
    print("pressErr: \(pressErr.rawValue)")
}
