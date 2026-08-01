import { describe, it, expect } from "vitest";
import {
  validateFeedbackInput,
  FEEDBACK_TITLE_MAX_LENGTH,
  FEEDBACK_DESCRIPTION_MAX_LENGTH,
} from "@/lib/feedback";

describe("validateFeedbackInput", () => {
  it("accepts a valid title with no description", () => {
    const result = validateFeedbackInput({ title: "Add dark mode" });
    expect(result).toEqual({
      valid: true,
      data: { title: "Add dark mode", description: null },
    });
  });

  it("accepts a valid title and description, trimming both", () => {
    const result = validateFeedbackInput({
      title: "  Add dark mode  ",
      description: "  Would love a dark theme.  ",
    });
    expect(result).toEqual({
      valid: true,
      data: { title: "Add dark mode", description: "Would love a dark theme." },
    });
  });

  it("normalizes an empty/whitespace-only description to null", () => {
    const result = validateFeedbackInput({ title: "Fix bug", description: "   " });
    expect(result).toEqual({
      valid: true,
      data: { title: "Fix bug", description: null },
    });
  });

  it("rejects an empty title", () => {
    const result = validateFeedbackInput({ title: "" });
    expect(result).toEqual({ valid: false, error: "Title is required" });
  });

  it("rejects a whitespace-only title", () => {
    const result = validateFeedbackInput({ title: "   " });
    expect(result).toEqual({ valid: false, error: "Title is required" });
  });

  it("rejects a title over the max length", () => {
    const result = validateFeedbackInput({ title: "a".repeat(FEEDBACK_TITLE_MAX_LENGTH + 1) });
    expect(result).toEqual({
      valid: false,
      error: `Title must be ${FEEDBACK_TITLE_MAX_LENGTH} characters or fewer`,
    });
  });

  it("accepts a title exactly at the max length", () => {
    const title = "a".repeat(FEEDBACK_TITLE_MAX_LENGTH);
    const result = validateFeedbackInput({ title });
    expect(result.valid).toBe(true);
  });

  it("rejects a description over the max length", () => {
    const result = validateFeedbackInput({
      title: "Fix bug",
      description: "a".repeat(FEEDBACK_DESCRIPTION_MAX_LENGTH + 1),
    });
    expect(result).toEqual({
      valid: false,
      error: `Description must be ${FEEDBACK_DESCRIPTION_MAX_LENGTH} characters or fewer`,
    });
  });

  it("accepts a description exactly at the max length", () => {
    const result = validateFeedbackInput({
      title: "Fix bug",
      description: "a".repeat(FEEDBACK_DESCRIPTION_MAX_LENGTH),
    });
    expect(result.valid).toBe(true);
  });
});
