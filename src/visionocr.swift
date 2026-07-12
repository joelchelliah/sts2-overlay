// Apple Vision OCR helper. Compiled on first run (see ocr.js).
// Usage: visionocr <image.png>
// Prints JSON: [{"text":"...","x":..,"y":..,"w":..,"h":..}] — pixel coords, top-left origin.
import Foundation
import Vision
import AppKit

guard CommandLine.arguments.count > 1,
      let img = NSImage(contentsOfFile: CommandLine.arguments[1]),
      let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    FileHandle.standardError.write("usage: visionocr <image>\n".data(using: .utf8)!)
    exit(1)
}

let W = CGFloat(cg.width)
let H = CGFloat(cg.height)

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = false

let handler = VNImageRequestHandler(cgImage: cg, options: [:])
try? handler.perform([request])

var out: [[String: Any]] = []
for obs in request.results ?? [] {
    guard let cand = obs.topCandidates(1).first else { continue }
    let b = obs.boundingBox // normalized, bottom-left origin
    out.append([
        "text": cand.string,
        "x": Double(b.minX * W),
        "y": Double((1 - b.maxY) * H),
        "w": Double(b.width * W),
        "h": Double(b.height * H)
    ])
}

let data = try! JSONSerialization.data(withJSONObject: out)
print(String(data: data, encoding: .utf8)!)
