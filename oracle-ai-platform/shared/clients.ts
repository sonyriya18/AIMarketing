// Client branding: each client company has its own name, logos, official websites, sector rules,
// links and context facts. Templates are starting points an administrator applies and can edit.
// Facts were read from the official websites on 2026-11-19 and are context, never campaign results.
import type { ProductId } from "./catalog";

export interface BrandLink {
  label: string;
  url: string;
}
export interface BrandFact {
  id: string;
  text: string;
  source: string;
}
export interface Brand {
  template?: string;
  displayName?: string;
  summary?: string;
  sector?: "liquor_retail" | "general";
  color?: string;
  logos?: { primary?: string; secondary?: string; onDark?: string };
  website?: string;
  links?: BrandLink[];
  /** The client's own Oracle application addresses (tenant login pages). Empty until configured. */
  appLinks?: Partial<Record<ProductId, string>>;
  facts?: BrandFact[];
  guardrails?: string[];
  researchedOn?: string;
  timezone?: string;
  currency?: string;
  /** Name of the client's business account inside Responsys (created once if missing). */
  responsysAccount?: string;
  /** Official website stored on that Responsys account (its business context). */
  responsysWebsite?: string;
}

/** Logos bundled with the platform (served from /brand). Other logos must be HTTPS or data images. */
export const BUNDLED_LOGOS = [
  "/brand/endeavour-group.svg",
  "/brand/endeavour-group-white.svg",
  "/brand/danmurphys-logo.svg",
] as const;

export const CLIENT_TEMPLATES: {
  key: string;
  name: string;
  slug: string;
  brand: Brand;
}[] = [
  {
    key: "endeavour-group",
    name: "Endeavour Group",
    slug: "endeavour-group",
    brand: {
      template: "endeavour-group",
      displayName: "Endeavour Group",
      summary:
        "Endeavour Group is Australia's largest retail drinks network and portfolio of licensed hotels.",
      sector: "liquor_retail",
      color: "#14364a",
      logos: {
        primary: "/brand/endeavour-group.svg",
        onDark: "/brand/endeavour-group-white.svg",
      },
      website: "https://www.endeavourgroup.com.au/",
      links: [
        {
          label: "Endeavour Group website",
          url: "https://www.endeavourgroup.com.au/",
        },
      ],
      appLinks: {},
      // The business account Responsys already knows for this client (its own preset), so
      // Responsys keeps its configured business context.
      responsysAccount: "Endeavour Group - DM",
      responsysWebsite: "https://www.danmurphys.com.au/dm/home",
      facts: [
        {
          id: "W1",
          text: "Endeavour Group describes itself as Australia's largest retail drinks network and portfolio of licensed hotels.",
          source: "https://www.endeavourgroup.com.au/",
        },
        {
          id: "W2",
          text: "Brands listed on the Endeavour Group website include Dan Murphy's, BWS, ALH, Langtons, Pinnacle Drinks, MixIn and endeavourX.",
          source: "https://www.endeavourgroup.com.au/",
        },
        {
          id: "W3",
          text: 'Stated purpose: "to create a more sociable future, together", with a team of about 30,000.',
          source: "https://www.endeavourgroup.com.au/",
        },
        {
          id: "W4",
          text: "Homepage news: Dan Murphy's was awarded Canstar Blue's 2026 Most Satisfied Customers award for Best Liquor Retailer.",
          source: "https://www.endeavourgroup.com.au/",
        },
        {
          id: "W5",
          text: "Homepage news: Endeavour Group and Quantium launched an AI insights engine for the drinks industry.",
          source: "https://www.endeavourgroup.com.au/",
        },
      ],
      guardrails: [
        "Alcohol marketing: target only audiences verified as 18+ and follow the ABAC Responsible Alcohol Marketing Code.",
        "Do not link alcohol to social, sexual or sporting success, and do not encourage excessive drinking.",
      ],
      researchedOn: "2026-11-19",
      timezone: "Australia/Sydney",
      currency: "AUD",
    },
  },
];

/** Official Oracle documentation per product (each address verified to answer on 2026-11-19). */
export const PRODUCT_DOCS: Record<ProductId, BrandLink[]> = {
  responsys: [
    {
      label: "Responsys user guide",
      url: "https://docs.oracle.com/en/cloud/saas/marketing/responsys-user/",
    },
    {
      label: "Responsys developer guide (REST API)",
      url: "https://docs.oracle.com/en/cloud/saas/marketing/responsys-develop/",
    },
  ],
  eloqua: [
    {
      label: "Eloqua user guide",
      url: "https://docs.oracle.com/en/cloud/saas/marketing/eloqua-user/",
    },
    {
      label: "Eloqua developer guide (REST and Bulk API)",
      url: "https://docs.oracle.com/en/cloud/saas/marketing/eloqua-develop/",
    },
  ],
  unity: [
    {
      label: "Unity user guide",
      url: "https://docs.oracle.com/en/cloud/saas/cx-unity/cx-unity-user/",
    },
    {
      label: "Unity developer guide",
      url: "https://docs.oracle.com/en/cloud/saas/cx-unity/cx-unity-develop/",
    },
  ],
  infinity: [
    {
      label: "Infinity user guide",
      url: "https://docs.oracle.com/en/cloud/saas/marketing/infinity-user/",
    },
    {
      label: "Infinity developer guide",
      url: "https://docs.oracle.com/en/cloud/saas/marketing/infinity-develop/",
    },
  ],
};

export const SECTOR_LABEL = {
  liquor_retail: "Liquor retail",
  general: "General business",
} as const;
