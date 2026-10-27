// Refuses text that looks like a credential or personal data, for mail between chats and Telegram replies alike.
const SECRET_PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a private key"],
  [/\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}/, "an API key"],
  [/\b[rs]k_(?:live|test)_[A-Za-z0-9]{10,}/, "a Stripe key"],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, "an AWS access key"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_\w{20,}/, "a GitHub token"],
  [/\bxox[abpr]-[\w-]{10,}/, "a Slack token"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, "a signed token"],
  [/\b(?:password|passwd|passcode|secret|api[_-]?key|token)\s*[:=]\s*\S{6,}/i, "a credential"],
  [/\+\d{10,15}\b|\(\d{3}\)\s?\d{3}-\d{4}\b|\b\d{3}[-.]\d{3}[-.]\d{4}\b/, "a full phone number"],
];

export function findSecret(text: string): string | null {
  for (const [pattern, label] of SECRET_PATTERNS) if (pattern.test(text)) return label;
  return null;
}
