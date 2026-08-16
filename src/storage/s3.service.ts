import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { env } from '../config/env.js';
import { AppError } from '../utils/app-error.js';
import { logger } from '../config/logger.js';

const s3 = new S3Client({
  region: env.AWS_REGION,
  ...(env.AWS_S3_ENDPOINT ? { endpoint: env.AWS_S3_ENDPOINT } : {}),
  ...(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
    ? { credentials: { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY } }
    : {}),
  ...(env.AWS_S3_FORCE_PATH_STYLE ? { forcePathStyle: true } : {}),
});

function bucketName() {
  if (!env.AWS_S3_BUCKET) {
    throw new AppError(503, 'STORAGE_NOT_CONFIGURED', 'Amazon S3 storage is not configured on the server');
  }
  return env.AWS_S3_BUCKET;
}

function storageError(operation: 'UPLOAD' | 'DOWNLOAD' | 'DELETE', error: unknown, context?: { key?: string }): AppError {
  if (error instanceof AppError) return error;
  const awsError = error as {
    name?: string;
    message?: string;
    Code?: string;
    $metadata?: { httpStatusCode?: number; requestId?: string };
  };
  const reason = error instanceof Error ? error.message : 'Unknown S3 error';
  const awsCode = awsError.name || awsError.Code || 'UNKNOWN';
  const httpStatus = awsError.$metadata?.httpStatusCode;
  logger.error({
    operation,
    bucket: env.AWS_S3_BUCKET,
    key: context?.key,
    awsCode,
    httpStatus,
    reason,
  }, 'Amazon S3 operation failed');
  const code = `S3_${operation}_FAILED`;
  return new AppError(502, code, `Amazon S3 ${operation.toLowerCase()} failed`, {
    provider: 'amazon-s3',
    operation,
    reason,
    awsCode,
    ...(httpStatus ? { httpStatus } : {}),
  });
}

export function onboardingDocumentKey(workspaceId: string, documentId: string) {
  return `workspaces/${workspaceId}/onboarding/documents/${documentId}`;
}

export async function putObject(input: {
  key: string;
  content: Buffer;
  mimeType: string;
  fileName: string;
}) {
  try {
    await s3.send(new PutObjectCommand({
      Bucket: bucketName(),
      Key: input.key,
      Body: input.content,
      ContentType: input.mimeType,
      ContentLength: input.content.byteLength,
      ContentDisposition: 'inline',
      ServerSideEncryption: 'AES256',
    }));
  } catch (error) {
    throw storageError('UPLOAD', error, { key: input.key });
  }
}

async function bodyToBuffer(body: unknown): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (typeof (body as { transformToByteArray?: unknown }).transformToByteArray === 'function') {
    const bytes = await (body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray();
    return Buffer.from(bytes);
  }
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function getObject(key: string) {
  try {
    const response = await s3.send(new GetObjectCommand({ Bucket: bucketName(), Key: key }));
    return bodyToBuffer(response.Body);
  } catch (error) {
    throw storageError('DOWNLOAD', error, { key });
  }
}

export async function deleteObject(key: string) {
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: bucketName(), Key: key }));
  } catch (error) {
    throw storageError('DELETE', error, { key });
  }
}
