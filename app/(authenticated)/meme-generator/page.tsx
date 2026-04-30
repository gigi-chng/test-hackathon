"use client"

import { useRef, useState, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { RefreshCw, Download } from "lucide-react"
import { fetchCatImageAsDataUrl } from "@/lib/actions/cat"

export default function MemeGeneratorPage() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [topText, setTopText] = useState("")
  const [bottomText, setBottomText] = useState("")
  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function fetchCatImage() {
    setLoading(true)
    try {
      const dataUrl = await fetchCatImageAsDataUrl()
      setImageUrl(dataUrl)
    } catch {
      alert("Failed to fetch cat image. Try again!")
    } finally {
      setLoading(false)
    }
  }

  // Draw image + text onto canvas whenever inputs change
  useEffect(() => {
    if (!imageUrl) return
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return

    const img = new Image()
    img.src = imageUrl
    img.onload = () => {
      // Size canvas to image (max 600px wide)
      const maxWidth = 600
      const scale = Math.min(1, maxWidth / img.width)
      canvas.width = img.width * scale
      canvas.height = img.height * scale

      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)

      // Meme text style
      const fontSize = Math.max(28, canvas.width / 12)
      ctx.font = `bold ${fontSize}px Impact, Arial`
      ctx.fillStyle = "white"
      ctx.strokeStyle = "black"
      ctx.lineWidth = fontSize / 8
      ctx.textAlign = "center"
      ctx.textBaseline = "top"

      const padding = fontSize * 0.4

      if (topText) {
        ctx.strokeText(topText.toUpperCase(), canvas.width / 2, padding)
        ctx.fillText(topText.toUpperCase(), canvas.width / 2, padding)
      }

      if (bottomText) {
        ctx.textBaseline = "bottom"
        ctx.strokeText(bottomText.toUpperCase(), canvas.width / 2, canvas.height - padding)
        ctx.fillText(bottomText.toUpperCase(), canvas.width / 2, canvas.height - padding)
      }
    }
  }, [imageUrl, topText, bottomText])

  function downloadMeme() {
    const canvas = canvasRef.current
    if (!canvas) return
    const link = document.createElement("a")
    link.download = "cat-meme.png"
    link.href = canvas.toDataURL("image/png")
    link.click()
  }

  return (
    <div className="min-h-screen p-6 flex flex-col items-center gap-6">
      <div className="w-full max-w-2xl">
        <h1 className="text-3xl font-bold mb-1">Cat Meme Generator</h1>
        <p className="text-muted-foreground mb-6">Generate a random cat photo and add your own caption.</p>

        <div className="flex flex-col gap-6">
          {/* Controls */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Customize your meme</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="top">Top text</Label>
                <Input
                  id="top"
                  placeholder="e.g. when you see a laser pointer"
                  value={topText}
                  onChange={(e) => setTopText(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="bottom">Bottom text</Label>
                <Input
                  id="bottom"
                  placeholder="e.g. must. destroy. it."
                  value={bottomText}
                  onChange={(e) => setBottomText(e.target.value)}
                />
              </div>
              <div className="flex gap-3 pt-1">
                <Button onClick={fetchCatImage} disabled={loading} className="flex-1">
                  <RefreshCw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />
                  {loading ? "Loading..." : imageUrl ? "New Cat" : "Get a Cat"}
                </Button>
                {imageUrl && (
                  <Button variant="outline" onClick={downloadMeme}>
                    <Download className="mr-2 h-4 w-4" />
                    Download
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Canvas preview */}
          {imageUrl ? (
            <div className="rounded-lg overflow-hidden border bg-muted flex justify-center">
              <canvas ref={canvasRef} className="max-w-full" />
            </div>
          ) : (
            <div className="rounded-lg border bg-muted h-64 flex items-center justify-center text-muted-foreground text-sm">
              Click "Get a Cat" to start
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
