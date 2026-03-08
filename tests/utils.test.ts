import { describe, it, expect } from "vitest";
import { parseFrontmatter } from "../src/utils.js";

describe("Frontmatter Parser", () => {
    it("parses simple YAML frontmatter", () => {
        const content = `---
name: test
description: A test file
boot-priority: 10
---
# Content here`;
        const result = parseFrontmatter(content);
        expect(result.name).toBe("test");
        expect(result.description).toBe("A test file");
        expect(result["boot-priority"]).toBe("10");
    });

    it("returns empty object for no frontmatter", () => {
        const content = "# Just a markdown file";
        const result = parseFrontmatter(content);
        expect(result).toEqual({});
    });
});
