// QWE-HELPER — natywne ręce i oczy agenta na macOS. Uruchamia go Electron (apps/desktop/src/desktop.js), więc zgody
// Nagrywanie ekranu + Dostępność przypinają się do aplikacji simbot, nie do terminala.
// Protokół: stdin/stdout, jedna linia JSON na wiadomość.
//   → {"id":1,"cmd":"observe","args":{...}}      ← {"id":1,"ok":true,"result":{...}}  |  {"id":1,"ok":false,"error":"…"}
// Komendy:
//   permissions                    {screen, accessibility}
//   request {kind:screen|accessibility}   systemowe okno zgody
//   displays                       [{id, frame:{x,y,width,height} (punkty, globalnie, lewy górny róg), scale, main}]
//   frontmost                      {app, bundleId, pid, window, frame, displayId}
//   observe {display?:id|"active", maxSide?, quality?, maxElements?, excludePids?:[pid]}
//                                  frontmost + ekran + zrzut (JPEG base64) + elementy AX aktywnego okna + tekst
//   click {x,y,button?,count?}     x,y = punkty globalne        move {x,y}     drag {x,y,toX,toY}
//   scroll {x?,y?,dx?,dy?}         type {text}                  key {combo:"cmd+shift+n"}
//   press {element}                AXPress (fallback: klik w środek)   setValue {element,value}   focus {element}
//   openApp {name|bundleId}        openURL {url}
// Każde zdarzenie, które helper generuje, ma znacznik w eventSourceUserData — da się odróżnić od ruchów usera.
import AppKit
import ApplicationServices
import Foundation
import ScreenCaptureKit

let SYNTHETIC_MARK: Int64 = 0x51E1
let out = FileHandle.standardOutput
let outLock = NSLock()

func send(_ obj: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: obj, options: []) else { return }
  outLock.lock()
  out.write(data)
  out.write("\n".data(using: .utf8)!)
  outLock.unlock()
}

struct HelperError: Error, CustomStringConvertible {
  let description: String
  init(_ d: String) { description = d }
}

// ───────── ekrany ─────────
func displays() -> [[String: Any]] {
  var count: UInt32 = 0
  CGGetActiveDisplayList(0, nil, &count)
  var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
  CGGetActiveDisplayList(count, &ids, &count)
  return ids.map { id in
    let b = CGDisplayBounds(id)
    let mode = CGDisplayCopyDisplayMode(id)
    let scale = mode.map { Double($0.pixelWidth) / Double(max(1, $0.width)) } ?? 1
    let name = NSScreen.screens.first { ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value == id }?.localizedName ?? "Ekran \(id)"
    return ["id": Int(id), "name": name, "frame": rect(b), "scale": scale, "main": CGDisplayIsMain(id) != 0]
  }
}
func rect(_ r: CGRect) -> [String: Double] { ["x": Double(r.origin.x), "y": Double(r.origin.y), "width": Double(r.width), "height": Double(r.height)] }
func displayContaining(_ p: CGPoint) -> CGDirectDisplayID {
  var id: CGDirectDisplayID = 0
  var n: UInt32 = 0
  CGGetDisplaysWithPoint(p, 1, &id, &n)
  return n > 0 ? id : CGMainDisplayID()
}

// ───────── aplikacja na wierzchu ─────────
// NIE NSWorkspace.frontmostApplication: w procesie bez pętli zdarzeń AppKit ta wartość zamarza na stanie z pierwszego odczytu
// (helper widział „simbot na wierzchu” przez cały task, choć Brave dawno był aktywny). Pytamy na świeżo:
// 1) Dostępność: aplikacja z fokusem  2) serwer okien: właściciel najwyższego zwykłego okna  3) NSWorkspace na końcu.
func frontmostApp() -> NSRunningApplication? {
  let sys = AXUIElementCreateSystemWide()
  if let v = attr(sys, kAXFocusedApplicationAttribute) {
    var pid: pid_t = 0
    if AXUIElementGetPid(v as! AXUIElement, &pid) == .success, pid > 0, let a = NSRunningApplication(processIdentifier: pid) { return a }
  }
  let list = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
  for w in list where (w[kCGWindowLayer as String] as? Int) == 0 {
    if let pid = w[kCGWindowOwnerPID as String] as? Int32, let a = NSRunningApplication(processIdentifier: pid), a.activationPolicy == .regular { return a }
  }
  return NSWorkspace.shared.frontmostApplication
}
func frontmost() -> [String: Any] {
  guard let app = frontmostApp() else { return [:] }
  var res: [String: Any] = ["app": app.localizedName ?? "?", "bundleId": app.bundleIdentifier ?? "", "pid": Int(app.processIdentifier)]
  // bounds okna z listy okien (bez zgody na nagrywanie: bez tytułów, ale z ramką) — do wyboru „aktywnego” ekranu
  let list = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
  if let w = list.first(where: { ($0[kCGWindowOwnerPID as String] as? Int32) == app.processIdentifier && ($0[kCGWindowLayer as String] as? Int) == 0 }),
     let bd = w[kCGWindowBounds as String] as? [String: Any], let r = CGRect(dictionaryRepresentation: bd as CFDictionary) {
    res["frame"] = rect(r)
    res["displayId"] = Int(displayContaining(CGPoint(x: r.midX, y: r.midY)))
    if let n = w[kCGWindowName as String] as? String, !n.isEmpty { res["window"] = n }
  } else {
    res["displayId"] = Int(CGMainDisplayID())
  }
  if res["window"] == nil, let win = focusedWindow(pid: app.processIdentifier), let t = attr(win, kAXTitleAttribute) as? String { res["window"] = t }
  return res
}

// ───────── Accessibility ─────────
var elementCache: [Int: AXUIElement] = [:]

func attr(_ el: AXUIElement, _ name: String) -> AnyObject? {
  var v: AnyObject?
  return AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success ? v : nil
}
func focusedWindow(pid: pid_t) -> AXUIElement? {
  let app = AXUIElementCreateApplication(pid)
  if let w = attr(app, kAXFocusedWindowAttribute) { return (w as! AXUIElement) }
  if let ws = attr(app, kAXWindowsAttribute) as? [AXUIElement], let w = ws.first { return w }
  return nil
}
func frameOf(_ el: AXUIElement) -> CGRect? {
  guard let pv = attr(el, kAXPositionAttribute), let sv = attr(el, kAXSizeAttribute) else { return nil }
  var p = CGPoint.zero, s = CGSize.zero
  AXValueGetValue(pv as! AXValue, .cgPoint, &p)
  AXValueGetValue(sv as! AXValue, .cgSize, &s)
  return CGRect(origin: p, size: s)
}

let INTERACTIVE: Set<String> = ["AXButton", "AXLink", "AXTextField", "AXTextArea", "AXSearchField", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXComboBox", "AXMenuButton", "AXMenuItem", "AXSlider", "AXTab", "AXCell", "AXRow", "AXDisclosureTriangle", "AXIncrementor", "AXSecureTextField", "AXSegmentedControl"]
let ROLE_PL: [String: String] = ["AXButton": "button", "AXLink": "link", "AXTextField": "textbox", "AXTextArea": "textbox", "AXSearchField": "searchbox", "AXSecureTextField": "password", "AXCheckBox": "checkbox", "AXRadioButton": "radio", "AXPopUpButton": "select", "AXComboBox": "combobox", "AXMenuButton": "menubutton", "AXMenuItem": "menuitem", "AXSlider": "slider", "AXTab": "tab", "AXCell": "cell", "AXRow": "row", "AXDisclosureTriangle": "disclosure", "AXIncrementor": "stepper", "AXSegmentedControl": "segmented"]

func observeAX(pid: pid_t, maxElements: Int, display: CGRect) -> (elements: [[String: Any]], text: String, window: String?) {
  elementCache.removeAll()
  guard AXIsProcessTrusted(), let win = focusedWindow(pid: pid) else { return ([], "", nil) }
  var elements: [[String: Any]] = []
  var texts: [String] = []
  var textLen = 0
  var queue: [(AXUIElement, Int)] = [(win, 0)]
  var visited = 0
  while !queue.isEmpty, visited < 4000 {
    let (el, depth) = queue.removeFirst()
    visited += 1
    let role = attr(el, kAXRoleAttribute) as? String ?? ""
    let title = (attr(el, kAXTitleAttribute) as? String) ?? ""
    let desc = (attr(el, kAXDescriptionAttribute) as? String) ?? ""
    let value = attr(el, kAXValueAttribute)
    let valueStr = (value as? String) ?? (value as? NSNumber)?.stringValue ?? ""
    if role == "AXStaticText", !valueStr.isEmpty, textLen < 3000 {
      let t = valueStr.trimmingCharacters(in: .whitespacesAndNewlines)
      if !t.isEmpty { texts.append(t); textLen += t.count }
    }
    if role == "AXHeading", textLen < 3000 { let t = title.isEmpty ? valueStr : title; if !t.isEmpty { texts.append("# " + t); textLen += t.count } }
    if INTERACTIVE.contains(role), elements.count < maxElements, let f = frameOf(el), f.width > 1, f.height > 1 {
      let enabled = (attr(el, kAXEnabledAttribute) as? Bool) ?? true
      var name = !title.isEmpty ? title : !desc.isEmpty ? desc : (attr(el, kAXHelpAttribute) as? String) ?? ""
      if name.isEmpty, let ph = attr(el, kAXPlaceholderValueAttribute as String) as? String { name = ph }
      let id = elements.count + 1
      elementCache[id] = el
      // ramka w ułamkach wybranego ekranu [x, y, w, h] — ten sam format co w przeglądarce
      let fx: Double = Double((f.minX - display.minX) / display.width)
      let fy: Double = Double((f.minY - display.minY) / display.height)
      let fw: Double = Double(f.width / display.width)
      let fh: Double = Double(f.height / display.height)
      let box: [Double] = [fx, fy, fw, fh].map { ($0 * 1000).rounded() / 1000 }
      let roleName: String = ROLE_PL[role] ?? role.replacingOccurrences(of: "AX", with: "").lowercased()
      var e: [String: Any] = [:]
      e["id"] = id
      e["role"] = roleName
      e["name"] = String(name.prefix(80))
      e["inViewport"] = f.intersects(display)
      e["box"] = box
      if role == "AXSecureTextField" { e["value"] = valueStr.isEmpty ? "" : "••••" } else if !valueStr.isEmpty, role != "AXButton" { e["value"] = String(valueStr.prefix(60)) }
      if !enabled { e["disabled"] = true }
      elements.append(e)
    }
    if depth < 40, let kids = attr(el, kAXChildrenAttribute) as? [AXUIElement] { for k in kids { queue.append((k, depth + 1)) } }
  }
  return (elements, texts.joined(separator: "\n"), attr(win, kAXTitleAttribute) as? String)
}
func cached(_ args: [String: Any]) throws -> AXUIElement {
  guard let id = args["element"] as? Int, let el = elementCache[id] else { throw HelperError("brak elementu [\(args["element"] ?? "?")] — zrób observe") }
  return el
}

// ───────── zrzut ekranu (ScreenCaptureKit, macOS 14) ─────────
@available(macOS 14.0, *)
func screenshot(displayId: CGDirectDisplayID, maxSide: Int, quality: Double, excludePids: [Int], excludeWindowIds: [Int] = []) async throws -> [String: Any] {
  let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
  guard let display = content.displays.first(where: { $0.displayID == displayId }) else { throw HelperError("ekranu \(displayId) nie ma") }
  // wycinamy pojedyncze okna (widget simbot), nie całe aplikacje — inaczej zrzut pokazuje coś innego niż to, co jest na wierzchu
  let filter: SCContentFilter
  if !excludePids.isEmpty {
    let skip = content.applications.filter { excludePids.contains(Int($0.processID)) }
    filter = SCContentFilter(display: display, excludingApplications: skip, exceptingWindows: [])
  } else {
    let skipWins = content.windows.filter { excludeWindowIds.contains(Int($0.windowID)) }
    filter = SCContentFilter(display: display, excludingWindows: skipWins)
  }
  let cfg = SCStreamConfiguration()
  let b = CGDisplayBounds(displayId)
  let k = min(1.0, Double(maxSide) / Double(max(b.width, b.height)))
  cfg.width = Int(Double(b.width) * k)
  cfg.height = Int(Double(b.height) * k)
  cfg.showsCursor = true
  let img = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg)
  let rep = NSBitmapImageRep(cgImage: img)
  guard let jpg = rep.representation(using: .jpeg, properties: [.compressionFactor: quality]) else { throw HelperError("jpeg") }
  return ["jpeg": jpg.base64EncodedString(), "width": img.width, "height": img.height]
}

// ───────── aktywacja aplikacji (zweryfikowana) ─────────
func findApp(bundleId: String?, name: String?) -> NSRunningApplication? {
  let apps = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }
  if let b = bundleId, let a = apps.first(where: { $0.bundleIdentifier?.lowercased() == b.lowercased() }) { return a }
  guard let n = name?.lowercased(), !n.isEmpty else { return nil }
  return apps.first(where: { $0.localizedName?.lowercased() == n })
    ?? apps.first(where: { ($0.bundleURL?.deletingPathExtension().lastPathComponent.lowercased() ?? "") == n })
    ?? apps.first(where: { ($0.localizedName?.lowercased() ?? "").contains(n) || n.contains($0.localizedName?.lowercased() ?? "\u{0}") })
}
func isFront(_ app: NSRunningApplication) -> Bool { frontmostApp()?.processIdentifier == app.processIdentifier }
func waitFront(_ app: NSRunningApplication, ms: Int) -> Bool {
  var left = ms
  while left > 0 { if isFront(app) { return true }; usleep(100000); left -= 100 }
  return isFront(app)
}
func activateVerified(bundleId: String?, name: String?) -> [String: Any] {
  var target: NSRunningApplication?
  for _ in 0..<30 { target = findApp(bundleId: bundleId, name: name); if target != nil { break }; usleep(100000) }
  guard let app = target else { usleep(600000); return ["ok": true, "activated": false, "reason": "nie znalazłem uruchomionej aplikacji", "after": frontmost()] }
  var how = "open"
  if !waitFront(app, ms: 700) {
    how = "activate"
    app.unhide()
    app.activate(options: [.activateAllWindows])
    if !waitFront(app, ms: 600) {
      // Dostępność: AXFrontmost + podniesienie głównego okna — działa, gdy zwykła aktywacja jest blokowana
      how = "ax"
      let el = AXUIElementCreateApplication(app.processIdentifier)
      AXUIElementSetAttributeValue(el, kAXFrontmostAttribute as CFString, kCFBooleanTrue)
      if let w = focusedWindow(pid: app.processIdentifier) { AXUIElementPerformAction(w, kAXRaiseAction as CFString) }
      _ = waitFront(app, ms: 900)
    }
  }
  usleep(250000)
  return ["ok": true, "activated": isFront(app), "how": how, "app": app.localizedName ?? "?", "bundleId": app.bundleIdentifier ?? "", "after": frontmost()]
}

// ───────── wejście (mysz, klawiatura) ─────────
func post(_ e: CGEvent?) {
  guard let e else { return }
  e.setIntegerValueField(.eventSourceUserData, value: SYNTHETIC_MARK)
  e.post(tap: .cghidEventTap)
}
func point(_ a: [String: Any], _ kx: String = "x", _ ky: String = "y") throws -> CGPoint {
  guard let x = (a[kx] as? NSNumber)?.doubleValue, let y = (a[ky] as? NSNumber)?.doubleValue else { throw HelperError("brak \(kx)/\(ky)") }
  return CGPoint(x: x, y: y)
}
func moveMouse(to p: CGPoint, steps: Int = 8) {
  let from = CGEvent(source: nil)?.location ?? p
  for i in 1...steps {
    let t = Double(i) / Double(steps)
    post(CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: CGPoint(x: from.x + (p.x - from.x) * t, y: from.y + (p.y - from.y) * t), mouseButton: .left))
    usleep(8000)
  }
}
func click(at p: CGPoint, right: Bool = false, count: Int = 1) {
  moveMouse(to: p)
  usleep(40000)
  let (down, up, btn): (CGEventType, CGEventType, CGMouseButton) = right ? (.rightMouseDown, .rightMouseUp, .right) : (.leftMouseDown, .leftMouseUp, .left)
  for n in 1...max(1, count) {
    let d = CGEvent(mouseEventSource: nil, mouseType: down, mouseCursorPosition: p, mouseButton: btn)
    let u = CGEvent(mouseEventSource: nil, mouseType: up, mouseCursorPosition: p, mouseButton: btn)
    d?.setIntegerValueField(.mouseEventClickState, value: Int64(n))
    u?.setIntegerValueField(.mouseEventClickState, value: Int64(n))
    post(d); usleep(30000); post(u); usleep(40000)
  }
}
func typeText(_ text: String) {
  let units = Array(text.utf16)
  var i = 0
  while i < units.count {
    let chunk = Array(units[i..<min(i + 16, units.count)])
    for down in [true, false] {
      let e = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: down)
      e?.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: chunk)
      post(e)
    }
    usleep(25000)
    i += 16
  }
}
let KEYCODES: [String: CGKeyCode] = [
  "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17,
  "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33,
  "i": 34, "p": 35, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46, ".": 47, "`": 50,
  "enter": 36, "return": 36, "tab": 48, "space": 49, "backspace": 51, "delete": 51, "escape": 53, "esc": 53, "forwarddelete": 117,
  "left": 123, "arrowleft": 123, "right": 124, "arrowright": 124, "down": 125, "arrowdown": 125, "up": 126, "arrowup": 126,
  "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
  "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
]
func key(_ combo: String) throws {
  let parts = combo.lowercased().replacingOccurrences(of: " ", with: "").split(separator: "+").map(String.init)
  var flags: CGEventFlags = []
  var code: CGKeyCode?
  for p in parts {
    switch p {
    case "cmd", "command", "meta", "⌘": flags.insert(.maskCommand)
    case "shift", "⇧": flags.insert(.maskShift)
    case "alt", "option", "opt", "⌥": flags.insert(.maskAlternate)
    case "ctrl", "control", "⌃": flags.insert(.maskControl)
    case "fn": flags.insert(.maskSecondaryFn)
    default: code = KEYCODES[p]; if code == nil { throw HelperError("nieznany klawisz „\(p)”") }
    }
  }
  guard let c = code else { throw HelperError("skrót bez klawisza: \(combo)") }
  let d = CGEvent(keyboardEventSource: nil, virtualKey: c, keyDown: true), u = CGEvent(keyboardEventSource: nil, virtualKey: c, keyDown: false)
  d?.flags = flags; u?.flags = flags
  post(d); usleep(20000); post(u)
}

// ───────── komendy ─────────
func run(_ cmd: String, _ a: [String: Any]) async throws -> Any {
  switch cmd {
  case "ping": return ["pong": true, "pid": Int(getpid())]
  case "permissions": return ["screen": CGPreflightScreenCaptureAccess(), "accessibility": AXIsProcessTrusted()]
  case "request":
    if (a["kind"] as? String) == "accessibility" { return ["accessibility": AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)] }
    return ["screen": CGRequestScreenCaptureAccess()]
  case "displays": return displays()
  case "frontmost": return frontmost()
  case "observe":
    let front = frontmost()
    var did: CGDirectDisplayID = CGMainDisplayID()
    if let d = (a["display"] as? NSNumber)?.uint32Value, displays().contains(where: { ($0["id"] as? Int) == Int(d) }) { did = d } else if let d = front["displayId"] as? Int { did = CGDirectDisplayID(d) }
    let bounds = CGDisplayBounds(did)
    var res: [String: Any] = ["frontmost": front, "display": displays().first { ($0["id"] as? Int) == Int(did) } ?? [:], "permissions": ["screen": CGPreflightScreenCaptureAccess(), "accessibility": AXIsProcessTrusted()]]
    if let pid = front["pid"] as? Int {
      let ax = observeAX(pid: pid_t(pid), maxElements: (a["maxElements"] as? Int) ?? 90, display: bounds)
      res["elements"] = ax.elements
      res["text"] = ax.text
      if let w = ax.window, !w.isEmpty { res["window"] = w }
    }
    if CGPreflightScreenCaptureAccess(), #available(macOS 14.0, *) {
      do { res["screenshot"] = try await screenshot(displayId: did, maxSide: (a["maxSide"] as? Int) ?? 1400, quality: (a["quality"] as? Double) ?? 0.6, excludePids: (a["excludePids"] as? [Int]) ?? [], excludeWindowIds: (a["excludeWindowIds"] as? [Int]) ?? []) }
      catch { res["screenshotError"] = "\(error)" }
    }
    return res
  case "click":
    click(at: try point(a), right: (a["button"] as? String) == "right", count: (a["count"] as? Int) ?? 1)
    return ["ok": true]
  case "move": moveMouse(to: try point(a)); return ["ok": true]
  case "drag":
    let from = try point(a), to = try point(a, "toX", "toY")
    moveMouse(to: from)
    post(CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: from, mouseButton: .left))
    for i in 1...12 { let t = Double(i) / 12; post(CGEvent(mouseEventSource: nil, mouseType: .leftMouseDragged, mouseCursorPosition: CGPoint(x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t), mouseButton: .left)); usleep(15000) }
    post(CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: to, mouseButton: .left))
    return ["ok": true]
  case "scroll":
    if let p = try? point(a) { moveMouse(to: p, steps: 3) }
    let dy = Int32((a["dy"] as? NSNumber)?.intValue ?? 0), dx = Int32((a["dx"] as? NSNumber)?.intValue ?? 0)
    post(CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0))
    return ["ok": true]
  case "type": typeText((a["text"] as? String) ?? ""); return ["ok": true]
  case "key": try key((a["combo"] as? String) ?? ""); return ["ok": true]
  case "press":
    let el = try cached(a)
    if AXUIElementPerformAction(el, kAXPressAction as CFString) == .success { return ["ok": true, "via": "ax"] }
    guard let f = frameOf(el) else { throw HelperError("element bez ramki") }
    click(at: CGPoint(x: f.midX, y: f.midY))
    return ["ok": true, "via": "click"]
  case "focus":
    let el = try cached(a)
    AXUIElementSetAttributeValue(el, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    if let f = frameOf(el) { click(at: CGPoint(x: f.midX, y: f.midY)) }
    return ["ok": true]
  case "setValue":
    let el = try cached(a)
    let r = AXUIElementSetAttributeValue(el, kAXValueAttribute as CFString, ((a["value"] as? String) ?? "") as CFString)
    if r != .success { throw HelperError("nie da się ustawić wartości (AX \(r.rawValue))") }
    return ["ok": true]
  case "openApp", "openURL":
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    if cmd == "openURL" { p.arguments = [(a["url"] as? String) ?? ""] } else if let b = a["bundleId"] as? String { p.arguments = ["-b", b] } else { p.arguments = ["-a", (a["name"] as? String) ?? ""] }
    let err = Pipe()
    p.standardError = err
    try p.run()
    p.waitUntilExit()
    if p.terminationStatus != 0 { throw HelperError(String(data: err.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "open: \(p.terminationStatus)") }
    if cmd == "openURL" { usleep(600000); return ["ok": true] }
    // `open -a` uruchamia, ale od macOS 14 (kooperacyjna aktywacja) nie zawsze wyciąga na wierzch — sprawdzamy i dopychamy przez AX
    return activateVerified(bundleId: a["bundleId"] as? String, name: a["name"] as? String)
  default: throw HelperError("nieznana komenda: \(cmd)")
  }
}

// ───────── pętla ─────────
// Komendy wykonujemy po kolei (jedna kolejka): akcje muszą iść w kolejności, a cache elementów AX jest współdzielony.
let queue = DispatchQueue(label: "qwe.helper")
let gate = DispatchSemaphore(value: 1)
DispatchQueue.global().async {
  while let line = readLine() {
    guard let data = line.data(using: .utf8), let msg = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
    let id = msg["id"] ?? NSNull()
    let cmd = msg["cmd"] as? String ?? ""
    let args = msg["args"] as? [String: Any] ?? [:]
    gate.wait()
    Task {
      defer { gate.signal() }
      do { send(["id": id, "ok": true, "result": try await run(cmd, args)]) } catch { send(["id": id, "ok": false, "error": "\(error)"]) }
    }
  }
  exit(0)
}
send(["event": "ready", "pid": Int(getpid())])
// pętla zdarzeń zamiast samego dispatchMain — powiadomienia NSWorkspace (aktywacje aplikacji) docierają do procesu
RunLoop.main.run()
