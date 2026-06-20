import { describe, it, expect } from "vitest";
import {
  detectOutOfOfficeHeuristic,
  decideOutOfOffice,
  parseReturnDate,
  resolveOOOResumeBase,
  DEFAULT_OOO_PUSH_DAYS,
} from "./out-of-office";

// The OOO backstop runs whenever the AI cascade is unavailable. A false
// positive keeps us emailing someone who actually engaged, so the negative
// cases below (genuine replies that merely mention an absence) matter as much
// as the positives.

const NOW = new Date("2026-06-20T15:00:00Z");

describe("detectOutOfOfficeHeuristic — subject signals", () => {
  it("flags Outlook/Exchange 'Automatic reply:' subjects", () => {
    expect(detectOutOfOfficeHeuristic("Automatic reply: Re: Senior PM role", "").isOOO).toBe(true);
  });

  it("flags 'Out of Office' and OOO subjects", () => {
    expect(detectOutOfOfficeHeuristic("Out of Office", "anything").isOOO).toBe(true);
    expect(detectOutOfOfficeHeuristic("OOO until next week", "").isOOO).toBe(true);
    expect(detectOutOfOfficeHeuristic("Auto-Reply", "").isOOO).toBe(true);
  });

  it("flags leave / vacation notice subjects", () => {
    expect(detectOutOfOfficeHeuristic("On annual leave", "").isOOO).toBe(true);
    expect(detectOutOfOfficeHeuristic("Vacation notice", "").isOOO).toBe(true);
  });
});

describe("detectOutOfOfficeHeuristic — body signals", () => {
  it("flags clear auto-responder bodies even with a plain subject", () => {
    expect(
      detectOutOfOfficeHeuristic("Re: Quick question", "Hi — I am currently out of the office and will reply on my return.").isOOO,
    ).toBe(true);
    expect(
      detectOutOfOfficeHeuristic("Re: Quick question", "This is an automated reply. I'm away from my desk.").isOOO,
    ).toBe(true);
    expect(
      detectOutOfOfficeHeuristic(null, "Thank you for your email. I'm on parental leave until further notice.").isOOO,
    ).toBe(true);
  });

  it("strips HTML before matching", () => {
    expect(
      detectOutOfOfficeHeuristic("Re: hello", "<div>I&nbsp;am&nbsp;currently&nbsp;out&nbsp;of&nbsp;the&nbsp;office.</div>").isOOO,
    ).toBe(true);
  });
});

describe("detectOutOfOfficeHeuristic — negatives (genuine replies)", () => {
  it("does NOT flag a real reply that mentions a past absence", () => {
    expect(
      detectOutOfOfficeHeuristic("Re: Senior PM role", "Sorry for the delay, I was out last week. Yes, I'm interested — let's talk!").isOOO,
    ).toBe(false);
  });

  it("does NOT flag a normal interested reply", () => {
    expect(
      detectOutOfOfficeHeuristic("Re: Opportunity", "Thanks for reaching out. This looks interesting, can we chat Thursday?").isOOO,
    ).toBe(false);
  });

  it("does NOT flag a future-plan mention that isn't an auto-reply", () => {
    expect(
      detectOutOfOfficeHeuristic("Re: catching up", "I'm planning a vacation next month but happy to connect before then.").isOOO,
    ).toBe(false);
  });
});

describe("decideOutOfOffice — AI vs heuristic precedence", () => {
  const heuristicHit = { isOOO: true, returnDate: "2026-07-01" };
  const heuristicMiss = { isOOO: false, returnDate: null };

  it("treats AI 'ooo' as OOO, preferring the AI return date", () => {
    expect(decideOutOfOffice("ooo", "2026-07-15", heuristicHit)).toEqual({ isOOO: true, returnDate: "2026-07-15" });
  });

  it("falls back to the heuristic return date when AI 'ooo' has none", () => {
    expect(decideOutOfOffice("ooo", null, heuristicHit)).toEqual({ isOOO: true, returnDate: "2026-07-01" });
  });

  it("does NOT reschedule a confident human reply even if the heuristic trips", () => {
    // "interested but out until Monday" — engagement wins over the OOO mention.
    expect(decideOutOfOffice("interested", null, heuristicHit).isOOO).toBe(false);
    expect(decideOutOfOffice("not_interested", null, heuristicHit).isOOO).toBe(false);
    expect(decideOutOfOffice("do_not_contact", null, heuristicHit).isOOO).toBe(false);
  });

  it("defers to the heuristic when AI is absent or non-committal", () => {
    expect(decideOutOfOffice(null, null, heuristicHit).isOOO).toBe(true);
    expect(decideOutOfOffice("neutral", null, heuristicHit).isOOO).toBe(true);
    expect(decideOutOfOffice("maybe", null, heuristicHit).isOOO).toBe(true);
    expect(decideOutOfOffice(null, null, heuristicMiss).isOOO).toBe(false);
  });
});

describe("parseReturnDate", () => {
  it("parses ISO dates", () => {
    expect(parseReturnDate("I will be back on 2026-07-15.", NOW)).toBe("2026-07-15");
  });

  it("parses US numeric dates with explicit year", () => {
    expect(parseReturnDate("Out of office until 07/15/2026.", NOW)).toBe("2026-07-15");
  });

  it("parses US numeric dates without a year (infers current year)", () => {
    expect(parseReturnDate("Returning 7/15.", NOW)).toBe("2026-07-15");
  });

  it("parses 'Month Day' with and without year", () => {
    expect(parseReturnDate("I'll be back on July 15.", NOW)).toBe("2026-07-15");
    expect(parseReturnDate("Returning July 15, 2026.", NOW)).toBe("2026-07-15");
    expect(parseReturnDate("Back on Jan 5", NOW)).toBe("2027-01-05"); // Jan already passed → next year
  });

  it("parses 'Day Month' phrasing", () => {
    expect(parseReturnDate("I return to office on 15 July 2026.", NOW)).toBe("2026-07-15");
    expect(parseReturnDate("Back on 5th of August", NOW)).toBe("2026-08-05");
  });

  it("prefers a date preceded by a return cue over an unrelated date", () => {
    // 06/19 appears (a signature/date stamp) but the real return is 'until July 1'.
    expect(
      parseReturnDate("Sent 06/19/2026. I am away and will return until July 1, 2026.", NOW),
    ).toBe("2026-07-01");
  });

  it("returns null when there is no date", () => {
    expect(parseReturnDate("I am out of office with no return date specified.", NOW)).toBeNull();
  });

  it("rejects impossible dates (Feb 30) and far-out noise", () => {
    expect(parseReturnDate("back on 2026-02-30", NOW)).toBeNull();
    expect(parseReturnDate("until 2099-01-01", NOW)).toBeNull();
  });
});

describe("resolveOOOResumeBase", () => {
  it("returns the day AFTER a future return date", () => {
    const base = resolveOOOResumeBase("2026-07-15", NOW);
    expect(base.toISOString().slice(0, 10)).toBe("2026-07-16");
  });

  it("falls back to the default push when no date is given", () => {
    const base = resolveOOOResumeBase(null, NOW);
    const expected = new Date(NOW.getTime() + DEFAULT_OOO_PUSH_DAYS * 86400000);
    expect(base.toISOString().slice(0, 10)).toBe(expected.toISOString().slice(0, 10));
  });

  it("falls back to the default push when the return date is already past", () => {
    const base = resolveOOOResumeBase("2026-01-01", NOW);
    const expected = new Date(NOW.getTime() + DEFAULT_OOO_PUSH_DAYS * 86400000);
    expect(base.toISOString().slice(0, 10)).toBe(expected.toISOString().slice(0, 10));
  });

  it("ignores malformed date strings", () => {
    const base = resolveOOOResumeBase("not-a-date", NOW);
    const expected = new Date(NOW.getTime() + DEFAULT_OOO_PUSH_DAYS * 86400000);
    expect(base.toISOString().slice(0, 10)).toBe(expected.toISOString().slice(0, 10));
  });
});
