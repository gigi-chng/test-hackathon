"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Megaphone, Zap, Calendar, Twitter, Linkedin, Loader2 } from "lucide-react"
import { generateAnnouncementPosts, postAnnouncementNow, scheduleAnnouncement } from "@/lib/actions/announcement"

type Platform = "both" | "twitter" | "linkedin"

export default function InvestmentAnnouncementsPage() {
  const [pressRelease, setPressRelease] = useState("")
  const [twitter, setTwitter] = useState("")
  const [linkedin, setLinkedin] = useState("")
  const [platform, setPlatform] = useState<Platform>("both")
  const [scheduledAt, setScheduledAt] = useState("")
  const [generating, setGenerating] = useState(false)
  const [posting, setPosting] = useState(false)
  const [scheduling, setScheduling] = useState(false)
  const [result, setResult] = useState<{ twitter: boolean; linkedin: boolean; linkedinError?: string } | null>(null)
  const [scheduled, setScheduled] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleGenerate() {
    if (!pressRelease.trim()) return
    setGenerating(true)
    setError(null)
    setResult(null)
    setScheduled(false)
    try {
      const posts = await generateAnnouncementPosts(pressRelease)
      setTwitter(posts.twitter)
      setLinkedin(posts.linkedin)
    } catch (e) {
      setError(`Generation failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setGenerating(false)
    }
  }

  async function handlePostNow() {
    setPosting(true)
    setError(null)
    setResult(null)
    try {
      const res = await postAnnouncementNow(twitter, linkedin, platform)
      setResult(res)
    } catch (e) {
      setError(`Post failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setPosting(false)
    }
  }

  async function handleSchedule() {
    if (!scheduledAt) return
    setScheduling(true)
    setError(null)
    try {
      await scheduleAnnouncement(twitter, linkedin, platform, new Date(scheduledAt))
      setScheduled(true)
    } catch (e) {
      setError(`Schedule failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setScheduling(false)
    }
  }

  const hasPosts = twitter.length > 0 && linkedin.length > 0
  const twitterChars = twitter.length

  return (
    <div className="min-h-screen p-6 flex flex-col items-center gap-6">
      <div className="w-full max-w-5xl">
        <div className="flex items-center gap-3 mb-1">
          <Megaphone className="h-6 w-6" />
          <h1 className="text-3xl font-bold">Investment Announcements</h1>
        </div>
        <p className="text-muted-foreground mb-8">
          Paste a press release and generate LinkedIn + Twitter posts ready to publish.
        </p>

        {/* Press release input */}
        <Card className="mb-6">
          <CardHeader>
            <CardTitle className="text-base">Press Release</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <Textarea
              placeholder="Paste the full press release here..."
              className="min-h-48 text-sm"
              value={pressRelease}
              onChange={e => setPressRelease(e.target.value)}
            />
            <Button onClick={handleGenerate} disabled={generating || !pressRelease.trim()} className="w-full">
              {generating
                ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Generating posts...</>
                : <><Zap className="mr-2 h-4 w-4" />Generate Posts</>
              }
            </Button>
          </CardContent>
        </Card>

        {/* Generated previews */}
        {hasPosts && (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
              {/* Twitter */}
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base flex items-center justify-between">
                    <span className="flex items-center gap-2">
                      <Twitter className="h-4 w-4" />
                      Twitter / X
                    </span>
                    <Badge variant={twitterChars > 280 ? "destructive" : twitterChars > 260 ? "secondary" : "outline"} className="text-xs">
                      {twitterChars}/280
                    </Badge>
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <Textarea
                    className="min-h-32 text-sm"
                    value={twitter}
                    onChange={e => setTwitter(e.target.value)}
                  />
                </CardContent>
              </Card>

              {/* LinkedIn */}
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Linkedin className="h-4 w-4" />
                    LinkedIn
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <Textarea
                    className="min-h-32 text-sm"
                    value={linkedin}
                    onChange={e => setLinkedin(e.target.value)}
                  />
                </CardContent>
              </Card>
            </div>

            {/* Platform toggle */}
            <Card className="mb-4">
              <CardContent className="pt-4">
                <p className="text-sm font-medium mb-3">Post to</p>
                <div className="flex gap-2">
                  {(["both", "twitter", "linkedin"] as Platform[]).map(p => (
                    <Button
                      key={p}
                      variant={platform === p ? "default" : "outline"}
                      size="sm"
                      onClick={() => setPlatform(p)}
                    >
                      {p === "both" ? "Both" : p === "twitter" ? "Twitter only" : "LinkedIn only"}
                    </Button>
                  ))}
                </div>
              </CardContent>
            </Card>

            {/* Post now / Schedule */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Zap className="h-4 w-4" />
                    Post Now
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <Button
                    className="w-full"
                    onClick={handlePostNow}
                    disabled={posting || twitterChars > 280}
                  >
                    {posting
                      ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Posting...</>
                      : "Post Now"
                    }
                  </Button>
                  {result && (
                    <p className="text-sm mt-3 text-muted-foreground">
                      {platform !== "linkedin" && (result.twitter ? "✓ Twitter posted" : "✗ Twitter failed")}
                      {platform === "both" && " · "}
                      {platform !== "twitter" && (result.linkedin ? "✓ LinkedIn posted" : `✗ LinkedIn failed${result.linkedinError ? `: ${result.linkedinError}` : ""}`)}
                    </p>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Calendar className="h-4 w-4" />
                    Schedule
                  </CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                  <input
                    type="datetime-local"
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring"
                    value={scheduledAt}
                    onChange={e => setScheduledAt(e.target.value)}
                  />
                  <Button
                    variant="outline"
                    className="w-full"
                    onClick={handleSchedule}
                    disabled={scheduling || !scheduledAt || twitterChars > 280}
                  >
                    {scheduling
                      ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Scheduling...</>
                      : <><Calendar className="mr-2 h-4 w-4" />Schedule Post</>
                    }
                  </Button>
                  {scheduled && (
                    <p className="text-sm text-muted-foreground">
                      ✓ Scheduled — you&apos;ll get a Telegram confirmation when it posts.
                    </p>
                  )}
                </CardContent>
              </Card>
            </div>
          </>
        )}

        {error && (
          <p className="text-sm text-destructive mt-4">{error}</p>
        )}
      </div>
    </div>
  )
}
