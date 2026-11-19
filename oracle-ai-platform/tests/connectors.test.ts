// Provider-contract tests with SIMULATED provider responses (test fixtures, not live evidence).
import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("../server/http", () => ({ secureRequest: vi.fn() }));
import { secureRequest } from "../server/http";
import {
  ConnectionSchema,
  readSource,
  PendingExport,
  authorization,
  request,
  ProviderError,
} from "../server/connectors";
import { readEloqua } from "../server/eloqua-connector";
import { decodeEvents } from "../server/streams";
import {
  askAI,
  validateAnswer,
  draftWithAI,
  briefingWithAI,
  routeWithAI,
} from "../server/ai";
import { assess } from "../server/modules";

const http = vi.mocked(secureRequest);
const cfg = {
  allowedHosts: [
    "tenant.example",
    "login.eloqua.com",
    "secure.p99.eloqua.example",
  ],
  encryptionKey: Buffer.alloc(32),
  aiTimeout: 30000,
} as any;
const response = (
  value: any,
  status = 200,
  headers: Record<string, string> = {},
) => ({
  response: new Response(null, { status, headers }),
  text: typeof value === "string" ? value : JSON.stringify(value),
});
beforeEach(() => http.mockReset());

describe("Generic REST adapter (Unity tenant-documented resources)", () => {
  const config = () =>
    ConnectionSchema.parse({
      baseUrl: "https://tenant.example",
      auth: "bearer",
      resources: [
        {
          type: "job",
          path: "/tenant/jobs",
          itemsPath: "items",
          mapping: {
            id: "runId",
            name: "name",
            jobType: "type",
            status: "state",
          },
          pagination: "offset",
          pageSize: 2,
        },
      ],
      providerContractConfirmed: true,
    });
  it("follows complete pagination and maps fields without inventing rows", async () => {
    http
      .mockResolvedValueOnce(
        response({
          items: [
            { runId: "1", name: "Ingest", type: "ingest", state: "succeeded" },
            {
              runId: "2",
              name: "IR",
              type: "identity_resolution",
              state: "failed",
            },
          ],
          hasMore: true,
        }),
      )
      .mockResolvedValueOnce(
        response({
          items: [
            {
              runId: "3",
              name: "C360",
              type: "customer360",
              state: "succeeded",
            },
          ],
          hasMore: false,
        }),
      );
    const r = await readSource("unity", config(), { accessToken: "t" }, cfg);
    expect(r.records.map((x) => x.id)).toEqual(["1", "2", "3"]);
    expect(http.mock.calls[1][0]).toContain("offset=2");
  });
  it("rejects ambiguous completion, empty 'more' pages and cross-origin pagination", async () => {
    http.mockResolvedValueOnce(
      response({
        items: [
          { runId: "1", type: "ingest", state: "ok" },
          { runId: "2", type: "ingest", state: "ok" },
        ],
      }),
    );
    await expect(
      readSource("unity", config(), { accessToken: "t" }, cfg),
    ).rejects.toThrow("ambiguous");
    http.mockResolvedValueOnce(response({ items: [], hasMore: true }));
    await expect(
      readSource("unity", config(), { accessToken: "t" }, cfg),
    ).rejects.toThrow("empty page");
    const next = ConnectionSchema.parse({
      ...config(),
      resources: [
        { ...config().resources[0], pagination: "next", nextPath: "next" },
      ],
    });
    http.mockResolvedValueOnce(
      response({ items: [], next: "https://attacker.example/page2" }),
    );
    await expect(
      readSource("unity", next, { accessToken: "t" }, cfg),
    ).rejects.toThrow("origin");
    expect(http).toHaveBeenCalledTimes(3);
  });
  it("requires a confirmed provider contract", async () => {
    await expect(
      readSource(
        "unity",
        { ...config(), providerContractConfirmed: false },
        {},
        cfg,
      ),
    ).rejects.toThrow("Confirm");
    expect(http).not.toHaveBeenCalled();
  });
  it("renews tokens with the refresh grant and never invents a client-credentials grant", async () => {
    const c = {
      ...config(),
      auth: "oauth" as const,
      tokenUrl: "https://tenant.example/token",
    };
    http.mockResolvedValueOnce(
      response({ access_token: "new", refresh_token: "r2", expires_in: 3600 }),
    );
    const save = vi.fn();
    await authorization(
      c,
      {
        clientId: "id",
        clientSecret: "s",
        refreshToken: "old",
        expiresAt: "0",
      },
      cfg,
      save,
    );
    expect(String(http.mock.calls[0][2]?.body)).toContain(
      "grant_type=refresh_token",
    );
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: "new", refreshToken: "r2" }),
    );
    await expect(
      authorization(c, { clientId: "id", clientSecret: "s" }, cfg),
    ).rejects.toThrow("Authorize");
  });
  it.each([401, 403, 404, 429, 503])(
    "classifies provider HTTP %i without exposing the body",
    async (status) => {
      http.mockResolvedValueOnce({
        response: new Response(null, {
          status,
          headers: { "retry-after": "5" },
        }),
        text: "private token body",
      });
      const e = await request("https://tenant.example", cfg).catch((x) => x);
      expect(e).toBeInstanceOf(ProviderError);
      expect(e.message).not.toContain("private token body");
      expect(e.retryable).toBe(status === 429 || status === 503);
      if (status === 429) expect(e.retryAfter).toBe(5);
    },
  );
});

describe("Eloqua Bulk activity export lifecycle", () => {
  const conf = (extra: Record<string, unknown> = {}) =>
    ConnectionSchema.parse({
      baseUrl: "https://login.eloqua.com",
      auth: "eloqua-basic",
      transport: "eloqua-bulk",
      activityTypes: ["EmailSend"],
      backfillDays: 7,
      timestampOffset: "+00:00",
      providerContractConfirmed: true,
      ...extra,
    });
  const secrets = {
    siteName: "Company",
    username: "api.user",
    password: "test-only",
  };
  const id = () =>
    response({
      site: { name: "Company" },
      user: { username: "api.user" },
      urls: { base: "https://secure.p99.eloqua.example" },
    });
  const campaigns = () =>
    response({
      elements: [
        {
          id: "101",
          name: "Synthetic",
          currentStatus: "Completed",
          startAt: "1759276800",
        },
      ],
      page: 1,
      pageSize: 1000,
      total: 1,
    });
  it("defines, syncs, pages, de-duplicates and cleans up only its own export", async () => {
    http
      .mockResolvedValueOnce(id())
      .mockResolvedValueOnce(response({ uri: "/activities/exports/77" }))
      .mockResolvedValueOnce(response({ uri: "/syncs/88", status: "pending" }))
      .mockResolvedValueOnce(response({ status: "success" }))
      .mockResolvedValueOnce(
        response({
          items: [
            {
              id: "1",
              activityDate: "2026-10-01 10:00:00.000",
              contactId: "K1",
              campaignId: "101",
            },
            {
              id: "1",
              activityDate: "2026-10-01 10:00:00.000",
              contactId: "K1",
              campaignId: "101",
            },
          ],
          hasMore: true,
          offset: 0,
        }),
      )
      .mockResolvedValueOnce(
        response({
          items: [
            {
              id: "2",
              activityDate: "2026-10-01 11:00:00.000",
              contactId: "K2",
              campaignId: "101",
            },
          ],
          hasMore: false,
        }),
      )
      .mockResolvedValueOnce(campaigns())
      .mockResolvedValueOnce(response("", 204));
    const r = await readEloqua(conf(), secrets, cfg, { sleep: async () => {} });
    const urls = http.mock.calls.map((c) => `${c[2]?.method || "GET"} ${c[0]}`);
    expect(urls[0]).toBe("GET https://login.eloqua.com/id");
    expect(urls[1]).toBe(
      "POST https://secure.p99.eloqua.example/api/bulk/2.0/activities/exports",
    );
    expect(JSON.parse(String(http.mock.calls[1][2]?.body)).filter).toContain(
      "'{{Activity.Type}}'='EmailSend'",
    );
    expect(urls[2]).toContain("/api/bulk/2.0/syncs");
    expect(urls[4]).toContain("/syncs/88/data?offset=0&limit=50000");
    expect(urls[5]).toContain("offset=2");
    expect(urls.at(-1)).toBe(
      "DELETE https://secure.p99.eloqua.example/api/bulk/2.0/activities/exports/77",
    );
    expect(
      String(
        http.mock.calls[0][2]?.headers &&
          (http.mock.calls[0][2]!.headers as any).Authorization,
      ),
    ).toBe(
      "Basic " + Buffer.from("Company\\api.user:test-only").toString("base64"),
    );
    expect(r.records.filter((x) => x.type === "activity")).toHaveLength(2);
    expect(r.records.find((x) => x.type === "activity")!.activityDate).toBe(
      "2026-10-01T10:00:00+00:00",
    );
    expect(r.metadata).toMatchObject({
      completeness: "complete",
      cleanedResources: ["/activities/exports/77"],
    });
  });
  it("hands back a checkpoint while pending and resumes without creating a second export", async () => {
    http
      .mockResolvedValueOnce(id())
      .mockResolvedValueOnce(response({ uri: "/activities/exports/77" }))
      .mockResolvedValueOnce(response({ uri: "/syncs/88", status: "pending" }))
      .mockResolvedValueOnce(response({ status: "active" }));
    const saved: any[] = [];
    const e = await readEloqua(conf(), secrets, cfg, {
      sleep: async () => {},
      pollBudgetMs: -1,
      saveCheckpoint: async (cp) => void saved.push(cp),
    }).catch((x) => x);
    expect(e).toBeInstanceOf(PendingExport);
    expect(saved.length).toBeGreaterThan(0);
    http.mockReset();
    http
      .mockResolvedValueOnce(id())
      .mockResolvedValueOnce(response({ status: "success" }))
      .mockResolvedValueOnce(response({ items: [], hasMore: false }))
      .mockResolvedValueOnce(campaigns())
      .mockResolvedValueOnce(response("", 204));
    const r = await readEloqua(conf(), secrets, cfg, {
      checkpoint: e.checkpoint,
      sleep: async () => {},
    });
    expect(http.mock.calls.some((c) => c[2]?.method === "POST")).toBe(false);
    expect(r.records.filter((x) => x.type === "activity")).toHaveLength(0);
  });
  it("refuses incomplete pages, unapproved discovered hosts and unknown timestamp offsets", async () => {
    http.mockResolvedValueOnce(
      response({
        site: {},
        urls: { base: "https://unapproved.eloqua.example" },
      }),
    );
    await expect(readEloqua(conf(), secrets, cfg)).rejects.toThrow(
      "OUTBOUND_HOSTS",
    );
    http.mockReset();
    http
      .mockResolvedValueOnce(id())
      .mockResolvedValueOnce(response({ uri: "/activities/exports/1" }))
      .mockResolvedValueOnce(response({ uri: "/syncs/2", status: "success" }))
      .mockResolvedValueOnce(response({ items: [{ id: "1" }] }));
    await expect(readEloqua(conf(), secrets, cfg)).rejects.toThrow("hasMore");
    http.mockReset();
    http
      .mockResolvedValueOnce(id())
      .mockResolvedValueOnce(response({ uri: "/activities/exports/1" }))
      .mockResolvedValueOnce(response({ uri: "/syncs/2", status: "success" }))
      .mockResolvedValueOnce(
        response({
          items: [{ id: "1", activityDate: "2026-10-01 10:00:00" }],
          hasMore: false,
        }),
      )
      .mockResolvedValueOnce(campaigns());
    await expect(
      readEloqua(conf({ timestampOffset: "" }), secrets, cfg),
    ).rejects.toThrow("timestamp offset");
  });
  it("surfaces sync errors and authentication failures as provider errors", async () => {
    http
      .mockResolvedValueOnce(id())
      .mockResolvedValueOnce(response({ uri: "/activities/exports/1" }))
      .mockResolvedValueOnce(response({ uri: "/syncs/2", status: "error" }));
    await expect(readEloqua(conf(), secrets, cfg)).rejects.toThrow(
      "sync for EmailSend failed",
    );
    http.mockReset();
    http.mockResolvedValueOnce(response("Not authenticated.", 401));
    await expect(readEloqua(conf(), secrets, cfg)).rejects.toThrow(
      "credentials",
    );
    await expect(
      readEloqua(conf(), { siteName: "", username: "u", password: "p" }, cfg),
    ).rejects.toThrow("company");
  });
});

describe("Infinity export and stream contracts", () => {
  it("prepares an export once and then polls without restarting it (no repeated refresh)", async () => {
    const c = ConnectionSchema.parse({
      baseUrl: "https://tenant.example",
      auth: "bearer",
      transport: "infinity-export",
      exportUrl: "https://tenant.example/generated/report?reportId=test",
      resources: [
        {
          type: "report_row",
          path: "/unused",
          itemsPath: "data",
          mapping: { id: "row", reportId: "report", sessions: "visits" },
        },
      ],
      providerContractConfirmed: true,
    });
    http.mockResolvedValueOnce(response({ status: "processing" }, 202));
    const e = await readSource("infinity", c, { accessToken: "t" }, cfg).catch(
      (x) => x,
    );
    expect(e).toBeInstanceOf(PendingExport);
    expect(new URL(http.mock.calls[0][0]).searchParams.get("refresh")).toBe(
      "true",
    );
    http
      .mockResolvedValueOnce(response({ status: "processing" }, 202))
      .mockResolvedValueOnce(
        response({ data: [{ row: "1", report: "R", visits: 20 }] }),
      );
    const e2 = await readSource("infinity", c, { accessToken: "t" }, cfg, {
      checkpoint: e.checkpoint,
    }).catch((x) => x);
    const r = await readSource("infinity", c, { accessToken: "t" }, cfg, {
      checkpoint: e2.checkpoint,
    });
    expect(
      http.mock.calls
        .slice(1)
        .every((call) => !new URL(call[0]).searchParams.has("refresh")),
    ).toBe(true);
    expect(r.records[0].sessions).toBe("20");
  });
  it("validates stream frames, keeps receipt time separate and refuses frames without identity", () => {
    const c = ConnectionSchema.parse({
      baseUrl: "https://tenant.example",
      auth: "bearer",
      providerContractConfirmed: true,
      streamItemsPath: "events",
      streamMapping: {
        id: "key",
        sessionId: "session",
        timestamp: "at",
        event: "name",
      },
    });
    const [e] = decodeEvents(
      {
        events: [
          {
            key: "one",
            session: "s",
            at: "2026-10-28T00:00:00Z",
            name: "purchase",
          },
        ],
      },
      c,
    );
    expect(e.id).toBe("one");
    expect(e.timestamp).toBe("2026-10-28T00:00:00Z");
    expect(e.receivedAt).not.toBe(e.timestamp);
    expect(() => decodeEvents({ events: [{ name: "purchase" }] }, c)).toThrow(
      "mapping",
    );
  });
});

describe("AI provider contract (simulated responses are labeled fixtures)", () => {
  const report = assess(
    {
      id: "s",
      app: "infinity",
      name: "Synthetic",
      timezone: "UTC",
      currency: "USD",
      visibility: "workspace",
      policy: { conversionEvent: "buy" },
    },
    [
      {
        type: "event",
        id: "1",
        event: "buy",
        timestamp: "2026-10-01T10:00:00Z",
        sessionId: "S1",
        page: "/offer?email=private.person@example.test&phone=+61400123456#ref",
      },
    ],
    { datasetId: "d", mode: "upload", asOf: "2026-10-28T00:00:00Z" },
  );
  const gemini = {
    ...cfg,
    aiProvider: "gemini",
    aiKey: "test-key",
    aiModel: "configured-model",
  };
  const ok = (statements: any) =>
    response({
      candidates: [
        {
          content: { parts: [{ text: JSON.stringify({ statements }) }] },
          finishReason: "STOP",
        },
      ],
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 5,
        totalTokenCount: 15,
      },
    });
  const good = [
    {
      kind: "observation",
      text: "Sessions are measured from events.",
      metricIds: ["event_sessions"],
      findingIds: [],
      documentIds: [],
      toolIds: [],
    },
  ];
  it("accepts structured output with valid citations and records usage, without sending raw records", async () => {
    http.mockResolvedValueOnce(ok(good));
    const r = await askAI(gemini, report, "Explain", []);
    expect(r).toMatchObject({
      generator: "ai",
      model: "configured-model",
      usage: { input: 10, output: 5 },
    });
    // Aggregated page labels are sent; personal data inside a label is not.
    const sent = String(http.mock.calls[0][2]?.body);
    expect(sent).toContain("/offer");
    expect(sent).not.toContain("private.person@example.test");
    expect(sent).not.toContain("61400123456");
    expect(sent).not.toContain("#ref");
    expect((http.mock.calls[0][2]?.headers as any)["x-goog-api-key"]).toBe(
      "test-key",
    );
  });
  it("falls back, labeled, on missing key, timeout, invalid schema, fabricated references or provider failure", async () => {
    expect(
      (await askAI({ ...cfg, aiProvider: "none" }, report, "Why?", []))
        .generator,
    ).toBe("rule_based");
    http.mockRejectedValueOnce(new Error("timeout"));
    expect((await askAI(gemini, report, "Why?", [])).status).toMatch(
      /rule-based/,
    );
    http.mockResolvedValueOnce(
      response({
        candidates: [{ content: { parts: [{ text: "not json" }] } }],
      }),
    );
    expect((await askAI(gemini, report, "Why?", [])).generator).toBe(
      "rule_based",
    );
    http.mockResolvedValueOnce(
      ok([{ ...good[0], metricIds: ["other-tenant-metric"] }]),
    );
    expect((await askAI(gemini, report, "Why?", [])).generator).toBe(
      "rule_based",
    );
    http.mockResolvedValueOnce(
      ok([{ ...good[0], text: "Sessions were 999." }]),
    );
    expect((await askAI(gemini, report, "Why?", [])).generator).toBe(
      "rule_based",
    );
    http
      .mockResolvedValueOnce(response({ error: "x" }, 500))
      .mockResolvedValueOnce(response({ error: "x" }, 500));
    expect((await askAI(gemini, report, "Why?", [])).generator).toBe(
      "rule_based",
    );
    http.mockResolvedValueOnce(
      response({
        candidates: [
          { content: { parts: [{ text: "{" }] }, finishReason: "MAX_TOKENS" },
        ],
      }),
    );
    expect((await askAI(gemini, report, "Why?", [])).status).toMatch(
      /truncated/,
    );
  });
  const chatgpt = {
    ...cfg,
    aiProvider: "openai-compatible",
    aiBase: "https://api.openai.com/v1",
    aiKey: "test-key",
    aiModel: "configured-model",
  };
  const chat = (statements: any) =>
    response({
      choices: [
        {
          message: { content: JSON.stringify({ statements }) },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
  it("calls ChatGPT with settings current OpenAI models accept, in JSON mode", async () => {
    http.mockResolvedValueOnce(chat(good));
    const r = await askAI(chatgpt, report, "Explain", []);
    expect(r).toMatchObject({ generator: "ai", usage: { input: 10 } });
    expect(String(http.mock.calls[0][0])).toBe(
      "https://api.openai.com/v1/chat/completions",
    );
    const body = JSON.parse(String(http.mock.calls[0][2]?.body));
    expect(body.max_completion_tokens).toBeGreaterThan(0);
    expect(body).not.toHaveProperty("max_tokens");
    expect(body).not.toHaveProperty("temperature");
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.messages[0].content).toMatch(/JSON/);
    expect((http.mock.calls[0][2]?.headers as any).Authorization).toBe(
      "Bearer test-key",
    );
  });
  it("adapts to an OpenAI-compatible server that names an unsupported setting", async () => {
    const other = { ...chatgpt, aiBase: "https://llm.example.test/v1" };
    http
      .mockResolvedValueOnce(
        response(
          {
            error: {
              message:
                "Unsupported parameter: 'max_tokens'. Use 'max_completion_tokens' instead.",
            },
          },
          400,
        ),
      )
      .mockResolvedValueOnce(
        response(
          { error: { message: "Unsupported value: 'temperature'." } },
          400,
        ),
      )
      .mockResolvedValueOnce(chat(good));
    expect((await askAI(other, report, "Explain", [])).generator).toBe("ai");
    const last = JSON.parse(String(http.mock.calls[2][2]?.body));
    expect(last).toHaveProperty("max_completion_tokens");
    expect(last).not.toHaveProperty("max_tokens");
    expect(last).not.toHaveProperty("temperature");
  });
  it("explains ChatGPT key, quota and model problems in plain words", async () => {
    http.mockResolvedValueOnce(
      response(
        { error: { message: "Incorrect API key provided: sk-abc123456789" } },
        401,
      ),
    );
    const refused = await askAI(chatgpt, report, "Why?", []);
    expect(refused.status).toMatch(/AI key was refused/);
    expect(JSON.stringify(refused)).not.toContain("sk-abc123456789");
    http.mockResolvedValueOnce(
      response(
        {
          error: {
            message: "You exceeded your current quota.",
            code: "insufficient_quota",
          },
        },
        429,
      ),
    );
    expect((await askAI(chatgpt, report, "Why?", [])).status).toMatch(
      /no credit left/,
    );
    http.mockResolvedValueOnce(
      response({ error: { message: "The model does not exist" } }, 404),
    );
    expect((await askAI(chatgpt, report, "Why?", [])).status).toMatch(
      /was not found/,
    );
  });
  it("names the real network problem when ChatGPT cannot be reached", async () => {
    const fail = (code: string) =>
      Object.assign(new Error("fetch failed"), { code });
    http.mockRejectedValueOnce(fail("SELF_SIGNED_CERT_IN_CHAIN"));
    expect((await askAI(chatgpt, report, "Why?", [])).status).toMatch(
      /company network checks secure traffic/,
    );
    http.mockRejectedValueOnce(fail("ENOTFOUND"));
    expect((await askAI(chatgpt, report, "Why?", [])).status).toMatch(
      /could not find api\.openai\.com/,
    );
    http.mockRejectedValueOnce(fail("PROXY_REFUSED"));
    expect((await askAI(chatgpt, report, "Why?", [])).status).toMatch(
      /proxy refused/,
    );
  });
  it("runs only allowlisted tools, then validates citations to tool results", async () => {
    http
      .mockResolvedValueOnce(
        response({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      toolRequests: [
                        { tool: "read_file", args: { path: "/etc/passwd" } },
                        { tool: "inspect_coverage", args: {} },
                      ],
                    }),
                  },
                ],
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        ok([
          {
            kind: "limitation",
            text: "Coverage is limited.",
            metricIds: [],
            findingIds: [],
            documentIds: [],
            toolIds: [1],
          },
        ]),
      );
    const host = {
      run: vi.fn(async () => ({ summary: "ok", result: { capabilities: [] } })),
    };
    const r = await askAI(gemini, report, "What is missing?", [], host);
    expect(host.run).toHaveBeenCalledTimes(1);
    expect(host.run).toHaveBeenCalledWith("inspect_coverage", {});
    expect(r.tools[0]).toMatchObject({ tool: "read_file", ok: false });
    expect(r.generator).toBe("ai");
  });
  it("rejects causal claims except when explicitly labeled as hypotheses", () => {
    const s = { ...good[0], text: "The decline was caused by the release." };
    expect(() => validateAnswer({ statements: [s] }, report, [])).toThrow(
      "causal",
    );
    expect(
      validateAnswer(
        { statements: [{ ...s, kind: "hypothesis" }] },
        report,
        [],
      ),
    ).toHaveLength(1);
  });
  it("rejects AI drafts containing numbers that are not in the evidence", async () => {
    const type = {
      id: "x",
      label: "Brief",
      fields: [{ key: "a", label: "A" }],
    };
    http.mockResolvedValueOnce(
      response({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    fields: { a: "Conversion rose 42% after launch" },
                  }),
                },
              ],
            },
          },
        ],
      }),
    );
    expect(
      await draftWithAI(gemini, report, type, { a: "" }, undefined, []),
    ).toBeNull();
  });
  it("validates the home briefing: cited findings only, no numbers; routes only to allowed apps", async () => {
    const items = [
      {
        id: "f1",
        app: "Eloqua",
        source: "Prod",
        title: "Bounce",
        severity: "high",
        detail: "x",
      },
    ];
    const brief = (statements: unknown) =>
      response({
        candidates: [
          {
            content: { parts: [{ text: JSON.stringify({ statements }) }] },
            finishReason: "STOP",
          },
        ],
      });
    http.mockResolvedValueOnce(
      brief([
        {
          kind: "priority",
          text: "Review delivery for the production campaigns first.",
          findingIds: ["f1"],
        },
      ]),
    );
    expect((await briefingWithAI(gemini, "Co", items, [])).generator).toBe(
      "ai",
    );
    http.mockResolvedValueOnce(
      brief([
        { kind: "priority", text: "Bounce rate is 9%.", findingIds: ["f1"] },
      ]),
    );
    expect((await briefingWithAI(gemini, "Co", items, [])).generator).toBe(
      "rule_based",
    );
    http.mockResolvedValueOnce(
      brief([
        {
          kind: "priority",
          text: "Other company issue.",
          findingIds: ["other"],
        },
      ]),
    );
    expect((await briefingWithAI(gemini, "Co", items, [])).generator).toBe(
      "rule_based",
    );
    http.mockResolvedValueOnce(
      response({
        candidates: [
          {
            content: {
              parts: [
                { text: JSON.stringify({ app: "commerce", reason: "x" }) },
              ],
            },
          },
        ],
      }),
    );
    expect(
      await routeWithAI(gemini, "Which campaigns bounced?", [
        "eloqua",
        "unity",
      ]),
    ).toMatchObject({ app: "eloqua", generator: "rule_based" });
  });
});

describe("AI evidence masking", () => {
  it("keeps aggregated labels and removes personal data inside them", async () => {
    const { cleanLabel, maskText } = await import("../server/ai");
    expect(cleanLabel("/offer?email=a@b.test")).toBe("/offer");
    expect(cleanLabel("Contact a.person@example.test")).toBe("Contact [email]");
    expect(cleanLabel("Call +61 400 123 456")).toBe("Call [number]");
    expect(cleanLabel(42)).toBe(42);
    expect(
      maskText(
        "1690 of 2600 entries to /home?utm=x bounced (65%); threshold 60%.",
      ),
    ).toBe("1690 of 2600 entries to /home bounced (65%); threshold 60%.");
  });
});
