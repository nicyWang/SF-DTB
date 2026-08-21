import Foundation
import ApplicationServices
import AppKit

// axtool axclick "按钮名"  → AX树查找按title匹配 → 直接Press（零坐标猜测，光标不动）
// axtool axset "框名" "值" → 找输入框 → AX设值
// axtool axlist "过滤词"  → 列出可交互元素(JSON行)

let args = CommandLine.arguments
guard args.count >= 2 else { print("usage: axtool axclick|axset|axlist ..."); exit(1) }

func focusedApp() -> AXUIElement? {
  // 支持 --pid N 显式指定；否则用真实前台（排除调用者自己——通过 axmostFrontmost 的普通查询）
  let args = CommandLine.arguments
  if let i = args.firstIndex(of: "--pid"), i + 1 < args.count, let pid = Int32(args[i + 1]) {
    return AXUIElementCreateApplication(pid)
  }
  guard let front = NSWorkspace.shared.frontmostApplication else { return nil }
  return AXUIElementCreateApplication(front.processIdentifier)
}

struct El { let title: String; let role: String; let frame: CGRect; let ref: AXUIElement }

func walk(_ el: AXUIElement, _ depth: Int, _ out: inout [El]) {
  if depth > 8 || out.count > 1200 { return }
  var titleAny: CFTypeRef?; var roleAny: CFTypeRef?
  AXUIElementCopyAttributeValue(el, kAXTitleAttribute as CFString, &titleAny)
  AXUIElementCopyAttributeValue(el, kAXRoleAttribute as CFString, &roleAny)
  var descAny: CFTypeRef?; var helpAny: CFTypeRef?; var idAny: CFTypeRef?; var valAny: CFTypeRef?
  AXUIElementCopyAttributeValue(el, kAXDescriptionAttribute as CFString, &descAny)
  AXUIElementCopyAttributeValue(el, kAXHelpAttribute as CFString, &helpAny)
  AXUIElementCopyAttributeValue(el, kAXIdentifierAttribute as CFString, &idAny)
  AXUIElementCopyAttributeValue(el, kAXValueAttribute as CFString, &valAny)
  let title = (titleAny as? String) ?? ""
  let desc = (descAny as? String) ?? ""
  var extra = ""
  if let h = helpAny as? String, !h.isEmpty { extra += "/" + h }
  if let i = idAny as? String, !i.isEmpty { extra += "#" + i }
  if let v = valAny as? String, !v.isEmpty { extra += "=" + String(v.prefix(20)) }
  let role = (roleAny as? String) ?? ""
  var posAny: CFTypeRef?; var sizeAny: CFTypeRef?
  AXUIElementCopyAttributeValue(el, kAXPositionAttribute as CFString, &posAny)
  AXUIElementCopyAttributeValue(el, kAXSizeAttribute as CFString, &sizeAny)
  if let pv = posAny, let sv = sizeAny {
    var pt = CGPoint.zero; var sz = CGSize.zero
    AXValueGetValue(pv as! AXValue, .cgPoint, &pt)
    AXValueGetValue(sv as! AXValue, .cgSize, &sz)
    if sz.width > 1 && sz.height > 1 {
      out.append(El(title: (title + (desc.isEmpty ? "" : "/\(desc)") + extra), role: role, frame: CGRect(origin: pt, size: sz), ref: el))
    }
  }
  var kidsAny: CFTypeRef?
  AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &kidsAny)
  if let kids = kidsAny as? [AXUIElement] { for k in kids { walk(k, depth + 1, &out) } }
}

let cmd = args[1]
if cmd == "axclick" {
  guard args.count >= 3 else { print("err:need text"); exit(1) }
  let needle = args[2].lowercased()
  guard let app = focusedApp() else { print("err:no-app"); exit(1) }
  var els: [El] = []
  var winsAny: CFTypeRef?
  AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &winsAny)
  if let wins = winsAny as? [AXUIElement] { for w in wins { walk(w, 0, &els) } }
  walk(app, 0, &els)
  // 优先精确可交互角色，title 匹配（最短title优先=最精确）
  let interactable = ["AXButton", "AXCheckBox", "AXRadioButton", "AXTab", "AXMenuItem", "AXPopUpButton", "AXToolbarButton", "AXLink", "AXTextField", "AXSearchField", "AXIcon", "AXStaticText", "button", "checkBox", "radioButton", "tab", "menuItem", "popUpButton", "toolbarButton", "icon", "statictext"]
  let hits = els.filter { $0.title.lowercased().contains(needle) && $0.frame.width < 1200 }
    .sorted { a, b in
      let ia = interactable.firstIndex(of: a.role) ?? 99
      let ib = interactable.firstIndex(of: b.role) ?? 99
      if ia != ib { return ia < ib }
      return a.title.count < b.title.count
    }
  guard let hit = hits.first else { print("err:not-found"); exit(2) }
  // 可交互则 Press；不可交互(如statictext)则点它的中心（Aclick语义）
  let pressOk = AXUIElementPerformAction(hit.ref, kAXPressAction as CFString) == .success
  if pressOk { print("ok:press|\(hit.role)|\(hit.title.prefix(30))") }
  else {
    // 兜底：PostToPid 点击中心
    let c = CGPoint(x: hit.frame.midX, y: hit.frame.midY)
    guard let front = NSWorkspace.shared.frontmostApplication else { print("err:no-app"); exit(1) }
    let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: c, mouseButton: .left)!
    let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: c, mouseButton: .left)!
    down.postToPid(front.processIdentifier); usleep(30000); up.postToPid(front.processIdentifier)
    print("ok:pid|\(hit.role)|\(hit.title.prefix(30))")
  }
} else if cmd == "axset" {
  guard args.count >= 4 else { print("err:need name+value"); exit(1) }
  let needle = args[2].lowercased()
  let value = args[3] as CFString
  guard let app = focusedApp() else { print("err:no-app"); exit(1) }
  var els: [El] = []
  var winsAny: CFTypeRef?
  AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &winsAny)
  if let wins = winsAny as? [AXUIElement] { for w in wins { walk(w, 0, &els) } }
  walk(app, 0, &els)
  let fields = els.filter { ["AXTextField", "AXSearchField", "AXTextView", "AXComboBox", "textField", "searchField", "textView", "comboBox"].contains($0.role) }
  let hit = fields.first { $0.title.lowercased().contains(needle) } ?? fields.first
  guard let f = hit else { print("err:no-field"); exit(2) }
  if AXUIElementSetAttributeValue(f.ref, kAXValueAttribute as CFString, value) == .success {
    print("ok:set|\(f.role)")
  } else { print("err:set-failed"); exit(3) }
} else if cmd == "axlist" {
  let filter = args.count >= 3 ? args[2].lowercased() : ""
  guard let app = focusedApp() else { print("err:no-app"); exit(1) }
  var els: [El] = []
  var winsAny: CFTypeRef?
  AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &winsAny)
  if let wins = winsAny as? [AXUIElement] { for w in wins { walk(w, 0, &els) } }
  walk(app, 0, &els)
  let interactable = ["AXButton", "AXCheckBox", "AXRadioButton", "AXTab", "AXMenuItem", "AXPopUpButton", "AXToolbarButton", "AXLink", "AXTextField", "AXSearchField", "AXTextView", "AXComboBox", "button", "checkBox", "radioButton", "tab", "menuItem", "popUpButton", "toolbarButton", "link", "textField", "searchField", "textView"]
  if els.isEmpty { print("err:empty-tree"); exit(4) }
  var printed = 0
  var idx = 0
  for e in els where interactable.contains(e.role) {
    var traits = ""
    var selAny: CFTypeRef?; AXUIElementCopyAttributeValue(e.ref, kAXSelectedAttribute as CFString, &selAny)
    if selAny as? Bool == true { traits += " [selected]" }
    var expAny: CFTypeRef?; AXUIElementCopyAttributeValue(e.ref, kAXExpandedAttribute as CFString, &expAny)
    if expAny as? Bool == true { traits += " [expanded]" }
    var enAny: CFTypeRef?; AXUIElementCopyAttributeValue(e.ref, kAXEnabledAttribute as CFString, &enAny)
    if enAny as? Bool == false { traits += " [disabled]" }
    let line = "[\(idx)] \(e.role) \(e.title.prefix(40))\(traits) @\(Int(e.frame.midX)),\(Int(e.frame.midY))"
    if filter.isEmpty || line.lowercased().contains(filter) { print(line); printed += 1 }
    idx += 1
  }
  if printed == 0 { print("err:no-match|total=\(els.count)") }
} else { print("err:unknown"); exit(1) }
