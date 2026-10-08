import Cocoa
import ApplicationServices

guard let app = NSWorkspace.shared.runningApplications.first(where: { $0.bundleIdentifier == "com.openai.codex" || $0.localizedName == "ChatGPT" }) else {
    print("ChatGPT not found")
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

func findComposer(_ el: AXUIElement) -> AXUIElement? {
    var found: AXUIElement? = nil
    func walk(_ e: AXUIElement) {
        if found != nil { return }
        var roleVal: AnyObject?
        AXUIElementCopyAttributeValue(e, kAXRoleAttribute as CFString, &roleVal)
        let role = (roleVal as? String) ?? ""
        if role == "AXTextArea" {
            var descVal: AnyObject?
            AXUIElementCopyAttributeValue(e, kAXDescriptionAttribute as CFString, &descVal)
            let desc = ((descVal as? String) ?? "").lowercased()
            if desc.contains("ask chatgpt") {
                found = e
                return
            }
        }
        var cv: AnyObject?
        if AXUIElementCopyAttributeValue(e, kAXChildrenAttribute as CFString, &cv) == .success,
           let kids = cv as? [AXUIElement] {
            for k in kids { walk(k) }
        }
    }
    walk(el)
    return found
}

func findSendBtn(_ el: AXUIElement) -> (AXUIElement?, Bool) {
    var foundBtn: AXUIElement? = nil
    var isEnabled = false
    func walk(_ e: AXUIElement) {
        if foundBtn != nil { return }
        var roleVal: AnyObject?
        AXUIElementCopyAttributeValue(e, kAXRoleAttribute as CFString, &roleVal)
        let role = (roleVal as? String) ?? ""
        if role == "AXButton" {
            var descVal: AnyObject?
            AXUIElementCopyAttributeValue(e, kAXDescriptionAttribute as CFString, &descVal)
            let desc = ((descVal as? String) ?? "").lowercased()
            var titleVal: AnyObject?
            AXUIElementCopyAttributeValue(e, kAXTitleAttribute as CFString, &titleVal)
            let title = ((titleVal as? String) ?? "").lowercased()
            if desc == "send" || title == "send" || desc == "send message" {
                foundBtn = e
                var enVal: AnyObject?
                if AXUIElementCopyAttributeValue(e, kAXEnabledAttribute as CFString, &enVal) == .success,
                   let en = enVal as? Bool {
                    isEnabled = en
                }
                return
            }
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

guard let composer = findComposer(winEl) else {
    print("Composer not found")
    exit(1)
}

_ = AXUIElementSetAttributeValue(composer, kAXFocusedAttribute as CFString, kCFBooleanTrue)

var range = CFRange(location: 0, length: 1000)
if let rangeVal = AXValueCreate(.cfRange, &range) {
    _ = AXUIElementSetAttributeValue(composer, kAXSelectedTextRangeAttribute as CFString, rangeVal)
}

let testPrompt = "Say ChatGPTOK [AB:req_test_cg_001]"
let sErr = AXUIElementSetAttributeValue(composer, "AXSelectedText" as CFString, testPrompt as CFTypeRef)
let vErr = AXUIElementSetAttributeValue(composer, kAXValueAttribute as CFString, testPrompt as CFTypeRef)
print("sErr: \(sErr.rawValue), vErr: \(vErr.rawValue)")

usleep(300_000)

let (btn, enabled) = findSendBtn(winEl)
print("Send button found: \(btn != nil), enabled: \(enabled)")

if let b = btn, enabled {
    let pErr = AXUIElementPerformAction(b, kAXPressAction as CFString)
    print("Pressed: \(pErr.rawValue)")
}
