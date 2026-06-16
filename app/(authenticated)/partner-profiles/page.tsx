import { getPartnerProfiles } from "@/lib/actions/partner-profiles"
import { generatePartnerProfiles } from "@/lib/actions/partner-profiles"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { revalidatePath } from "next/cache"

const PARTNER_COLORS: Record<string, string> = {
  sam:   "bg-violet-500/15 text-violet-400 border-violet-500/25",
  will:  "bg-sky-500/15 text-sky-400 border-sky-500/25",
  yoni:  "bg-emerald-500/15 text-emerald-400 border-emerald-500/25",
  megan: "bg-rose-500/15 text-rose-400 border-rose-500/25",
}

const PARTNER_NAMES: Record<string, string> = {
  sam: "Sam Lessin", will: "Will Quist", yoni: "Yoni Rechtman", megan: "Megan Lightcap",
}

function formatDate(d: Date | null) {
  if (!d) return "Never"
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" })
}

async function handleRegenerate() {
  "use server"
  await generatePartnerProfiles()
  revalidatePath("/partner-profiles")
}

export default async function PartnerProfilesPage() {
  const profiles = await getPartnerProfiles()

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-5xl mx-auto px-5 py-8">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-xl font-bold tracking-tight">Partner Profiles</h1>
            <p className="text-xs text-muted-foreground mt-1">
              Tone of voice &amp; POV profiles · auto-regenerates every Friday at 5am PST
            </p>
          </div>
          <form action={handleRegenerate}>
            <Button size="sm" variant="outline" type="submit">
              Regenerate now
            </Button>
          </form>
        </div>

        {profiles.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border/40 p-16 text-center">
            <p className="text-sm text-muted-foreground/50">No profiles yet.</p>
            <p className="text-xs text-muted-foreground/30 mt-1">Click "Regenerate now" to generate profiles from the content library.</p>
          </div>
        ) : (
          <div className="space-y-6">
            {profiles.map(profile => {
              const color = PARTNER_COLORS[profile.partner] ?? "bg-muted text-muted-foreground border-border"
              const name = PARTNER_NAMES[profile.partner] ?? profile.partner

              return (
                <div key={profile.partner} className="rounded-xl border border-border/60 bg-card overflow-hidden">
                  <div className="px-5 py-4 border-b border-border/40 flex items-center justify-between">
                    <span className={`text-xs px-2.5 py-1 rounded-full border font-semibold ${color}`}>{name}</span>
                    <span className="text-[10px] text-muted-foreground/50">Last generated: {formatDate(profile.generatedAt)}</span>
                  </div>
                  <div className="p-5 space-y-4">
                    <div>
                      <p className="text-[10px] uppercase tracking-widest text-muted-foreground/50 mb-1">Tone of Voice</p>
                      <p className="text-sm leading-relaxed">{profile.toneOfVoice || <span className="text-muted-foreground/40 italic">Not yet generated</span>}</p>
                    </div>
                    <div>
                      <p className="text-[10px] uppercase tracking-widest text-muted-foreground/50 mb-1">Point of View</p>
                      <p className="text-sm leading-relaxed">{profile.pointOfView || <span className="text-muted-foreground/40 italic">Not yet generated</span>}</p>
                    </div>
                    {profile.themes.length > 0 && (
                      <div>
                        <p className="text-[10px] uppercase tracking-widest text-muted-foreground/50 mb-2">Key Themes</p>
                        <div className="flex flex-wrap gap-1.5">
                          {profile.themes.map(theme => (
                            <Badge key={theme} variant="secondary" className="text-[11px]">{theme}</Badge>
                          ))}
                        </div>
                      </div>
                    )}
                    <div>
                      <p className="text-[10px] uppercase tracking-widest text-muted-foreground/50 mb-1">Style Notes</p>
                      <p className="text-sm leading-relaxed">{profile.styleNotes || <span className="text-muted-foreground/40 italic">Not yet generated</span>}</p>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
