export default function QuoteCardPreviewPage() {
  const samples = [
    {
      partner: "sam",
      quote: "The market is pricing in what hasn't happened yet. That's not irrational — it's how every major platform transition has worked. The question is whether the underlying business catches up to the multiple before the multiple comes back down to the business.",
      platform: "twitter",
    },
    {
      partner: "will",
      quote: "Most cybersecurity spending right now is buying the illusion of control, not actual control. The architecture hasn't changed but the threat surface has. That gap is where the real risk lives.",
      platform: "twitter",
    },
    {
      partner: "yoni",
      quote: "Consumer behavior doesn't change at the rate AI capabilities are improving. The companies that survive this cycle will be the ones that found real habits, not just impressive demos.",
      platform: "linkedin",
    },
    {
      partner: "megan",
      quote: "The seed math only works under one condition: you believe this company will be worth north of $10 trillion. That's not a forecast, it's a requirement. And right now it's being treated like a given.",
      platform: "twitter",
    },
  ]

  return (
    <div className="min-h-screen p-8 flex flex-col items-center gap-8 bg-background">
      <div className="w-full max-w-4xl">
        <h1 className="text-2xl font-bold mb-1">Quote Card Preview</h1>
        <p className="text-sm text-muted-foreground mb-8">
          These cards will be attached to LinkedIn posts as images, referencing the partner's original thinking.
        </p>

        <div className="flex flex-col gap-10">
          {samples.map((s, i) => (
            <div key={i} className="flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium capitalize">{s.partner}</span>
                <span className="text-xs text-muted-foreground">· via {s.platform}</span>
              </div>
              <div className="rounded-xl overflow-hidden border border-border shadow-sm w-full max-w-sm mx-auto aspect-square">
                <img
                  src={`/api/quote-card?partner=${s.partner}&quote=${encodeURIComponent(s.quote)}&platform=${s.platform}`}
                  alt={`Quote card for ${s.partner}`}
                  className="w-full h-full object-cover"
                />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
