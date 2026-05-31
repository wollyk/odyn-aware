// Behavior under test:
//   - Banner is hidden until SESSION_EXPIRED_EVENT fires
//   - After the event, banner is rendered with a "Sign in" link

import { describe, it, expect, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { SessionExpiredBanner } from "./session-expired-banner";
import { SESSION_EXPIRED_EVENT } from "@/lib/apiFetch";

// Stub useNavigate so the banner can render without a full TanStack
// router harness (which pulls in scroll-restoration and async
// transitioner — both unhelpful for this unit).
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => () => {},
}));

describe("SessionExpiredBanner", () => {
  it("does not render anything until the event fires", () => {
    render(<SessionExpiredBanner />);
    expect(screen.queryByTestId("session-expired-banner")).not.toBeInTheDocument();
  });

  it("renders the banner with a Sign in CTA after the event fires", async () => {
    render(<SessionExpiredBanner />);
    await act(async () => {
      window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
    });
    expect(screen.getByTestId("session-expired-banner")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /sign in/i })).toBeInTheDocument();
  });
});
