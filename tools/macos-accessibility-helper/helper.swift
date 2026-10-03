import Foundation
import ApplicationServices
import AppKit

// Data structures for JSON communication over stdin/stdout
struct RequestOp: Codable {
    let op: String
    let app: String?
    let bundleId: String?
    let value: String?
    let requestId: String?
}

struct InspectResponse: Codable {
    let ok: Bool
    let app: String
    let running: Bool
    let pid: pid_t?
    let windowCount: Int
    let windows: [String]
    let error: String?
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
        return false
    }
}

func inspectApp(name: String) -> InspectResponse {
    guard let app = findAppProcess(name: name) else {
        return InspectResponse(ok: false, app: name, running: false, pid: nil, windowCount: 0, windows: [], error: "APP_NOT_RUNNING")
    }

    let pid = app.processIdentifier
    let axApp = AXUIElementCreateApplication(pid)

    var windowsValue: AnyObject?
    let result = AXUIElementCopyAttributeValue(axApp, kAXWindowsAttribute as CFString, &windowsValue)

    var windowTitles: [String] = []
    var windowCount = 0

    if result == .success, let windows = windowsValue as? [AXUIElement] {
        windowCount = windows.count
        for win in windows {
            var titleVal: AnyObject?
            if AXUIElementCopyAttributeValue(win, kAXTitleAttribute as CFString, &titleVal) == .success,
               let titleStr = titleVal as? String {
                windowTitles.append(titleStr)
            } else {
                windowTitles.append("Untitled Window")
            }
        }
    }

    return InspectResponse(ok: true, app: name, running: true, pid: pid, windowCount: windowCount, windows: windowTitles, error: nil)
}

func activateApp(name: String) -> SimpleResponse {
    guard let app = findAppProcess(name: name) else {
        return SimpleResponse(ok: false, status: "APP_NOT_RUNNING", details: nil)
    }
    let success = app.activate(options: [.activateIgnoringOtherApps])
    return SimpleResponse(ok: success, status: success ? "ACTIVATED" : "FAILED", details: nil)
}

// Process single JSON command from argument or stdin
let args = CommandLine.arguments
if args.count > 1 {
    let commandJson = args[1]
    if let data = commandJson.data(using: .utf8),
       let req = try? JSONDecoder().decode(RequestOp.self, from: data) {
        handleRequest(req)
    } else {
        print("{\"ok\":false,\"error\":\"INVALID_JSON\"}")
    }
} else {
    // Read from standard input line by line
    while let line = readLine() {
        if let data = line.data(using: .utf8),
           let req = try? JSONDecoder().decode(RequestOp.self, from: data) {
            handleRequest(req)
        } else {
            print("{\"ok\":false,\"error\":\"INVALID_JSON\"}")
        }
    }
}

func handleRequest(_ req: RequestOp) {
    let encoder = JSONEncoder()
    switch req.op {
    case "ping":
        print("{\"ok\":true,\"status\":\"pong\"}")
    case "inspect":
        let resp = inspectApp(name: req.app ?? "Claude")
        if let encoded = try? encoder.encode(resp), let str = String(data: encoded, encoding: .utf8) {
            print(str)
        }
    case "activate":
        let resp = activateApp(name: req.app ?? "Claude")
        if let encoded = try? encoder.encode(resp), let str = String(data: encoded, encoding: .utf8) {
            print(str)
        }
    default:
        print("{\"ok\":false,\"error\":\"UNKNOWN_OP\"}")
    }
}
