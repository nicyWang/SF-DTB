import CoreGraphics
import Foundation
let args = CommandLine.arguments
// swift mouse.swift move x y | click x y | rclick x y | drag fx fy tx ty | scroll dy
let type = args.count > 1 ? args[1] : ""
func post(_ event: CGEvent) { event.post(tap: .cghidEventTap) }
func mouseEvent(_ t: CGEventType, _ x: Double, _ y: Double) -> CGEvent {
  CGEvent(mouseEventSource: nil, mouseType: t, mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: .left)!
}
if type == "move", args.count >= 4 {
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
  let dy = Double(args[2])! * -1 // 正=向下
  let e = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: Int32(dy), wheel2: 0, wheel3: 0)!
  post(e)
  print("ok")
} else {
  print("usage: mouse.swift move|click|rclick|dblclick|drag|scroll ...")
}
