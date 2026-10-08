const DEFAULT_POLICY = {
  removePrefixes: ["SYSTEM:", "DEVELOPER:", "INTERNAL:"],
  redactPatterns: [
    { pattern: "\\bsk-[A-Za-z0-9_-]{10,}\\b", flags: "g", replacement: "[REDACTED_API_KEY]" },
    { pattern: "\\bBearer\\s+[A-Za-z0-9._~-]{10,}\\b", flags: "gi", replacement: "Bearer [REDACTED_TOKEN]" }
  ],
  maxChars: 20000,
  focusTerms: []
};

export function normalizePolicy(input = {}) {
  const p = { ...DEFAULT_POLICY, ...input };
  p.removePrefixes = Array.isArray(p.removePrefixes) ? p.removePrefixes.map(String) : [];
  p.redactPatterns = Array.isArray(p.redactPatterns) ? p.redactPatterns : [];
  p.focusTerms = Array.isArray(p.focusTerms) ? p.focusTerms.map(String).filter(Boolean) : [];
  p.maxChars = Number.isFinite(Number(p.maxChars)) ? Math.max(500, Math.min(200000, Number(p.maxChars))) : DEFAULT_POLICY.maxChars;
  return p;
}

export function orchestrateText(text, policyInput = {}) {
  const policy = normalizePolicy(policyInput);
  let output = String(text ?? "");
  const removed = [];

  output = output
    .split(/\r?\n/)
    .filter(line => {
      const hit = policy.removePrefixes.find(prefix => line.trimStart().startsWith(prefix));
      if (hit) removed.push({ type: "line", prefix: hit });
      return !hit;
    })
    .join("\n");

  for (const rule of policy.redactPatterns) {
    try {
      const regex = new RegExp(rule.pattern, rule.flags || "g");
      output = output.replace(regex, rule.replacement ?? "[REDACTED]");
    } catch {
      // Invalid user rules are ignored in the editor preview; validation endpoint reports them.
    }
  }

  const focus = policy.focusTerms;
  let focused = false;
  if (focus.length) {
    const lower = output.toLowerCase();
    focused = focus.some(term => lower.includes(term.toLowerCase()));
  }

  if (output.length > policy.maxChars) {
    output = `${output.slice(0, policy.maxChars)}\n… [TRUNCATED BY SEARCH-SPACE POLICY]`;
  }

  return {
    output,
    audit: {
      removedLines: removed.length,
      removed,
      focused,
      maxChars: policy.maxChars
    }
  };
}

export function orchestrateDataset(items, policyInput = {}) {
  if (!Array.isArray(items)) throw new TypeError("items must be an array");
  return items.map((item, index) => {
    if (typeof item === "string") {
      const result = orchestrateText(item, policyInput);
      return { index, input: item, output: result.output, audit: result.audit };
    }
    const prompt = item?.prompt ?? item?.input ?? "";
    const completion = item?.completion ?? item?.output ?? "";
    const result = orchestrateText(completion, policyInput);
    return { ...item, index, output: result.output, audit: result.audit, prompt };
  });
}

export function validatePolicy(policyInput = {}) {
  const p = normalizePolicy(policyInput);
  const issues = [];
  for (const rule of p.redactPatterns) {
    try { new RegExp(rule.pattern, rule.flags || "g"); }
    catch (error) { issues.push(`Invalid redact regex: ${rule.pattern} (${error.message})`); }
  }
  return { valid: issues.length === 0, issues, policy: p };
}
