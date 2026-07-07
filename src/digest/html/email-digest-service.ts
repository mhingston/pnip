import type { Logger } from "../../logging/logger.js";
import type { Kysely } from "kysely";
import type { Database } from "../../database/kysely.js";
import type { Edition } from "../../database/kysely.js";
import type { EditionRepository } from "../../editions/edition-repository.js";
import type {
  MarkdownDigestRepository,
  MarkdownDigestRow,
} from "../markdown/markdown-digest-repository.js";
import { renderHtml, renderPlainText } from "./markdown-renderer.js";
import { buildEmailTemplate } from "./email-template.js";
import {
  type EmailDigestRepository,
  type EmailDigestRow,
  type EmailDeliveryStatus,
  EmailDigestConflictError,
} from "./email-digest-repository.js";
import {
  type ResendClient,
  type ResendEmailResult,
} from "./resend-client.js";

export interface EmailDigestConfig {
  fromAddress: string;
  toAddresses: string[];
  /** Tags attached to the Resend send, useful for filtering in the dashboard. */
  tags?: { name: string; value: string }[];
}

export interface EmailDigestResult {
  emailDigestId: string;
  edition: Edition;
  deliveryStatus: EmailDeliveryStatus;
  attemptCount: number;
  providerMessageId: string | null;
  failureReason: string | null;
  subject: string;
  alreadyExisted: boolean;
  attempted: boolean;
}

export interface SendEmailDigestInput {
  editionId: string;
}

export interface EmailDigestService {
  send(input: SendEmailDigestInput): Promise<EmailDigestResult>;
  sendForDate(input: {
    editionDate: string | Date;
  }): Promise<EmailDigestResult>;
  preview(input: { editionId: string }): Promise<{
    edition: Edition;
    markdown: MarkdownDigestRow;
    subject: string;
    html: string;
    text: string;
  }>;
  previewForDate(input: { editionDate: string | Date }): Promise<{
    edition: Edition;
    markdown: MarkdownDigestRow;
    subject: string;
    html: string;
    text: string;
  }>;
}

export interface EmailDigestServiceDeps {
  db: Kysely<Database>;
  editionRepo: EditionRepository;
  markdownDigestRepo: MarkdownDigestRepository;
  emailDigestRepo: EmailDigestRepository;
  resend: ResendClient;
  config: EmailDigestConfig;
  logger?: Logger;
}

interface SendOutcome {
  status: "sent" | "failed";
  attemptCount: number;
  providerResponse: unknown;
  providerMessageId: string | null;
  failureReason: string | null;
  attemptedAt: Date;
  completedAt: Date;
}

export function createEmailDigestService(
  deps: EmailDigestServiceDeps,
): EmailDigestService {
  function resolveEdition(editionId: string): Promise<Edition> {
    return deps.editionRepo.getById(editionId).then((ed) => {
      if (!ed) throw new Error(`edition not found: ${editionId}`);
      return ed;
    });
  }

  function formatPublicationDate(value: Date | string): string {
    if (typeof value === "string") return value.slice(0, 10);
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, "0");
    const d = String(value.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  async function renderForEdition(
    edition: Edition,
    markdown: MarkdownDigestRow,
  ): Promise<{ subject: string; html: string; text: string }> {
    const publicationDate = formatPublicationDate(edition.publication_date);
    const htmlBody = renderHtml(markdown.content);
    const plainMarkdown = renderPlainText(markdown.content);
    const template = buildEmailTemplate({
      publicationDate,
      title: `Daily Digest — ${publicationDate}`,
      renderedHtmlBody: htmlBody,
      editionId: edition.id,
    });
    return {
      subject: template.subject,
      html: template.html,
      text: template.text + "\n" + plainMarkdown,
    };
  }

  async function sendViaResend(input: {
    subject: string;
    html: string;
    text: string;
    editionId: string;
  }): Promise<SendOutcome> {
    if (deps.config.toAddresses.length === 0) {
      return {
        status: "failed",
        attemptCount: 1,
        providerResponse: { reason: "no recipients configured" },
        providerMessageId: null,
        failureReason: "EMAIL_RECIPIENT not configured (no recipients)",
        attemptedAt: new Date(),
        completedAt: new Date(),
      };
    }

    const res = await deps.resend.sendEmail({
      from: deps.config.fromAddress,
      to: deps.config.toAddresses,
      subject: input.subject,
      html: input.html,
      text: input.text,
      tags: deps.config.tags ?? [
        { name: "source", value: "pnip-digestive" },
        { name: "edition_id", value: input.editionId },
      ],
      idempotencyKey: `pnip:${input.editionId}`,
    });

    const attemptedAt = new Date();
    if (res.ok) {
      const success: SendOutcome = {
        status: "sent",
        attemptCount: 1,
        providerResponse: res.raw,
        providerMessageId: res.messageId,
        failureReason: null,
        attemptedAt,
        completedAt: new Date(),
      };
      return success;
    }
    return {
      status: "failed",
      attemptCount: 1,
      providerResponse: res.raw,
      providerMessageId: null,
      failureReason: trimError(`HTTP ${res.status}: ${res.errorBody}`),
      attemptedAt,
      completedAt: new Date(),
    };
  }

  function rowToResult(
    row: EmailDigestRow,
    edition: Edition,
    options: {
      alreadyExisted: boolean;
      attempted: boolean;
      subject: string;
    },
  ): EmailDigestResult {
    return {
      emailDigestId: row.id,
      edition,
      deliveryStatus: row.delivery_status as EmailDeliveryStatus,
      attemptCount: row.attempt_count,
      providerMessageId: row.provider_message_id,
      failureReason: row.failure_reason,
      subject: row.subject,
      alreadyExisted: options.alreadyExisted,
      attempted: options.attempted,
    };
  }

  return {
    async preview({ editionId }) {
      const edition = await resolveEdition(editionId);
      const markdown = await deps.markdownDigestRepo.getByEdition(editionId);
      if (!markdown) {
        throw new Error(
          `no markdown digest found for edition ${editionId}; ` +
            `run "digestive generate-digest --date ${formatPublicationDate(edition.publication_date)}" first`,
        );
      }
      const rendered = await renderForEdition(edition, markdown);
      return {
        edition,
        markdown,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
      };
    },

    async previewForDate({ editionDate }) {
      const edition = await deps.editionRepo.getByDate(editionDate);
      if (!edition) {
        throw new Error(`no edition found for date ${String(editionDate)}`);
      }
      return this.preview({ editionId: edition.id });
    },

    async sendForDate({ editionDate }) {
      const edition = await deps.editionRepo.getByDate(editionDate);
      if (!edition) {
        throw new Error(`no edition found for date ${String(editionDate)}`);
      }
      return this.send({ editionId: edition.id });
    },

    async send({ editionId }) {
      const edition = await resolveEdition(editionId);

      const existing = await deps.emailDigestRepo.getByEdition(editionId);
      if (existing && existing.delivery_status === "sent") {
        deps.logger?.info(
          "email digest already sent for edition; idempotent return",
          { editionId, emailDigestId: existing.id },
        );
        return rowToResult(existing, edition, {
          alreadyExisted: true,
          attempted: false,
          subject: existing.subject,
        });
      }

      const markdown = await deps.markdownDigestRepo.getByEdition(editionId);
      if (!markdown) {
        throw new Error(
          `no markdown digest found for edition ${editionId}; ` +
            `run "digestive generate-digest --date ${formatPublicationDate(edition.publication_date)}" first`,
        );
      }
      const rendered = await renderForEdition(edition, markdown);

      let row: EmailDigestRow;
      const initialAttemptCount = existing?.attempt_count ?? 0;
      if (!existing) {
        const placeholderResponse: ResendEmailResult | null = null;
        try {
          row = await deps.emailDigestRepo.createForEdition({
            editionId,
            subject: rendered.subject,
            htmlContent: rendered.html,
            textContent: rendered.text,
            fromAddress: deps.config.fromAddress,
            toAddresses: deps.config.toAddresses,
            deliveryStatus: "pending",
            attemptCount: initialAttemptCount,
            providerResponse: placeholderResponse,
            providerMessageId: null,
            failureReason: null,
            attemptedAt: null,
            completedAt: null,
          });
        } catch (err) {
          if (err instanceof EmailDigestConflictError) {
            const after = await deps.emailDigestRepo.getByEdition(editionId);
            if (after) {
              deps.logger?.info(
                "email digest race resolved; returning existing row",
                { editionId, emailDigestId: after.id },
              );
              return rowToResult(after, edition, {
                alreadyExisted: true,
                attempted: false,
                subject: after.subject,
              });
            }
          }
          throw err;
        }
      } else {
        row = existing;
      }

      const outcome = await sendViaResend({
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        editionId,
      });

      const updated = await deps.emailDigestRepo.updateDelivery(row.id, {
        deliveryStatus: outcome.status,
        attemptCount: row.attempt_count + outcome.attemptCount,
        providerResponse: outcome.providerResponse,
        providerMessageId: outcome.providerMessageId,
        failureReason: outcome.failureReason,
        attemptedAt: outcome.attemptedAt,
        completedAt: outcome.completedAt,
      });

      deps.logger?.info("email digest send attempted", {
        editionId,
        emailDigestId: updated.id,
        status: updated.delivery_status,
        attemptCount: updated.attempt_count,
      });

      return rowToResult(updated, edition, {
        alreadyExisted: Boolean(existing),
        attempted: true,
        subject: updated.subject,
      });
    },
  };
}

function trimError(input: string): string {
  const max = 1024;
  if (input.length <= max) return input;
  return input.slice(0, max) + "…(truncated)";
}
