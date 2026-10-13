import { describe, expect, it } from "vitest";
import { NEW_ISSUE_URL } from "./bugReport";
// The issue form, read as text: the page the link opens must be that form, and the form must ask for what the report has.
import bugForm from "../../.github/ISSUE_TEMPLATE/bug.yml?raw";

describe("Report a Bug", () => {
  it("opens the new-issue page of the bug form", () => {
    expect(NEW_ISSUE_URL).toBe("https://github.com/alyakan/lantern/issues/new?template=bug.yml");
    expect(bugForm).toMatch(/^name: /m);
  });

  it("asks for the steps and for the pasted diagnostics, which are required", () => {
    for (const id of ["steps", "diagnostics"]) {
      const field = bugForm.slice(bugForm.indexOf(`id: ${id}`));
      expect(field.slice(0, field.indexOf("- type:") > 0 ? field.indexOf("- type:") : undefined)).toMatch(/required: true/);
    }
    expect(bugForm).toMatch(/Help ▸ Report a Bug/);
  });
});
