import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

type MailAttachment = {
  filename: string;
  content: Buffer | string;
  contentType?: string;
};

type MailRecipient = { email: string; name?: string };

function parseEmailFrom(from: string): MailRecipient {
  const match = from.match(/^(.*?)<([^>]+)>$/);
  if (match && match[1] && match[2]) {
    return { name: match[1].trim().replace(/^"|"$/g, ''), email: match[2].trim() };
  }
  return { email: from.trim() };
}

let transporter: Transporter | undefined;

function getTransporter() {
  if (!env.MAILCOW_SMTP_HOST || !env.MAILCOW_SMTP_USER || !env.MAILCOW_SMTP_PASS || !env.EMAIL_FROM) {
    throw new Error('Mailcow SMTP configuration is incomplete');
  }
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env.MAILCOW_SMTP_HOST,
      port: env.MAILCOW_SMTP_PORT,
      secure: env.MAILCOW_SMTP_SECURE,
      auth: { user: env.MAILCOW_SMTP_USER, pass: env.MAILCOW_SMTP_PASS },
    });
  }
  return transporter;
}

export async function sendMail(to: string, subject: string, html: string, attachments: MailAttachment[] = []) {
  const sender = parseEmailFrom(env.EMAIL_FROM || '');
  await getTransporter().sendMail({
    from: sender.name ? `${sender.name} <${sender.email}>` : sender.email,
    to,
    subject,
    html,
    attachments,
  });
  logger.info({ to, subject, attachmentCount: attachments.length }, 'Email sent via Mailcow SMTP');
}

export async function sendOtpEmail(to: string, code: string) {
  const html = `<p>Your Lulu AI verification code is:</p><h2>${code}</h2><p>This code expires soon.</p>`;
  await sendMail(to, 'Your Lulu AI verification code', html);
}

export async function sendResetEmail(to: string, code: string) {
  const html = `<p>Use this Lulu AI code to reset your password:</p><h2>${code}</h2><p>This code expires soon.</p>`;
  await sendMail(to, 'Reset your Lulu AI password', html);
}

function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;',
  })[character]!);
}

export async function sendWorkspaceInvitationEmail(
  to: string,
  workspaceName: string,
  invitationUrl: string
) {
  const safeWorkspaceName = escapeHtml(workspaceName);
  const safeUrl = escapeHtml(invitationUrl);
  const html = [
    `<p>You have been invited to join <strong>${safeWorkspaceName}</strong> in Lulu AI.</p>`,
    `<p><a href="${safeUrl}">Accept workspace invitation</a></p>`,
    '<p>This invitation expires in seven days.</p>',
  ].join('');
  await sendMail(to, `Join ${workspaceName} in Lulu AI`, html);
}
