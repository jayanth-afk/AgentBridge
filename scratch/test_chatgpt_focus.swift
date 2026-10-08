import Cocoa
import ApplicationServices

let frontmostBefore = NSWorkspace.shared.frontmostApplication!
print("Frontmost before: [\(frontmostBefore.processIdentifier)] \(frontmostBefore.localizedName ?? "")")

// High frequency sampler
var running = true
var changed = false
var changedTo = ""

let queue = DispatchQueue(label: "sampler")
queue.async {
    while running {
        if let cur = NSWorkspace.shared.frontmostApplication, cur.processIdentifier != frontmostBefore.processIdentifier {
            changed = true
            changedTo = "[\(cur.processIdentifier)] \(cur.localizedName ?? "")"
        }
        usleep(5000) // 5ms
    }
}

guard let app = NSWorkspace.shared.runningApplications.first(where: {
    $0.bundleIdentifier == "com.openai.codex" && $0.activationPolicy == .regular
}) else {
    print("ChatGPT not running")
    exit(1)
}

let axApp = AXUIElementCreateApplication(app.processIdentifier)
var winVal: AnyObject?
_ = AXUIElementCopyAttributeValue(axApp, kAXMainWindowAttribute as CFString, &winVal)
let win = winVal as! AXUIElement

// Find composer
var composer: AXUIElement? = nil
func walk(_ el: AXUIElement) {
    if composer != nil { return }
    var roleVal: AnyObject?
    AXUIElementCopyAttributeValue(el, kAXRoleAttribute as CFString, &roleVal)
    if (roleVal as? String) == "AXTextArea" {
        composer = el
        return
    }
    var cv: AnyObject?
    if AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &cv) == .success,
       let kids = cv as? [AXUIElement] {
        for k in kids { walk(k) }
    }
}
walk(win)

if let c = composer {
    print("Testing kAXFocusedAttribute on ChatGPT composer...")
    let focusErr = AXUIElementSetAttributeValue(c, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    print("kAXFocusedAttribute error: \(focusErr.rawValue)")
    
    usleep(200_000)
    
    let text = "Test non-activating write [AB:probe_001]"
    let setErr = AXUIElementSetAttributeValue(c, kAXValueAttribute as CFString, text as CFTypeRef)
    print("kAXValueAttribute error: \(setErr.rawValue)")
}

running = false
usleep(50_000)

let frontmostAfter = NSWorkspace.shared.frontmostApplication!
print("Frontmost after: [\(frontmostAfter.processIdentifier)] \(frontmostAfter.localizedName ?? "")")
print("Did frontmost app change at all? \(changed) (changed to: \(changedTo))")
