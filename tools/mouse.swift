import CoreGraphics
import Foundation
import ApplicationServices

let args = CommandLine.arguments
let type = args.count > 1 ? args[1] : ""
func post(_ event: CGEvent) { event.post(tap: .cghidEventTap) }
func mouseEvent(_ t: CGEventType, _ x: Double, _ y: Double) -> CGEvent {
  CGEvent(mouseEventSource: nil, mouseType: t, mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: .left)!
}
func pidClick(_ x: Double, _ y: Double) {
  // 事件直发前台应用（不经 HID 全局层，光标不动）
  guard let front = NSWorkspace.shared.frontmostApplication else { return }
  let pt = CGPoint(x: x, y: y)
  let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: pt, mouseButton: .left)!
  let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: pt, mouseButton: .left)!
  down.postToPid(front.processIdentifier)
  usleep(30000)
  up.postToPid(front.processIdentifier)
}
import AppKit
func axClick(_ x: Double, _ y: Double) -> Bool {
  // Accessibility 直接按压坐标处元素（零事件、光标零移动）
  let sys = AXUIElementCreateSystemWide()
  var element: AXUIElement?
  guard AXUIElementCopyElementAtPosition(sys, Float(x), Float(y), &element) == .success, let el = element else { return false }
  // macOS 26 SDK 无 CopyActions——直接尝试 Press 动作（不支持该动作的应用返回错误，走兜底）
  return AXUIElementPerformAction(el, kAXPressAction as CFString) == .success
}

if type == "aclick", args.count >= 4 {
  // 静默点击：AX 按压优先 → PostToPid 兜底 → 都失败才动光标
  let x = Double(args[2])!, y = Double(args[3])!
  if axClick(x, y) { print("ok:ax") }
  else { pidClick(x, y); print("ok:pid") }
} else if type == "move", args.count >= 4 {
  post(mouseEvent(.mouseMoved, Double(args[2])!, Double(args[3])!))
  print("ok")
} else if type == "click", args.count >= 4 {
  let x = Double(args[2])!, y = Double(args[3])!
  post(mouseEvent(.mouseMoved, x, y))
  post(mouseEvent(.leftMouseDown, x, y))
  post(mouseEvent(.leftMouseUp, x, y))
  print("ok")
} else if type == "rclick", args.count >= 4 {
  let x = Double(args[2])!, y = Double(args[3])!
  let d = CGEvent(mouseEventSource: nil, mouseType: .rightMouseDown, mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: .right)!
  let u = CGEvent(mouseEventSource: nil, mouseType: .rightMouseUp, mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: .right)!
  post(mouseEvent(.mouseMoved, x, y)); post(d); post(u)
  print("ok")
} else if type == "dblclick", args.count >= 4 {
  let x = Double(args[2])!, y = Double(args[3])!
  post(mouseEvent(.mouseMoved, x, y))
  post(mouseEvent(.leftMouseDown, x, y)); post(mouseEvent(.leftMouseUp, x, y))
  usleep(60000)
  post(mouseEvent(.leftMouseDown, x, y)); post(mouseEvent(.leftMouseUp, x, y))
  print("ok")
} else if type == "drag", args.count >= 6 {
  let fx = Double(args[2])!, fy = Double(args[3])!, tx = Double(args[4])!, ty = Double(args[5])!
  post(mouseEvent(.mouseMoved, fx, fy))
  post(mouseEvent(.leftMouseDown, fx, fy))
  let steps = 20
  for i in 1...steps {
    let x = fx + (tx - fx) * Double(i) / Double(steps)
    let y = fy + (ty - fy) * Double(i) / Double(steps)
    post(mouseEvent(.leftMouseDragged, x, y))
    usleep(15000)
  }
  post(mouseEvent(.leftMouseUp, tx, ty))
  print("ok")
} else if type == "scroll", args.count >= 3 {
  let dy = Double(args[2])! * -1
  let e = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: Int32(dy), wheel2: 0, wheel3: 0)!
  post(e)
  print("ok")
} else {
  print("usage: mouse move|click|aclick|rclick|dblclick|drag|scroll ...")
}
