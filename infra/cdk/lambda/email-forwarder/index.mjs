import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { SESClient, SendRawEmailCommand } from '@aws-sdk/client-ses';

// No bundling needed — AWS SDK v3 clients ship in the Lambda Node.js
// base image (see Dockerfile), same as they did on the zip managed runtime.

const s3 = new S3Client({});
const ses = new SESClient({});

const STRIPPED_HEADERS = /^(From|To|Reply-To|Return-Path|Sender|DKIM-Signature):/i;

export const handler = async (event) => {
  const record = event.Records[0].ses;
  const messageId = record.mail.messageId;
  const originalFrom = record.mail.commonHeaders?.from?.[0] ?? 'unknown sender';
  const originalTo = record.mail.commonHeaders?.to?.join(', ') ?? '';
  const subject = record.mail.commonHeaders?.subject ?? '(no subject)';

  const bucket = process.env.MAIL_BUCKET_NAME;
  const forwardFrom = process.env.FORWARD_FROM_ADDRESS;
  const forwardTo = process.env.FORWARD_TO_ADDRESS;

  const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: messageId }));
  const raw = await obj.Body.transformToString('utf-8');

  // Rewrite headers only, never touch body content — split on the blank
  // line that terminates the header block (RFC 5322), matching whichever
  // line ending the message actually uses.
  const nl = raw.includes('\r\n') ? '\r\n' : '\n';
  const splitIndex = raw.indexOf(nl + nl);
  const headerBlock = splitIndex >= 0 ? raw.slice(0, splitIndex) : raw;
  const bodyBlock = splitIndex >= 0 ? raw.slice(splitIndex) : '';

  // From/To/Reply-To get replaced outright; Return-Path, Sender, and
  // DKIM-Signature are dropped since they'd reference the original sender's
  // domain or a signature that's no longer valid once headers change — SES
  // re-signs with our own domain's DKIM automatically on send.
  const rewrittenHeaders = headerBlock
    .split(new RegExp(`${nl}(?!\\s)`)) // unfold: only split at line starts, not continuation lines
    .filter((line) => !STRIPPED_HEADERS.test(line))
    .concat([
      `From: "${originalFrom.replace(/"/g, '')} (via badthingsforpets.com)" <${forwardFrom}>`,
      `To: ${forwardTo}`,
      `Reply-To: ${originalFrom}`,
    ])
    .join(nl);

  await ses.send(
    new SendRawEmailCommand({
      Source: forwardFrom,
      Destinations: [forwardTo],
      RawMessage: { Data: Buffer.from(rewrittenHeaders + bodyBlock, 'utf-8') },
    }),
  );

  console.log(`Forwarded "${subject}" from ${originalFrom} (to ${originalTo}) -> ${forwardTo}`);
};
