import Foundation
import ApplicationServices
import AppKit

// Data structures for JSON communication over stdin/stdout
struct RequestOp: Codable {
    let op: String
    let app: String?
    let appName: String?
    let bundleId: String?
    let value: String?
    let text: String?
    let requestId: String?
    let pid: pid_t?
    let identifier: String?
    let role: String?
    let timeoutMs: Int?

    var targetApp: String {
        return app ?? appName ?? "Claude"
    }

    var payloadText: String {
        return text ?? value ?? ""
    }
}

struct SendTurnResponse: Codable {
    let ok: Bool
    let status: String
    let requestId: String?
    let error: String?
}

struct ObserveTurnResponse: Codable {
    let ok: Bool
    let status: String
    let requestId: String?
    let response: String?
    let latencyMs: Double?
    let error: String?
}

struct WindowInfo: Codable {
    let title: String
    let minimized: Bool
    let main: Bool
}

struct InspectResponse: Codable {
    let ok: Bool
    let app: String
    let running: Bool
    let pid: pid_t?
    let windowCount: Int
    let windows: [String]
    let windowDetails: [WindowInfo]
    let hidden: Bool
    let error: String?
}

struct ElementInfo: Codable {
    let role: String
    let subrole: String?
    let title: String?
    let description: String?
    let identifier: String?
    let value: String?
    let enabled: Bool
    let depth: Int
}

struct ElementsResponse: Codable {
    let ok: Bool
    let app: String
    let pid: pid_t
    let elements: [ElementInfo]
    let error: String?
}

struct FrontmostResponse: Codable {
    let ok: Bool
    let name: String
    let pid: pid_t
    let bundleId: String?
}

struct SimpleResponse: Codable {
    let ok: Bool
    let status: String
    let details: String?
}

func findAppProcess(name: String) -> NSRunningApplication? {
    let apps = NSWorkspace.shared.runningApplications
    return apps.first { app in
        if let appName = app.localizedName, appName.caseInsensitiveCompare(name) == .orderedSame {
            return true
        }
        if let bundle = app.bundleIdentifier, bundle.lowercased().contains(name.lowercased()) {
            return true
        }
        return false
    }
}

func findAppByPid(pid: pid_t) -> NSRunningApplication? {
    return NSRunningApplication(processIdentifier: pid)
}

func getFrontmostApp() -> FrontmostResponse {
    if let front = NSWorkspace.shared.frontmostApplication {
        return FrontmostResponse(
            ok: true,
            name: front.localizedName ?? "Unknown",
            pid: front.processIdentifier,
            bundleId: front.bundleIdentifier
        )
    }
    return FrontmostResponse(ok: false, name: "None", pid: 0, bundleId: nil)
}

func inspectApp(name: String) -> InspectResponse {
    guard let app = findAppProcess(name: name) else {
        return InspectResponse(ok: false, app: name, running: false, pid: nil, windowCount: 0, windows: [], windowDetails: [], hidden: false, error: "APP_NOT_RUNNING")
    }

    let pid = app.processIdentifier
    let isHidden = app.isHidden
    let axApp = AXUIElementCreateApplication(pid)

    var windowsValue: AnyObject?
    let result = AXUIElementCopyAttributeValue(axApp, kAXWindowsAttribute as CFString, &windowsValue)

    var windowTitles: [String] = []
    var windowDetails: [WindowInfo] = []
    var windowCount = 0

    if result == .success, let windows = windowsValue as? [AXUIElement] {
        windowCount = windows.count
        for win in windows {
            var titleVal: AnyObject?
            let titleStr: String
            if AXUIElementCopyAttributeValue(win, kAXTitleAttribute as CFString, &titleVal) == .success,
               let str = titleVal as? String {
                titleStr = str
            } else {
                titleStr = "Untitled Window"
            }
            windowTitles.append(titleStr)

            var minVal: AnyObject?
            var isMin = false
            if AXUIElementCopyAttributeValue(win, kAXMinimizedAttribute as CFString, &minVal) == .success,
               let b = minVal as? Bool {
                isMin = b
            }

            var mainVal: AnyObject?
            var isMain = false
            if AXUIElementCopyAttributeValue(win, kAXMainAttribute as CFString, &mainVal) == .success,
               let b = mainVal as? Bool {
                isMain = b
            }

            windowDetails.append(WindowInfo(title: titleStr, minimized: isMin, main: isMain))
        }
    }

    return InspectResponse(
        ok: true,
        app: name,
        running: true,
        pid: pid,
        windowCount: windowCount,
        windows: windowTitles,
        windowDetails: windowDetails,
        hidden: isHidden,
        error: nil
    )
}

func inspectElements(name: String) -> ElementsResponse {
    guard let app = findAppProcess(name: name) else {
        return ElementsResponse(ok: false, app: name, pid: 0, elements: [], error: "APP_NOT_RUNNING")
    }

    let pid = app.processIdentifier
    let axApp = AXUIElementCreateApplication(pid)
    // Electron/WebKit applications may expose only window chrome until enhanced
    // accessibility is enabled. This remains within the user-authorized AX API.
    _ = AXUIElementSetAttributeValue(axApp, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
    _ = AXUIElementSetAttributeValue(axApp, "AXManualAccessibility" as CFString, kCFBooleanTrue)

    var windowsValue: AnyObject?
    guard AXUIElementCopyAttributeValue(axApp, kAXWindowsAttribute as CFString, &windowsValue) == .success,
          let windows = windowsValue as? [AXUIElement], let mainWin = windows.first else {
        return ElementsResponse(ok: false, app: name, pid: pid, elements: [], error: "NO_ACCESSIBLE_WINDOW")
    }

    var elements: [ElementInfo] = []

    func walk(_ element: AXUIElement, depth: Int) {
        if depth > 60 || elements.count >= 2000 { return }

        var roleVal: AnyObject?
        AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &roleVal)
        let role = (roleVal as? String) ?? "unknown"

        var subroleVal: AnyObject?
        AXUIElementCopyAttributeValue(element, kAXSubroleAttribute as CFString, &subroleVal)
        let subrole = subroleVal as? String

        var titleVal: AnyObject?
        AXUIElementCopyAttributeValue(element, kAXTitleAttribute as CFString, &titleVal)
        let title = titleVal as? String

        var descVal: AnyObject?
        AXUIElementCopyAttributeValue(element, kAXDescriptionAttribute as CFString, &descVal)
        let desc = descVal as? String

        var idVal: AnyObject?
        AXUIElementCopyAttributeValue(element, kAXIdentifierAttribute as CFString, &idVal)
        let idStr = idVal as? String

        var valVal: AnyObject?
        var valStr: String? = nil
        if AXUIElementCopyAttributeValue(element, kAXValueAttribute as CFString, &valVal) == .success,
           let str = valVal as? String {
            valStr = str.count > 100 ? String(str.prefix(100)) + "..." : str
        }

        var enabledVal: AnyObject?
        var isEnabled = true
        if AXUIElementCopyAttributeValue(element, kAXEnabledAttribute as CFString, &enabledVal) == .success,
           let b = enabledVal as? Bool {
            isEnabled = b
        }

        // Only keep interactable or informative elements
        if role == "AXTextArea" || role == "AXTextField" || role == "AXButton" ||
           role == "AXStaticText" || role == "AXHeading" || role == "AXRow" ||
           role == "AXWebArea" || role == "AXGroup" || (idStr != nil && !idStr!.isEmpty) {
            elements.append(ElementInfo(
                role: role,
                subrole: subrole,
                title: title,
                description: desc,
                identifier: idStr,
                value: valStr,
                enabled: isEnabled,
                depth: depth
            ))
        }

        var childrenVal: AnyObject?
        if AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &childrenVal) == .success,
           let children = childrenVal as? [AXUIElement] {
            for child in children {
                walk(child, depth: depth + 1)
            }
        }
    }

    walk(mainWin, depth: 0)
    return ElementsResponse(ok: true, app: name, pid: pid, elements: elements, error: nil)
}

func activateApp(name: String) -> SimpleResponse {
    guard let app = findAppProcess(name: name) else {
        return SimpleResponse(ok: false, status: "APP_NOT_RUNNING", details: nil)
    }
    app.unhide()
    let success = app.activate(options: [])
    return SimpleResponse(ok: success, status: success ? "ACTIVATED" : "FAILED", details: nil)
}

func restoreFocusToPid(pid: pid_t) -> SimpleResponse {
    guard let app = findAppByPid(pid: pid) else {
        return SimpleResponse(ok: false, status: "PROCESS_NOT_FOUND", details: nil)
    }
    let success = app.activate(options: [])
    return SimpleResponse(ok: success, status: success ? "RESTORED" : "FAILED", details: nil)
}

func unhideApp(name: String) -> SimpleResponse {
    guard let app = findAppProcess(name: name) else {
        return SimpleResponse(ok: false, status: "APP_NOT_RUNNING", details: nil)
    }
    let success = app.unhide()
    return SimpleResponse(ok: success, status: success ? "UNHIDDEN" : "FAILED", details: nil)
}

// AXObserver state
var activeObserver: AXObserver? = nil
var activeRunLoopSource: CFRunLoopSource? = nil

func setupObserver(name: String) -> SimpleResponse {
    guard let app = findAppProcess(name: name) else {
        return SimpleResponse(ok: false, status: "APP_NOT_RUNNING", details: nil)
    }

    let pid = app.processIdentifier
    var observerRef: AXObserver?
    let err = AXObserverCreate(pid, { (observer, element, notification, refcon) in
        let notifStr = notification as String
        print("{\"event\":\"ax_notification\",\"type\":\"\(notifStr)\",\"timestamp\":\(Date().timeIntervalSince1970)}")
        fflush(stdout)
    }, &observerRef)

    guard err == .success, let observer = observerRef else {
        return SimpleResponse(ok: false, status: "OBSERVER_CREATE_FAILED", details: "\(err.rawValue)")
    }

    let axApp = AXUIElementCreateApplication(pid)
    _ = AXObserverAddNotification(observer, axApp, kAXValueChangedNotification as CFString, nil)
    _ = AXObserverAddNotification(observer, axApp, kAXWindowCreatedNotification as CFString, nil)
    _ = AXObserverAddNotification(observer, axApp, kAXFocusedUIElementChangedNotification as CFString, nil)

    activeObserver = observer
    activeRunLoopSource = AXObserverGetRunLoopSource(observer)
    if let source = activeRunLoopSource {
        CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .defaultMode)
    }

    return SimpleResponse(ok: true, status: "OBSERVER_ACTIVE", details: "Attached to PID \(pid)")
}

func sendPromptToClaude(name: String, text: String, requestId: String?) -> SendTurnResponse {
    guard let app = findAppProcess(name: name) else {
        return SendTurnResponse(ok: false, status: "APP_NOT_RUNNING", requestId: requestId, error: "Application \(name) is not running")
    }

    let pid = app.processIdentifier
    let axApp = AXUIElementCreateApplication(pid)
    _ = AXUIElementSetAttributeValue(axApp, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
    _ = AXUIElementSetAttributeValue(axApp, "AXManualAccessibility" as CFString, kCFBooleanTrue)

    var winVal: AnyObject?
    let err = AXUIElementCopyAttributeValue(axApp, kAXWindowsAttribute as CFString, &winVal)
    guard err == .success, let wins = winVal as? [AXUIElement], let win = wins.first else {
        return SendTurnResponse(ok: false, status: "NO_WINDOW", requestId: requestId, error: "No open window found for \(name)")
    }

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

    func findSendBtn(_ el: AXUIElement) -> AXUIElement? {
        var descVal: AnyObject?
        AXUIElementCopyAttributeValue(el, kAXDescriptionAttribute as CFString, &descVal)
        let desc = (descVal as? String) ?? ""
        if desc == "Send message" { return el }
        var childrenVal: AnyObject?
        if AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &childrenVal) == .success,
           let children = childrenVal as? [AXUIElement] {
            for c in children {
                if let found = findSendBtn(c) { return found }
            }
        }
        return nil
    }

    guard let input = findInput(win) else {
        return SendTurnResponse(ok: false, status: "INPUT_NOT_FOUND", requestId: requestId, error: "Prompt textarea not found")
    }

    let setErr = AXUIElementSetAttributeValue(input, kAXValueAttribute as CFString, text as CFTypeRef)
    guard setErr == .success else {
        return SendTurnResponse(ok: false, status: "VALUE_SET_FAILED", requestId: requestId, error: "AXError \(setErr.rawValue)")
    }

    var sendBtn: AXUIElement? = nil
    for _ in 1...10 {
        usleep(100_000) // 100ms
        if let btn = findSendBtn(win) {
            sendBtn = btn
            break
        }
    }

    guard let btn = sendBtn else {
        return SendTurnResponse(ok: false, status: "SEND_BUTTON_NOT_FOUND", requestId: requestId, error: "Send button did not become available")
    }

    let pressErr = AXUIElementPerformAction(btn, kAXPressAction as CFString)
    guard pressErr == .success else {
        return SendTurnResponse(ok: false, status: "PRESS_FAILED", requestId: requestId, error: "AXError \(pressErr.rawValue)")
    }

    return SendTurnResponse(ok: true, status: "SUBMITTED", requestId: requestId, error: nil)
}

func captureTextSnapshot(name: String) -> [String] {
    guard let app = findAppProcess(name: name) else { return [] }
    let pid = app.processIdentifier
    let axApp = AXUIElementCreateApplication(pid)
    _ = AXUIElementSetAttributeValue(axApp, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
    _ = AXUIElementSetAttributeValue(axApp, "AXManualAccessibility" as CFString, kCFBooleanTrue)

    var winVal: AnyObject?
    guard AXUIElementCopyAttributeValue(axApp, kAXWindowsAttribute as CFString, &winVal) == .success,
          let wins = winVal as? [AXUIElement], let win = wins.first else { return [] }

    var texts: [String] = []
    func collect(_ el: AXUIElement, depth: Int) {
        if depth > 20 { return }
        var roleVal: AnyObject?
        AXUIElementCopyAttributeValue(el, kAXRoleAttribute as CFString, &roleVal)
        let role = (roleVal as? String) ?? ""
        if role == "AXStaticText" || role == "AXHeading" || role == "AXTextArea" || role == "AXTextField" {
            var valueVal: AnyObject?
            if AXUIElementCopyAttributeValue(el, kAXValueAttribute as CFString, &valueVal) == .success,
               let s = valueVal as? String, !s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                texts.append(s)
            }
        }
        var childrenVal: AnyObject?
        if AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &childrenVal) == .success,
           let children = childrenVal as? [AXUIElement] {
            for child in children { collect(child, depth: depth + 1) }
        }
    }
    collect(win, depth: 0)
    return texts
}

func extractLatestClaudeResponse(_ raw: String, requestId: String?) -> String? {
    guard !raw.isEmpty else { return nil }

    var source = raw

    // Correlation is mandatory for live desktop delivery. The accessibility
    // tree contains the submitted user marker followed by Claude's response
    // heading/body. Never fall back to an arbitrary older "Claude responded:"
    // node because that can silently return a stale turn.
    if let requestId {
        let marker = "[AB:\(requestId)]"
        guard let markerRange = source.range(of: marker) else {
            return nil
        }
        source = String(source[markerRange.upperBound...])
    }

    guard let responseRange = source.range(of: "Claude responded:", options: .caseInsensitive) else {
        return nil
    }

    var response = String(source[responseRange.upperBound...])

    // Keep only the response belonging to this assistant turn. Claude exposes
    // subsequent turns as another "You said:" / "Claude responded:" pair.
    let terminators = [
        "\nYou said:",
        "\nClaude responded:",
        "\njust now",
        "\n1 minute ago",
        "\n2 minutes ago",
        "\n3 minutes ago",
        "\n4 minutes ago",
        "\n5 minutes ago",
        "\n10 minutes ago",
        "\n20 minutes ago",
        "\n30 minutes ago",
        "\n1 hour ago",
        "\n2 hours ago",
        "\n3 hours ago",
        "\nYesterday",
        "\nAuto is on."
    ]

    var cut = response.endIndex
    for terminator in terminators {
        if let r = response.range(of: terminator, options: .caseInsensitive), r.lowerBound < cut {
            cut = r.lowerBound
        }
    }

    response = String(response[..<cut])
        .replacingOccurrences(of: "Claude finished the response", with: "")
        .trimmingCharacters(in: .whitespacesAndNewlines)

    let lines = response.components(separatedBy: "\n")
        .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        .filter { !$0.isEmpty }

    if lines.count >= 2 {
        let first = lines[0]
        let second = lines[1]
        let normalize: (String) -> String = { value in
            value.unicodeScalars
                .filter { CharacterSet.alphanumerics.contains($0) }
                .map(String.init)
                .joined()
                .lowercased()
        }

        // Electron may expose both an accessible heading and rendered body.
        if normalize(first) == normalize(second) {
            return second
        }

        let half = lines.count / 2
        if lines.count % 2 == 0 {
            let firstHalf = lines.prefix(half).joined(separator: "\n")
            let secondHalf = lines.suffix(half).joined(separator: "\n")
            if firstHalf == secondHalf {
                return firstHalf
            }
        }
    }

    return lines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
}

func sendAndObserveClaude(name: String, text: String, requestId: String?, timeoutMs: Int) -> ObserveTurnResponse {
    // CRITICAL: establish the response baseline BEFORE pressing Send.
    // This closes the race where a fast Claude response finishes before a
    // separate observeResponse invocation has captured its baseline.
    let baseline = captureTextSnapshot(name: name)
    let sent = sendPromptToClaude(name: name, text: text, requestId: requestId)
    guard sent.ok else {
        return ObserveTurnResponse(
            ok: false,
            status: sent.status,
            requestId: requestId,
            response: nil,
            latencyMs: nil,
            error: sent.error
        )
    }
    return observeResponseFromClaude(
        name: name,
        requestId: requestId,
        timeoutMs: timeoutMs,
        baselineTexts: baseline
    )
}

func observeResponseFromClaude(name: String, requestId: String?, timeoutMs: Int, baselineTexts: [String]? = nil) -> ObserveTurnResponse {
    guard let app = findAppProcess(name: name) else {
        return ObserveTurnResponse(ok: false, status: "APP_NOT_RUNNING", requestId: requestId, response: nil, latencyMs: nil, error: "Application is not running")
    }

    let pid = app.processIdentifier
    let axApp = AXUIElementCreateApplication(pid)
    _ = AXUIElementSetAttributeValue(axApp, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
    _ = AXUIElementSetAttributeValue(axApp, "AXManualAccessibility" as CFString, kCFBooleanTrue)

    var winVal: AnyObject?
    guard AXUIElementCopyAttributeValue(axApp, kAXWindowsAttribute as CFString, &winVal) == .success,
          let wins = winVal as? [AXUIElement], let win = wins.first else {
        return ObserveTurnResponse(ok: false, status: "NO_WINDOW", requestId: requestId, response: nil, latencyMs: nil, error: "No window found")
    }

    let start = Date()
    let maxDuration = Double(timeoutMs > 0 ? timeoutMs : 30000) / 1000.0

    // Collect all text from the AX tree, depth up to 20
    func collectAllText(_ el: AXUIElement, depth: Int, texts: inout [String]) {
        if depth > 60 { return }
        var roleVal: AnyObject?
        AXUIElementCopyAttributeValue(el, kAXRoleAttribute as CFString, &roleVal)
        let role = (roleVal as? String) ?? ""
        if role == "AXStaticText" || role == "AXHeading" || role == "AXTextArea" || role == "AXTextField" {
            var valVal: AnyObject?
            if AXUIElementCopyAttributeValue(el, kAXValueAttribute as CFString, &valVal) == .success,
               let s = valVal as? String, !s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                texts.append(s)
            }
        }
        var childrenVal: AnyObject?
        if AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &childrenVal) == .success,
           let children = childrenVal as? [AXUIElement] {
            for c in children { collectAllText(c, depth: depth + 1, texts: &texts) }
        }
    }

    // Detect generation in progress (stop/cancel button presence)
    func checkGenerating(_ el: AXUIElement) -> Bool {
        var roleVal: AnyObject?
        AXUIElementCopyAttributeValue(el, kAXRoleAttribute as CFString, &roleVal)
        if (roleVal as? String) == "AXButton" {
            var descVal: AnyObject?
            AXUIElementCopyAttributeValue(el, kAXDescriptionAttribute as CFString, &descVal)
            let desc = ((descVal as? String) ?? "").lowercased()
            var titleVal: AnyObject?
            AXUIElementCopyAttributeValue(el, kAXTitleAttribute as CFString, &titleVal)
            let title = ((titleVal as? String) ?? "").lowercased()
            if desc.contains("stop") || title.contains("stop") || desc.contains("cancel") || title.contains("cancel") {
                return true
            }
        }
        var childrenVal: AnyObject?
        if AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &childrenVal) == .success,
           let children = childrenVal as? [AXUIElement] {
            for c in children { if checkGenerating(c) { return true } }
        }
        return false
    }

    // The baseline is still captured before submission to preserve the
    // send/observe ordering guarantee. Correlation itself is now performed
    // against the complete live AX tree so historical nodes cannot shadow the
    // current request.
    if let providedBaseline = baselineTexts {
        _ = providedBaseline
    } else {
        var captured: [String] = []
        collectAllText(win, depth: 0, texts: &captured)
        _ = captured
    }

    var sawGenerating = false
    var lastCorrelatedResponse = ""
    var stableResponseRounds = 0

    while Date().timeIntervalSince(start) < maxDuration {
        usleep(300_000)

        let generating = checkGenerating(win)
        if generating {
            sawGenerating = true
            stableResponseRounds = 0
        }

        var snapshot: [String] = []
        collectAllText(win, depth: 0, texts: &snapshot)

        // IMPORTANT: parse the COMPLETE current AX tree, not only values that
        // differ from the baseline. Claude can reuse/accessibly replace nodes,
        // and Set-based baseline subtraction can discard the exact correlated
        // heading/body needed to identify the current response.
        let rawSnapshot = snapshot.joined(separator: "\n")
        if let extracted = extractLatestClaudeResponse(rawSnapshot, requestId: requestId),
           !extracted.isEmpty {
            if extracted == lastCorrelatedResponse {
                stableResponseRounds += 1
            } else {
                lastCorrelatedResponse = extracted
                stableResponseRounds = 0
            }

            // Require the response to settle. If Claude exposes a stop/cancel
            // control, completion is only accepted after it disappears. If no
            // such control is exposed, two identical observations provide the
            // conservative completion signal.
            if (!generating && (sawGenerating || stableResponseRounds >= 2)) {
                let latency = Date().timeIntervalSince(start) * 1000.0
                return ObserveTurnResponse(
                    ok: true,
                    status: "COMPLETED",
                    requestId: requestId,
                    response: extracted,
                    latencyMs: latency,
                    error: nil
                )
            }
        }
    }

    // Final reconciliation uses the COMPLETE current AX tree. Never return an
    // unrelated historical response merely because it is visible in Claude.
    var finalTexts: [String] = []
    collectAllText(win, depth: 0, texts: &finalTexts)
    let finalRaw = finalTexts.joined(separator: "\n")

    if let extracted = extractLatestClaudeResponse(finalRaw, requestId: requestId),
       !extracted.isEmpty {
        let latency = Date().timeIntervalSince(start) * 1000.0
        return ObserveTurnResponse(
            ok: true,
            status: "COMPLETED_RECONCILED",
            requestId: requestId,
            response: extracted,
            latencyMs: latency,
            error: nil
        )
    }

    if finalRaw.contains(requestId.map { "[AB:\($0)]" } ?? "") {
        return ObserveTurnResponse(
            ok: false,
            status: "RESPONSE_INCOMPLETE",
            requestId: requestId,
            response: nil,
            latencyMs: nil,
            error: "Claude accepted the correlated request but no correlated assistant response was observed"
        )
    }

    return ObserveTurnResponse(
        ok: false,
        status: "CORRELATION_NOT_FOUND",
        requestId: requestId,
        response: nil,
        latencyMs: nil,
        error: "Claude response correlation marker was not found in the live accessibility tree"
    )
}


func handleRequest(_ req: RequestOp) {
    let encoder = JSONEncoder()
    switch req.op {
    case "ping":
        print("{\"ok\":true,\"status\":\"pong\"}")
    case "frontmost":
        let resp = getFrontmostApp()
        if let encoded = try? encoder.encode(resp), let str = String(data: encoded, encoding: .utf8) {
            print(str)
        }
    case "inspect":
        let resp = inspectApp(name: req.targetApp)
        if let encoded = try? encoder.encode(resp), let str = String(data: encoded, encoding: .utf8) {
            print(str)
        }
    case "elements":
        let resp = inspectElements(name: req.targetApp)
        if let encoded = try? encoder.encode(resp), let str = String(data: encoded, encoding: .utf8) {
            print(str)
        }
    case "activate":
        let resp = activateApp(name: req.targetApp)
        if let encoded = try? encoder.encode(resp), let str = String(data: encoded, encoding: .utf8) {
            print(str)
        }
    case "restoreFocus":
        let targetPid = req.pid ?? 0
        let resp = restoreFocusToPid(pid: targetPid)
        if let encoded = try? encoder.encode(resp), let str = String(data: encoded, encoding: .utf8) {
            print(str)
        }
    case "unhide":
        let resp = unhideApp(name: req.targetApp)
        if let encoded = try? encoder.encode(resp), let str = String(data: encoded, encoding: .utf8) {
            print(str)
        }
    case "observe":
        let resp = setupObserver(name: req.targetApp)
        if let encoded = try? encoder.encode(resp), let str = String(data: encoded, encoding: .utf8) {
            print(str)
        }
    case "sendPrompt":
        let resp = sendPromptToClaude(name: req.targetApp, text: req.payloadText, requestId: req.requestId)
        if let encoded = try? encoder.encode(resp), let str = String(data: encoded, encoding: .utf8) {
            print(str)
        }
    case "observeResponse":
        let timeout = req.timeoutMs ?? 30000
        let resp = observeResponseFromClaude(name: req.targetApp, requestId: req.requestId, timeoutMs: timeout)
        if let encoded = try? encoder.encode(resp), let str = String(data: encoded, encoding: .utf8) {
            print(str)
        }
    case "sendAndObserve":
        let timeout = req.timeoutMs ?? 30000
        let resp = sendAndObserveClaude(name: req.targetApp, text: req.payloadText, requestId: req.requestId, timeoutMs: timeout)
        if let encoded = try? encoder.encode(resp), let str = String(data: encoded, encoding: .utf8) {
            print(str)
        }
    default:
        print("{\"ok\":false,\"error\":\"UNKNOWN_OP\"}")
    }
    fflush(stdout)
}

// Support command-line JSON argument or persistent line-by-line stdin
let args = CommandLine.arguments
if args.count > 1 && args[1] != "--daemon" {
    let commandJson = args[1]
    if let data = commandJson.data(using: .utf8),
       let req = try? JSONDecoder().decode(RequestOp.self, from: data) {
        handleRequest(req)
    } else {
        print("{\"ok\":false,\"error\":\"INVALID_JSON\"}")
    }
} else {
    // Daemon or stream mode: continuously process lines from stdin
    while let line = readLine() {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { continue }
        if trimmed == "quit" || trimmed == "exit" { break }
        if let data = trimmed.data(using: .utf8),
           let req = try? JSONDecoder().decode(RequestOp.self, from: data) {
            handleRequest(req)
        } else {
            print("{\"ok\":false,\"error\":\"INVALID_JSON\"}")
            fflush(stdout)
        }
    }
}
