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
guard let c = comp else { print("No comp"); exit(1) }

// Get parent
var parentVal: AnyObject?
AXUIElementCopyAttributeValue(c, kAXParentAttribute as CFString, &parentVal)
guard let parent = parentVal else { print("No parent"); exit(1) }

// Go up 2 levels
var grandParentVal: AnyObject?
let top = (grandParentVal != nil) ? (grandParentVal as! AXUIElement) : (parent as! AXUIElement)

func printSubtree(_ el: AXUIElement, depth: Int) {
    if depth > 10 { return }
    let role = axString(el, kAXRoleAttribute)
    let desc = axString(el, kAXDescriptionAttribute)
    let title = axString(el, kAXTitleAttribute)
    let enabled = axBool(el, kAXEnabledAttribute)
    print("[\(depth)] role=\(role) title='\(title)' desc='\(desc)' enabled=\(enabled)")
    var cv: AnyObject?
    if AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &cv) == .success,
       let kids = cv as? [AXUIElement] {
        for k in kids { printSubtree(k, depth: depth + 1) }
    }
}

print("Subtree around composer:")
printSubtree(top, depth: 0)
