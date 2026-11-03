import type { Context } from "hono";
import type { AppEnv } from "../env";
import type { PageContext } from "../views/layout";

export function pageContext(c: Context<AppEnv>): PageContext {
  const url = new URL(c.req.url);
  return {
    lang: c.get("lang"),
    theme: c.get("theme"),
    user: c.get("user"),
    path: c.req.method === "GET" ? url.pathname + url.search : c.req.header("Referer") ? new URL(c.req.header("Referer")!).pathname : "/"
  };
}
