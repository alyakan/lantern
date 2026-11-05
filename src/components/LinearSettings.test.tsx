import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { LinearWork } from "../types";
import { LinearSettings } from "./LinearSettings";

const work: LinearWork = { connected: true, viewer: "Aly", org: "Acme", teams: [{ key: "ENG", name: "Engineering" }], issues: [], error: null };

describe("Settings → Linear", () => {
  it("offers a team for each project once Linear is connected, and no switch for Ready issues (they fold on the Desk instead)", () => {
    render(<LinearSettings folders={["/p/lantern"]} teams={{}} onTeams={() => {}} work={work} onWork={() => {}} />);
    expect(screen.getByRole("heading", { name: "Teams" })).toBeInTheDocument();
    expect(screen.getByLabelText("Linear team for lantern")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("offers the key, not the teams, until Linear is connected", () => {
    render(<LinearSettings folders={["/p/lantern"]} teams={{}} onTeams={() => {}} work={{ ...work, connected: false }} onWork={() => {}} />);
    expect(screen.getByLabelText("Personal API key")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Teams" })).toBeNull();
  });
});
