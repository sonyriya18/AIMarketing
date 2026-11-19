let csrf = "";
export const setCsrf = (value: string) => {
  csrf = value;
};
export async function api<T = any>(
  path: string,
  body?: unknown,
  method?: string,
  signal?: AbortSignal,
): Promise<T> {
  const res = await fetch("/api" + path, {
    method: method || (body === undefined ? "GET" : "POST"),
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(csrf ? { "X-CSRF-Token": csrf } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const json = await res.json().catch(() => ({
    error:
      res.status === 429
        ? "Too many requests. Wait a minute and try again."
        : res.status >= 500
          ? "The platform is not answering properly. If it was just started, wait a moment and try again."
          : `Unexpected server response (${res.status})`,
  }));
  if (!res.ok) throw Error(json.error || "Request failed");
  return json;
}
