import { describe, expect, it, vi } from "vitest";

import { downloadJsonFromUrl } from "./download-json";

function stubDom(anchor: { href: string; download: string; click: () => void; remove: () => void }) {
  const appendChild = vi.fn().mockReturnValue(anchor);
  vi.stubGlobal("document", {
    createElement: vi.fn().mockReturnValue(anchor),
    body: { appendChild },
  });
  return appendChild;
}

describe("downloadJsonFromUrl", () => {
  it("fetches the url, builds a blob: object URL, and clicks a download anchor", async () => {
    const blob = { type: "application/json" };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, blob: () => Promise.resolve(blob) });
    vi.stubGlobal("fetch", fetchMock);
    const createObjectURL = vi.fn().mockReturnValue("blob:mock-url");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });

    const click = vi.fn();
    const remove = vi.fn();
    const anchor = { href: "", download: "", click, remove };
    const appendChild = stubDom(anchor);

    await downloadJsonFromUrl("https://api.example/openapi.json", "openapi.json");

    expect(fetchMock).toHaveBeenCalledWith("https://api.example/openapi.json");
    expect(createObjectURL).toHaveBeenCalledWith(blob);
    expect(anchor.href).toBe("blob:mock-url");
    expect(anchor.download).toBe("openapi.json");
    expect(appendChild).toHaveBeenCalledWith(anchor);
    expect(click).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:mock-url");

    vi.unstubAllGlobals();
  });

  it("throws (and still revokes nothing, since no object URL was created) on a non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503 }));

    await expect(downloadJsonFromUrl("https://api.example/openapi.json", "openapi.json")).rejects.toThrow(
      "Download failed: 503",
    );

    vi.unstubAllGlobals();
  });

  it("revokes the object URL even if the anchor click throws", async () => {
    const blob = { type: "application/json" };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, blob: () => Promise.resolve(blob) }));
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL: vi.fn().mockReturnValue("blob:mock-url"), revokeObjectURL });

    const anchor = {
      href: "",
      download: "",
      click: () => {
        throw new Error("blocked");
      },
      remove: vi.fn(),
    };
    stubDom(anchor);

    await expect(downloadJsonFromUrl("https://api.example/openapi.json", "openapi.json")).rejects.toThrow(
      "blocked",
    );
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:mock-url");

    vi.unstubAllGlobals();
  });
});
