import MsgReader from '@kenjiuno/msgreader';
import { simpleParser, type AddressObject } from 'mailparser';

import {
  DOCUMENT_MAX_BYTES,
  MESSAGE_ATTACHMENTS_MAX,
  MESSAGE_TEXT_MAX,
  uploadExtension,
  type MessageAddress,
  type MessageRendition,
} from '@materia/domain';

/** One attachment's bytes, as `messageAttachment` extracts it. */
export interface MessageAttachment {
  fileName: string;
  mime: string;
  data: Buffer;
}

/** A parsed message: the rendition, plus a way to read each attachment's bytes. */
interface ParsedMessage {
  rendition: MessageRendition;
  attachment(index: number): MessageAttachment | null;
}

/** File names come from the sender: keep a plain base name, and something when there is none. */
export function safeAttachmentName(name: string | undefined, index: number): string {
  const base = (name ?? '')
    .split(/[\\/]/)
    .pop()
    ?.split('')
    .filter((c) => c.charCodeAt(0) >= 0x20 && c.charCodeAt(0) !== 0x7f)
    .join('')
    .trim();
  return (base || `attachment-${index + 1}`).slice(0, 255);
}

const clip = (text: string) =>
  text.length > MESSAGE_TEXT_MAX
    ? { text: text.slice(0, MESSAGE_TEXT_MAX), textTruncated: true }
    : { text, textTruncated: false };

/** A rough plain-text version of an HTML-only body (the rendition never carries HTML). */
function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function rendition(
  fields: Omit<MessageRendition, 'format' | 'text' | 'textTruncated' | 'attachments' | 'attachmentsTruncated'> & {
    body: string;
    attachments: { fileName: string; mime: string; sizeBytes: number; savable?: boolean }[];
  },
): MessageRendition {
  const listed = fields.attachments.slice(0, MESSAGE_ATTACHMENTS_MAX);
  return {
    format: 'message.v1',
    subject: fields.subject,
    from: fields.from,
    to: fields.to,
    cc: fields.cc,
    date: fields.date,
    ...clip(fields.body),
    attachments: listed.map((a, index) => ({
      index,
      fileName: a.fileName,
      mime: a.mime,
      sizeBytes: a.sizeBytes,
      savable: (a.savable ?? true) && uploadExtension(a.fileName) !== null && a.sizeBytes <= DOCUMENT_MAX_BYTES,
    })),
    attachmentsTruncated: fields.attachments.length > listed.length,
  };
}

const addresses = (value: AddressObject | AddressObject[] | undefined): MessageAddress[] =>
  (Array.isArray(value) ? value : value ? [value] : []).flatMap((group) =>
    group.value.map((entry) => ({ name: entry.name ?? '', address: entry.address ?? '' })),
  );

async function parseEml(data: Buffer): Promise<ParsedMessage> {
  const mail = await simpleParser(data, { skipImageLinks: true, skipTextToHtml: true, skipTextLinks: true });
  const files = mail.attachments.map((a, index) => ({
    fileName: safeAttachmentName(a.filename, index),
    mime: a.contentType || 'application/octet-stream',
    data: a.content,
  }));
  return {
    rendition: rendition({
      subject: mail.subject ?? '',
      from: addresses(mail.from)[0] ?? null,
      to: addresses(mail.to),
      cc: addresses(mail.cc),
      date: mail.date && !Number.isNaN(mail.date.getTime()) ? mail.date.toISOString() : null,
      body: mail.text ?? (typeof mail.html === 'string' ? htmlToText(mail.html) : ''),
      attachments: files.map((f) => ({ fileName: f.fileName, mime: f.mime, sizeBytes: f.data.length })),
    }),
    attachment: (index) => files[index] ?? null,
  };
}

function parseMsg(data: Buffer): ParsedMessage {
  const reader = new MsgReader(new DataView(data.buffer, data.byteOffset, data.byteLength));
  const message = reader.getFileData();
  if (message.error) throw new Error('Unreadable message');
  const entries = message.attachments ?? [];
  const recipients = (type: string) =>
    (message.recipients ?? [])
      .filter((r) => (r.recipType ?? 'to') === type)
      .map((r) => ({ name: r.name ?? '', address: r.smtpAddress ?? r.email ?? '' }));
  const date = message.messageDeliveryTime ?? message.clientSubmitTime;
  const parsedDate = date ? new Date(date) : null;
  return {
    rendition: rendition({
      subject: message.subject ?? '',
      from:
        message.senderName || message.senderSmtpAddress || message.senderEmail
          ? {
              name: message.senderName ?? '',
              address: message.senderSmtpAddress ?? message.senderEmail ?? '',
            }
          : null,
      to: recipients('to'),
      cc: recipients('cc'),
      date: parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate.toISOString() : null,
      body: message.body ?? (message.bodyHtml ? htmlToText(message.bodyHtml) : ''),
      attachments: entries.map((entry, index) => ({
        fileName: safeAttachmentName(entry.fileName ?? entry.fileNameShort ?? entry.name, index),
        mime: entry.attachMimeTag || 'application/octet-stream',
        sizeBytes: entry.contentLength ?? 0,
        // An attached Outlook item is a message inside the message, not a file.
        savable: !entry.innerMsgContent,
      })),
    }),
    attachment: (index) => {
      const entry = entries[index];
      if (!entry || entry.innerMsgContent) return null;
      const { content } = reader.getAttachment(entry);
      return {
        fileName: safeAttachmentName(entry.fileName ?? entry.fileNameShort ?? entry.name, index),
        mime: entry.attachMimeTag || 'application/octet-stream',
        data: Buffer.from(content),
      };
    },
  };
}

/** Parses a stored .eml or .msg file. Throws for anything else, or a message it can't read. */
export async function parseMessage(fileName: string, data: Buffer): Promise<ParsedMessage> {
  const ext = uploadExtension(fileName);
  if (ext === 'eml') return parseEml(data);
  if (ext === 'msg') return parseMsg(data);
  throw new Error('Not an email file');
}
