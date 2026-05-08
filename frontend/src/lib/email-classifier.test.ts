import { describe, it, expect } from "vitest";
import { normalizeEmail, isPersonalEmail, classifyEmail } from "./email-classifier";

// email-classifier feeds resume parsing, bulk-add, Clay enrichment, and the
// Inbox Add Person wizard. A wrong work-vs-personal split silently writes
// to the wrong column, so these guard-rails matter.

describe("normalizeEmail", () => {
  it("returns null for empty input", () => {
    expect(normalizeEmail(null)).toBeNull();
    expect(normalizeEmail(undefined)).toBeNull();
    expect(normalizeEmail("")).toBeNull();
    expect(normalizeEmail("   ")).toBeNull();
  });

  it("returns null when no email is present", () => {
    expect(normalizeEmail("just a name")).toBeNull();
    expect(normalizeEmail("phone: 555-1212")).toBeNull();
  });

  it("lowercases and trims a clean address", () => {
    expect(normalizeEmail("  Foo@Bar.COM  ")).toBe("foo@bar.com");
  });

  it("strips Word HYPERLINK artifacts that leak from .docx extraction", () => {
    // The shape we see in the wild: ` HYPERLINK "mailto:foo@bar.com" foo@bar.com`
    expect(normalizeEmail(' HYPERLINK "mailto:foo@bar.com" foo@bar.com'))
      .toBe("foo@bar.com");
  });

  it("strips angle brackets and mailto: prefixes", () => {
    expect(normalizeEmail("<foo@bar.com>")).toBe("foo@bar.com");
    expect(normalizeEmail("mailto:foo@bar.com")).toBe("foo@bar.com");
  });

  it("prefers a personal address when both are present", () => {
    // Resumes commonly list a work address and a personal one; we want the
    // personal one because the work address may go stale when they leave.
    expect(normalizeEmail("alice@biggcorp.com, alice@gmail.com"))
      .toBe("alice@gmail.com");
    expect(normalizeEmail("alice@biggcorp.com; alice@yahoo.com"))
      .toBe("alice@yahoo.com");
  });

  it("falls back to the first address when none are personal", () => {
    expect(normalizeEmail("alice@biggcorp.com, alice@othercorp.com"))
      .toBe("alice@biggcorp.com");
  });
});

describe("isPersonalEmail", () => {
  it("returns false for empty input", () => {
    expect(isPersonalEmail(null)).toBe(false);
    expect(isPersonalEmail(undefined)).toBe(false);
    expect(isPersonalEmail("")).toBe(false);
  });

  it("returns false when there's no @", () => {
    expect(isPersonalEmail("not-an-email")).toBe(false);
  });

  it("recognizes the common consumer domains", () => {
    expect(isPersonalEmail("a@gmail.com")).toBe(true);
    expect(isPersonalEmail("a@yahoo.com")).toBe(true);
    expect(isPersonalEmail("a@hotmail.com")).toBe(true);
    expect(isPersonalEmail("a@outlook.com")).toBe(true);
    expect(isPersonalEmail("a@icloud.com")).toBe(true);
    expect(isPersonalEmail("a@proton.me")).toBe(true);
  });

  it("treats .edu as personal (alumni/student addresses go stale less than work)", () => {
    expect(isPersonalEmail("alice@stanford.edu")).toBe(true);
    expect(isPersonalEmail("alice@harvard.edu")).toBe(true);
  });

  it("returns false for corporate domains", () => {
    expect(isPersonalEmail("alice@biggcorp.com")).toBe(false);
    expect(isPersonalEmail("alice@example.io")).toBe(false);
  });

  it("is case-insensitive on the domain", () => {
    expect(isPersonalEmail("Alice@GMAIL.COM")).toBe(true);
  });
});

describe("classifyEmail", () => {
  it("returns an empty object for empty input", () => {
    expect(classifyEmail(null)).toEqual({});
    expect(classifyEmail(undefined)).toEqual({});
    expect(classifyEmail("")).toEqual({});
  });

  it("routes personal addresses to personal_email", () => {
    expect(classifyEmail("a@gmail.com")).toEqual({ personal_email: "a@gmail.com" });
  });

  it("routes work addresses to work_email", () => {
    expect(classifyEmail("a@biggcorp.com")).toEqual({ work_email: "a@biggcorp.com" });
  });

  it("never sets both fields at once", () => {
    // Spreading the result into an upsert must not clobber the *other*
    // column with undefined — guard against that here.
    const personal = classifyEmail("a@gmail.com");
    expect("work_email" in personal).toBe(false);
    const work = classifyEmail("a@biggcorp.com");
    expect("personal_email" in work).toBe(false);
  });
});
