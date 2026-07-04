import { describe, it, expect, vi } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { ConfirmDialog, Toggle, Skeleton, useFocusTrap } from "@orbix/ui";

describe("ConfirmDialog", () => {
  const base = {
    title: "Delete 'Movies'?",
    description: "This removes the library and its 700 items. This can't be undone.",
    confirmLabel: "Delete",
    cancelLabel: "Cancel",
    onConfirm: () => {},
    onCancel: () => {},
  };

  it("renders nothing while closed", () => {
    render(<ConfirmDialog {...base} open={false} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders an accessible modal dialog when open", () => {
    render(<ConfirmDialog {...base} open />);
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-labelledby")).toBeTruthy();
    expect(screen.getByText("Delete 'Movies'?")).toBeTruthy();
    expect(screen.getByText(/can't be undone/)).toBeTruthy();
  });

  it("fires onConfirm and onCancel from the buttons", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<ConfirmDialog {...base} open onConfirm={onConfirm} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("closes on Escape", () => {
    const onCancel = vi.fn();
    render(<ConfirmDialog {...base} open onCancel={onCancel} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("does not close on Escape while busy", () => {
    const onCancel = vi.fn();
    render(<ConfirmDialog {...base} open busy onCancel={onCancel} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onCancel).not.toHaveBeenCalled();
  });
});

describe("Toggle", () => {
  it("exposes switch semantics and toggles on click", () => {
    function Harness() {
      const [on, setOn] = useState(false);
      return <Toggle checked={on} onCheckedChange={setOn} aria-label="Kids profile" />;
    }
    render(<Harness />);
    const sw = screen.getByRole("switch", { name: "Kids profile" });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(sw);
    expect(sw.getAttribute("aria-checked")).toBe("true");
  });

  it("does not fire when disabled", () => {
    const onCheckedChange = vi.fn();
    render(<Toggle checked={false} onCheckedChange={onCheckedChange} disabled aria-label="x" />);
    fireEvent.click(screen.getByRole("switch"));
    expect(onCheckedChange).not.toHaveBeenCalled();
  });
});

describe("Skeleton", () => {
  it("is hidden from assistive tech and animates", () => {
    const { container } = render(<Skeleton className="h-8 w-8" />);
    const el = container.firstChild as HTMLElement;
    expect(el.getAttribute("aria-hidden")).toBe("true");
    expect(el.className).toContain("animate-pulse");
    expect(el.className).toContain("motion-reduce:animate-none");
  });
});

describe("useFocusTrap", () => {
  function Harness({ onEscape }: { onEscape: () => void }) {
    const [open, setOpen] = useState(false);
    const ref = useFocusTrap<HTMLDivElement>(open, { onEscape });
    return (
      <div>
        <button onClick={() => setOpen(true)}>opener</button>
        {open && (
          <div ref={ref} data-testid="trap">
            <button onClick={() => setOpen(false)}>inside</button>
          </div>
        )}
      </div>
    );
  }

  it("invokes onEscape on Escape and restores focus to the opener on close", async () => {
    const onEscape = vi.fn();
    render(<Harness onEscape={onEscape} />);
    const opener = screen.getByRole("button", { name: "opener" });
    act(() => opener.focus());
    fireEvent.click(opener);

    // Escape is caught while the trap is active.
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onEscape).toHaveBeenCalledOnce();

    // Closing the trap restores focus to the element that opened it.
    fireEvent.click(screen.getByRole("button", { name: "inside" }));
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });
});
