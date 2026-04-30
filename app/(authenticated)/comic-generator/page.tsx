"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { generateComicConcepts, generateStripImage, type ComicConcept } from "@/lib/actions/comic"
import { Sparkles, ImageIcon, Download } from "lucide-react"

export default function ComicGeneratorPage() {
  const [newsletter, setNewsletter] = useState("")
  const [concepts, setConcepts] = useState<ComicConcept[]>([])
  const [loadingConcepts, setLoadingConcepts] = useState(false)
  const [loadingImages, setLoadingImages] = useState<boolean[]>([])
  const [error, setError] = useState<string | null>(null)

  async function handleGenerate() {
    if (!newsletter.trim()) return
    setLoadingConcepts(true)
    setError(null)
    setConcepts([])
    setLoadingImages([])

    let result: ComicConcept[]
    try {
      result = await generateComicConcepts(newsletter)
      setConcepts(result)
      setLoadingImages(result.map(() => true))
    } catch (e) {
      setError("Something went wrong. Check your API keys.")
      console.error(e)
      setLoadingConcepts(false)
      return
    }
    setLoadingConcepts(false)

    // Generate one strip image per concept, all in parallel
    result.forEach((concept, i) => {
      generateStripImage(concept)
        .then((url) => {
          setConcepts((prev) => prev.map((c, j) => (j === i ? { ...c, imageUrl: url } : c)))
          setLoadingImages((prev) => prev.map((v, j) => (j === i ? false : v)))
        })
        .catch(() => {
          setLoadingImages((prev) => prev.map((v, j) => (j === i ? false : v)))
        })
    })
  }

  return (
    <div className="min-h-screen p-6 flex flex-col items-center gap-6">
      <div className="w-full max-w-3xl">
        <h1 className="text-3xl font-bold mb-1">Comic Generator</h1>
        <p className="text-muted-foreground mb-6">
          Paste your newsletter and get satirical VC-flavoured comic strips.
        </p>

        <Card className="mb-8">
          <CardContent className="pt-6 flex flex-col gap-4">
            <textarea
              className="min-h-[200px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring resize-y"
              placeholder="Paste your newsletter text here..."
              value={newsletter}
              onChange={(e) => setNewsletter(e.target.value)}
            />
            <Button
              onClick={handleGenerate}
              disabled={loadingConcepts || !newsletter.trim()}
              className="w-full"
            >
              <Sparkles className={`mr-2 h-4 w-4 ${loadingConcepts ? "animate-spin" : ""}`} />
              {loadingConcepts ? "Writing scripts..." : "Generate Comics"}
            </Button>
            {error && <p className="text-sm text-destructive">{error}</p>}
          </CardContent>
        </Card>

        <div className="flex flex-col gap-10">
          {concepts.map((concept, i) => (
            <div key={i} className="flex flex-col gap-3">

              {/* Strip image */}
              {concept.imageUrl ? (
                <img
                  src={concept.imageUrl}
                  alt={concept.caption}
                  className="w-full rounded-lg border"
                />
              ) : loadingImages[i] ? (
                <div className="w-full aspect-[16/9] rounded-lg border bg-muted flex items-center justify-center gap-2 text-sm text-muted-foreground">
                  <ImageIcon className="h-4 w-4 animate-pulse" />
                  Drawing strip {i + 1}...
                </div>
              ) : null}

              {/* Panel dialogue — shown below the image */}
              {concept.panels.length > 0 && (
                <div className="grid grid-cols-3 gap-2">
                  {concept.panels.map((panel, j) => (
                    <div key={j} className="rounded-md border bg-muted/40 p-3 flex flex-col gap-1">
                      <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">Panel {j + 1}</p>
                      <p className="text-xs italic text-muted-foreground leading-snug">{panel.scene}</p>
                      <p className="text-xs font-semibold leading-snug mt-1">"{panel.dialogue}"</p>
                    </div>
                  ))}
                </div>
              )}

              {/* Caption + download */}
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold">— {concept.caption}</p>
                {concept.imageUrl && (
                  <a href={concept.imageUrl} target="_blank" rel="noopener noreferrer">
                    <Button variant="outline" size="sm">
                      <Download className="h-3.5 w-3.5 mr-1.5" />
                      Download
                    </Button>
                  </a>
                )}
              </div>

            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
