import type { Config } from "../config.js";
import { createTransport, formatEmailFrom } from "./mail.js";

export async function sendStripeReceiptEmail(
  cfg: Config,
  opts: {
    to: string;
    subject: string;
    lines: string[];
    primaryUrl: string | null;
    urlLabel?: string;
  }
): Promise<void> {
  const transport = createTransport(cfg);
  const from = formatEmailFrom(cfg);
  if (!transport || !from) return;

  const bodyText = [
    ...opts.lines,
    "",
    opts.primaryUrl
      ? `${opts.urlLabel ?? "Open receipt"} (Stripe): ${opts.primaryUrl}`
      : "You can view invoices anytime from your Konzession dashboard.",
  ].join("\n");

  const htmlBlocks = opts.lines.map((l) => `<p>${escapeHtml(l)}</p>`).join("");
  const linkHtml = opts.primaryUrl
    ? `<p><a href="${escapeAttr(opts.primaryUrl)}">${escapeHtml(opts.urlLabel ?? "View Stripe receipt")}</a></p>`
    : "";

  await transport.sendMail({
    from,
    to: opts.to,
    subject: opts.subject,
    text: bodyText,
    html: `${htmlBlocks}${linkHtml}`,
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/'/g, "&#39;");
}
