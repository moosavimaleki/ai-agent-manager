import { describe, expect, test } from "bun:test";
import { quotaWindowFor, visibleQuotaLimits, type Account } from "./AccountsPanel";

function accountWithLimits(limits: NonNullable<Account["rateLimits"]>["limits"]): Account {
  return { name: "account", rateLimits: { limits } };
}

describe("Codex Manager quota presentation", () => {
  test("uses the Codex weekly window rather than an auxiliary gpt-reserve meter", () => {
    const account = accountWithLimits([
      { id: "codex", windows: [{ label: "weekly", remainingPercent: 0, reached: true }, { label: "5h", remainingPercent: 100 }] },
      { id: "base_model_inference", name: "gpt-reserve", windows: [{ label: "weekly", remainingPercent: 100 }] },
    ]);

    expect(quotaWindowFor(account, "weekly")?.remainingPercent).toBe(0);
    expect(visibleQuotaLimits(account)).toEqual([
      { id: "codex", windows: [{ label: "weekly", remainingPercent: 0, reached: true }] },
    ]);
  });

  test("keeps valid auxiliary limits visible while the Codex weekly allowance remains usable", () => {
    const account = accountWithLimits([
      { id: "codex", windows: [{ label: "weekly", remainingPercent: 35 }, { label: "5h", remainingPercent: 80 }] },
      { id: "base_model_inference", name: "gpt-reserve", windows: [{ label: "weekly", remainingPercent: 84 }] },
    ]);

    expect(visibleQuotaLimits(account)).toHaveLength(2);
    expect(visibleQuotaLimits(account)[1]?.name).toBe("gpt-reserve");
  });
});
