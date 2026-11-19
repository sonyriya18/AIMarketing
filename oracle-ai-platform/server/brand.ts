// Validation for client branding. Only HTTPS links and bundled, HTTPS or data-image logos are
// accepted; text is length-limited. Branding is display context and never grants access.
import { z } from "zod";
import { BUNDLED_LOGOS, CLIENT_TEMPLATES, type Brand } from "../shared/clients";
import { HttpError } from "./security";

const httpsUrl = z
  .string()
  .trim()
  .max(500)
  .refine((v) => {
    try {
      const u = new URL(v);
      return u.protocol === "https:" && !u.username && !u.password;
    } catch {
      return false;
    }
  }, "Use a full https:// address");
const optionalUrl = z
  .union([httpsUrl, z.literal("").transform(() => undefined)])
  .optional();
const logo = z
  .string()
  .max(300000)
  .refine(
    (v) =>
      (BUNDLED_LOGOS as readonly string[]).includes(v) ||
      /^https:\/\//.test(v) ||
      /^data:image\/(png|jpeg|webp);base64,/.test(v),
    "Use a bundled logo, an HTTPS logo or a PNG/JPEG/WebP data image",
  );
const optionalLogo = z
  .union([logo, z.literal("").transform(() => undefined)])
  .optional();

export const brandSchema = z
  .object({
    template: z.string().max(60).optional(),
    displayName: z.string().trim().max(160).optional(),
    summary: z.string().trim().max(600).optional(),
    sector: z.enum(["liquor_retail", "general"]).optional(),
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/, "Use a colour like #1c4220")
      .optional(),
    logos: z
      .object({
        primary: optionalLogo,
        secondary: optionalLogo,
        onDark: optionalLogo,
      })
      .optional(),
    website: optionalUrl,
    links: z
      .array(
        z.object({ label: z.string().trim().min(1).max(80), url: httpsUrl }),
      )
      .max(10)
      .optional(),
    appLinks: z
      .object({
        responsys: optionalUrl,
        eloqua: optionalUrl,
        unity: optionalUrl,
        infinity: optionalUrl,
      })
      .optional(),
    facts: z
      .array(
        z.object({
          id: z.string().regex(/^W\d{1,2}$/),
          text: z.string().trim().min(1).max(400),
          source: httpsUrl,
        }),
      )
      .max(20)
      .optional(),
    guardrails: z.array(z.string().trim().min(1).max(300)).max(10).optional(),
    researchedOn: z.iso.date().optional(),
    timezone: z.string().max(60).optional(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
  })
  .strict();

export function parseBrand(input: unknown): Brand {
  const r = brandSchema.safeParse(input ?? {});
  if (!r.success)
    throw new HttpError(
      422,
      "Branding: " +
        r.error.issues
          .map((i) => `${i.path.join(".") || "brand"}: ${i.message}`)
          .join("; "),
    );
  return r.data as Brand;
}

export function templateBrand(key: string | undefined): Brand | null {
  if (!key) return null;
  const t = CLIENT_TEMPLATES.find((x) => x.key === key);
  if (!t) throw new HttpError(422, "Unknown client template");
  return structuredClone(t.brand);
}

/**
 * The client's business profile and marketing rules as citable AI documents. They are context
 * from official websites and the administrator, never measured results.
 */
export function clientDocuments(
  name: string | undefined,
  brand: Brand | null | undefined,
): { id: string; title: string; content: string }[] {
  if (!brand || !Object.keys(brand).length) return [];
  const docs: { id: string; title: string; content: string }[] = [];
  const facts = (brand.facts || []).map(
    (f) => `${f.id}: ${f.text} (source: ${f.source})`,
  );
  if (brand.summary || facts.length)
    docs.push({
      id: "client-profile",
      title: `${brand.displayName || name || "Client"}: business profile from official websites${brand.researchedOn ? ` (read ${brand.researchedOn})` : ""}`,
      content: [
        brand.summary || "",
        brand.sector ? `Sector: ${brand.sector.replace("_", " ")}.` : "",
        brand.timezone ? `Timezone: ${brand.timezone}.` : "",
        brand.currency ? `Currency: ${brand.currency}.` : "",
        ...facts,
        "This is business context, not campaign results.",
      ]
        .filter(Boolean)
        .join("\n"),
    });
  if (brand.guardrails?.length)
    docs.push({
      id: "client-rules",
      title: `${brand.displayName || name || "Client"}: marketing rules`,
      content:
        brand.guardrails.map((g) => `- ${g}`).join("\n") +
        "\nEvery recommendation, audience and draft must follow these rules.",
    });
  return docs;
}
