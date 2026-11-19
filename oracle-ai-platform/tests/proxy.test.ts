// Office networks: which requests go through a company proxy (HTTPS_PROXY / NO_PROXY).
import { describe, expect, it } from "vitest";
import { proxyFor } from "../server/http";

describe("company proxy selection", () => {
  it("uses HTTPS_PROXY for external hosts and skips NO_PROXY hosts", () => {
    const env = {
      HTTPS_PROXY: "http://proxy.example.test:8080",
      NO_PROXY: "localhost,127.0.0.1,.localhost,.internal.example",
    };
    expect(proxyFor("api.openai.com", env)?.host).toBe(
      "proxy.example.test:8080",
    );
    expect(proxyFor("localhost", env)).toBeNull();
    expect(proxyFor("responsys.localhost", env)).toBeNull();
    expect(proxyFor("crm.internal.example", env)).toBeNull();
  });
  it("accepts a bare host:port and ignores unsupported or missing proxies", () => {
    expect(
      proxyFor("api.openai.com", { HTTPS_PROXY: "10.0.0.5:3128" })?.port,
    ).toBe("3128");
    expect(proxyFor("api.openai.com", {})).toBeNull();
    expect(
      proxyFor("api.openai.com", { HTTPS_PROXY: "socks5://proxy:1080" }),
    ).toBeNull();
  });
});
