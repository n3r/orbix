import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { renderWithProviders, makeClient } from "@/test/renderWithProviders";
import ProfileMenuEditor from "./ProfileMenuEditor";
import type { MenuConfig } from "@/lib/types";

const saveMock = vi.fn();
vi.mock("@/lib/queries", async (orig) => {
  const actual = await orig<typeof import("@/lib/queries")>();
  return { ...actual, saveMenu: (...args: unknown[]) => saveMock(...args) };
});

const config: MenuConfig = {
  libraries: [
    { libraryId: "s1", name: "Movies" },
    { libraryId: "s2", name: "Shows" },
    { libraryId: "s3", name: "Docs" },
  ],
  enabled: ["s1", "s2", "s3"],
};

beforeEach(() => { saveMock.mockReset(); saveMock.mockResolvedValue({ items: [] }); });

describe("ProfileMenuEditor", () => {
  function setup() {
    const client = makeClient();
    client.setQueryData(["menu-config"], config);
    return renderWithProviders(<ProfileMenuEditor />, { client, route: "/account/menu" });
  }

  it("lists every section as a checkbox", () => {
    setup();
    expect(screen.getByRole("checkbox", { name: /Movies/ })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: /Shows/ })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: /Docs/ })).toBeTruthy();
  });

  it("saves only the enabled section ids in order", async () => {
    setup();
    fireEvent.click(screen.getByRole("checkbox", { name: /Shows/ })); // disable s2
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(saveMock).toHaveBeenCalledWith(["s1", "s3"]));
  });

  it("disables Save when no category is enabled (cannot save an empty menu)", () => {
    setup();
    fireEvent.click(screen.getByRole("checkbox", { name: /Movies/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Shows/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Docs/ }));
    expect((screen.getByRole("button", { name: /save/i }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/at least one category/i)).toBeTruthy();
  });
});
