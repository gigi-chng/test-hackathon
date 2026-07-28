// blogType picks the scraper used in lib/actions/ingest.ts:
//   beehiiv  — sitemap.xml lists /p/<slug> posts, body lives in #content-blocks
//   substack — archive API lists posts, body lives in .available-content
//   wlessin  — members-only, needs WLESSIN_COOKIE to read anything
//   generic  — fall back to scraping every link on the index page
export const PARTNERS = {
  sam: {
    displayName: "Sam Lessin",
    twitterHandle: "lessin",
    blogUrl: "https://wlessin.com/posts",
    blogType: "wlessin",
    substackUrl: null,
    linkedinUrl: null, // Sam doesn't have a public LinkedIn
  },
  will: {
    displayName: "Will Quist",
    twitterHandle: "wquist",
    blogUrl: "https://wquist.com",
    blogType: "beehiiv",
    substackUrl: null,
    linkedinUrl: "https://www.linkedin.com/in/will-quist-b4b4974/",
  },
  yoni: {
    displayName: "Yoni Rechtman",
    twitterHandle: "yrechtman",
    blogUrl: null,
    blogType: "substack",
    substackUrl: "https://99d.substack.com",
    linkedinUrl: "https://www.linkedin.com/in/yrechtman/",
  },
  megan: {
    displayName: "Megan Lightcap",
    twitterHandle: "mmlightcap",
    blogUrl: "https://www.meganlightcap.com",
    blogType: "beehiiv",
    substackUrl: null,
    linkedinUrl: "https://www.linkedin.com/in/megan-lightcap-513ab96b/",
  },
} as const

export type Partner = keyof typeof PARTNERS
