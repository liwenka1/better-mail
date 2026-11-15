// Reproducible application artwork, matching resources/brand-mark.svg.
import AppKit
import Foundation

let image = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 1024, pixelsHigh: 1024,
  bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
  colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: image)
func color(_ red: CGFloat, _ green: CGFloat, _ blue: CGFloat) -> NSColor {
  NSColor(srgbRed: red / 255, green: green / 255, blue: blue / 255, alpha: 1)
}
func polygon(_ points: [(CGFloat, CGFloat)], fill: NSColor) {
  let path = NSBezierPath()
  // Artwork coordinates share SVG's downward y axis.
  path.move(to: NSPoint(x: points[0].0, y: 1024 - points[0].1))
  for point in points.dropFirst() {
    path.line(to: NSPoint(x: point.0, y: 1024 - point.1))
  }
  path.close()
  fill.setFill()
  path.fill()
}
let tile = NSBezierPath(roundedRect: NSRect(x: 82, y: 82, width: 860, height: 860),
  xRadius: 190, yRadius: 190)
color(24, 32, 42).setFill()
tile.fill()
color(49, 58, 71).setStroke()
tile.lineWidth = 2
tile.stroke()
polygon([(286, 410), (510, 559), (776, 382), (710, 694), (218, 694)],
  fill: color(243, 106, 169))
polygon([(301, 330), (804, 330), (514, 507)], fill: color(255, 184, 217))
NSGraphicsContext.restoreGraphicsState()
try FileManager.default.createDirectory(atPath: "resources", withIntermediateDirectories: true)
try image.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: "resources/icon.png"))
