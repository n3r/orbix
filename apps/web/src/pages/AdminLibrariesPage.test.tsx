import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test/renderWithProviders";
import AdminLibrariesPage from "./AdminLibrariesPage";

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AdminLibrariesPage", () => {
  it("renames a library inline", async () => {
    let libraryName = "Movies";
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (url === "/api/libraries" && method === "GET") {
        return jsonResponse([
          { id: "lib1", name: libraryName, order: 0, createdAt: "2026-07-04T00:00:00.000Z", sources: [] },
        ]);
      }

      if (url === "/api/libraries/lib1" && method === "PATCH") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { name: string };
        libraryName = body.name;
        return jsonResponse({ id: "lib1", name: libraryName, order: 0 });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(<AdminLibrariesPage />);

    expect(await screen.findByRole("heading", { name: "Movies" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    fireEvent.change(screen.getByLabelText("Library name"), { target: { value: "Films" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      const patchCall = fetchMock.mock.calls.find(
        ([url, init]) => String(url) === "/api/libraries/lib1" && init?.method === "PATCH",
      );
      expect(patchCall).toBeTruthy();
      expect(JSON.parse(String(patchCall?.[1]?.body))).toEqual({ name: "Films" });
    });

    expect(await screen.findByRole("heading", { name: "Films" })).toBeTruthy();
  });

  it("shows library stats and restores active scan state after load", async () => {
    class MockEventSource {
      static instances: MockEventSource[] = [];
      onmessage: ((event: MessageEvent<string>) => void) | null = null;
      onerror: (() => void) | null = null;

      constructor(public url: string) {
        MockEventSource.instances.push(this);
      }

      close() {}
    }

    vi.stubGlobal("EventSource", MockEventSource);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/libraries" && method === "GET") {
        return jsonResponse([
          {
            id: "lib1",
            name: "Movies",
            order: 0,
            createdAt: "2026-07-04T00:00:00.000Z",
            sources: [
              {
                id: "src1",
                libraryId: "lib1",
                kind: "local",
                path: "/media/movies",
                enabled: true,
                status: "ok",
                statusMessage: null,
                lastScanAt: "2026-07-04T08:00:00.000Z",
              },
              {
                id: "src2",
                libraryId: "lib1",
                kind: "local",
                path: "/media/archive",
                enabled: false,
                status: "error",
                statusMessage: "offline",
                lastScanAt: null,
              },
            ],
            summary: {
              totalItems: 12,
              enrichedItems: 9,
              missingMetadata: 2,
              missingArtwork: 3,
              files: 14,
              sourceCount: 2,
              enabledSourceCount: 1,
              sourceErrorCount: 1,
              lastScanAt: "2026-07-04T08:00:00.000Z",
            },
            activeScan: { jobId: "scan-job-1", state: "active", phase: "enriching", processed: 2, total: 4 },
          },
        ]);
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    }));

    renderWithProviders(<AdminLibrariesPage />);

    expect(await screen.findByText("1 libraries · 12 items · 2 missing metadata")).toBeTruthy();
    expect(screen.getByText("Missing metadata")).toBeTruthy();
    expect(screen.getByText("Missing art")).toBeTruthy();
    expect(screen.getByText((_, el) => el?.textContent?.includes("1/2 sources enabled") ?? false, { selector: "p" })).toBeTruthy();
    expect(screen.getByText("enriching: 2/4")).toBeTruthy();
    expect(screen.getByText((_, el) => el?.textContent === "50%")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Scanning…" }) as HTMLButtonElement).disabled).toBe(true);
    expect(MockEventSource.instances[0]?.url).toBe("/api/scan/scan-job-1/stream");
  });
});
