export const PARTNERS = {
  sam: {
    displayName: "Sam Lessin",
    twitterHandle: "lessin",
    blogUrl: "https://wlessin.com/posts",
    substackUrl: null,
    linkedinUrl: null, // Sam doesn't have a public LinkedIn
  },
  will: {
    displayName: "Will Quist",
    twitterHandle: "wquist",
    blogUrl: "https://wquist.com",
    substackUrl: null,
    linkedinUrl: "https://www.linkedin.com/in/will-quist-b4b4974/",
  },
  yoni: {
    displayName: "Yoni Rechtman",
    twitterHandle: "yrechtman",
    blogUrl: null,
    substackUrl: "https://99d.substack.com",
    linkedinUrl: "https://www.linkedin.com/in/yrechtman/",
  },
  megan: {
    displayName: "Megan Lightcap",
    twitterHandle: "mmlightcap",
    blogUrl: "https://www.meganlightcap.com",
    substackUrl: null,
    linkedinUrl: "https://www.linkedin.com/in/megan-lightcap-513ab96b/",
  },
} as const

export type Partner = keyof typeof PARTNERS
