/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { hostname, userInfo } from 'node:os';
import path from 'node:path';
import { createDebugLogger } from './debugLogger.js';

const debugLogger = createDebugLogger('API_FILE_LOGGER');

const DEFAULT_LOG_DIRNAME = '.qwen-code-logs';
const README_FILENAME = 'README.md';
const DEFAULT_S3_REGION = 'ru-central-1';

type S3ClientLike = {
  send(command: unknown): Promise<unknown>;
};

type S3Config = {
  bucket: string;
  prefix: string;
  region: string;
};

export interface ApiFileLoggerOptions {
  sessionId: string;
  cwd?: string;
  baseLogDir?: string;
  source?: string;
}

export interface ApiRequestLogMetadata {
  method?: string;
  source?: string;
  url?: string;
}

export interface ApiResponseLogMetadata {
  headers?: Headers | Array<[string, string]> | Record<string, string>;
  status?: number;
}

export interface ApiFileLogContext {
  logId: string;
  logDir: string;
  sessionId: string;
}

let s3ClientPromise: Promise<S3ClientLike> | null = null;

export class ApiFileLogger {
  private readonly cwd: string;
  private readonly sessionId: string;
  private readonly sessionLogDir: string;
  private readonly source: string;

  constructor(options: ApiFileLoggerOptions) {
    this.sessionId = options.sessionId;
    this.source = options.source ?? 'unknown';
    this.cwd = options.cwd ?? process.cwd();
    const baseLogDir = resolveLogDir(options.baseLogDir, this.cwd);
    this.sessionLogDir = path.join(baseLogDir, this.sessionId);
  }

  logRequest(
    body: unknown,
    metadata: ApiRequestLogMetadata = {},
  ): ApiFileLogContext | undefined {
    try {
      this.ensureSessionReadme();
      this.appendPromptToReadme(body);

      const logId = makeLogId();
      const filename = `${logId}_request.json`;
      const content = JSON.stringify(
        {
          timestamp: new Date().toISOString(),
          source: metadata.source ?? this.source,
          url: metadata.url,
          method: metadata.method ?? 'POST',
          body,
        },
        null,
        2,
      );

      writeFileSync(path.join(this.sessionLogDir, filename), content, 'utf-8');
      void uploadLogToS3(this.sessionId, filename, content);

      return {
        logId,
        logDir: this.sessionLogDir,
        sessionId: this.sessionId,
      };
    } catch (error) {
      debugLogger.debug('Failed to write API request log:', error);
      return undefined;
    }
  }

  logResponse(
    context: ApiFileLogContext | undefined,
    body: unknown,
    metadata: ApiResponseLogMetadata = {},
  ): void {
    if (!context) {
      return;
    }

    try {
      const filename = `${context.logId}_response.json`;
      const content = JSON.stringify(
        {
          timestamp: new Date().toISOString(),
          status: metadata.status ?? 200,
          headers: normalizeHeaders(metadata.headers),
          body,
        },
        null,
        2,
      );

      writeFileSync(path.join(context.logDir, filename), content, 'utf-8');
      void uploadLogToS3(this.sessionId, filename, content);
    } catch (error) {
      debugLogger.debug('Failed to write API response log:', error);
    }
  }

  private ensureSessionReadme(): void {
    const isNewSession = !existsSync(this.sessionLogDir);
    mkdirSync(this.sessionLogDir, { recursive: true });

    if (!isNewSession) {
      return;
    }

    const readme = [
      '# Qwen Code session logs',
      '',
      `- **Session ID:** ${this.sessionId}`,
      `- **Started:** ${new Date().toISOString()}`,
      `- **Working directory:** ${this.cwd}`,
      `- **Hostname:** ${hostname()}`,
      `- **User:** ${safeUsername()}`,
      '',
      '## User prompts',
      '',
    ].join('\n');

    writeFileSync(
      path.join(this.sessionLogDir, README_FILENAME),
      readme,
      'utf-8',
    );
    void uploadLogToS3(this.sessionId, README_FILENAME, readme);
  }

  private appendPromptToReadme(body: unknown): void {
    const prompt = extractLatestUserPrompt(body);
    if (!prompt) {
      return;
    }

    const readmePath = path.join(this.sessionLogDir, README_FILENAME);
    appendFileSync(
      readmePath,
      `### ${new Date().toISOString()}\n\n${prompt.slice(0, 2000)}\n\n`,
      'utf-8',
    );

    const readme = readFileSync(readmePath, 'utf-8');
    void uploadLogToS3(this.sessionId, README_FILENAME, readme);
  }
}

function resolveLogDir(baseLogDir: string | undefined, cwd: string): string {
  if (!baseLogDir) {
    return path.join(cwd, DEFAULT_LOG_DIRNAME);
  }

  if (baseLogDir === '~' || baseLogDir.startsWith('~/')) {
    return path.join(
      process.env['HOME'] || userInfo().homedir,
      baseLogDir.slice(1),
    );
  }

  if (path.isAbsolute(baseLogDir)) {
    return path.normalize(baseLogDir);
  }

  return path.resolve(cwd, baseLogDir);
}

function makeLogId(): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${timestamp}_${randomUUID().slice(0, 8)}`;
}

function normalizeHeaders(
  headers?: Headers | Array<[string, string]> | Record<string, string>,
): Record<string, string> {
  if (!headers) {
    return {};
  }

  if (hasHeaderEntries(headers)) {
    return Object.fromEntries(headers.entries());
  }

  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }

  return { ...headers };
}

function safeUsername(): string {
  try {
    return userInfo().username || 'unknown';
  } catch {
    return 'unknown';
  }
}

function extractLatestUserPrompt(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') {
    return undefined;
  }

  const bodyRecord = body as Record<string, unknown>;

  const messagesPrompt = extractLatestPromptFromMessages(
    bodyRecord['messages'],
  );
  if (messagesPrompt) {
    return messagesPrompt;
  }

  const contentsPrompt = extractLatestPromptFromContents(
    bodyRecord['contents'],
  );
  if (contentsPrompt) {
    return contentsPrompt;
  }

  return undefined;
}

function extractLatestPromptFromMessages(
  messages: unknown,
): string | undefined {
  if (!Array.isArray(messages)) {
    return undefined;
  }

  const lastUserMessage = [...messages]
    .reverse()
    .find(
      (message) =>
        isRecord(message) &&
        typeof message['role'] === 'string' &&
        message['role'] === 'user',
    );

  if (!lastUserMessage || !isRecord(lastUserMessage)) {
    return undefined;
  }

  return sanitizePromptText(extractTextContent(lastUserMessage['content']));
}

function extractLatestPromptFromContents(
  contents: unknown,
): string | undefined {
  if (!contents) {
    return undefined;
  }

  if (!Array.isArray(contents)) {
    return sanitizePromptText(extractTextContent(contents));
  }

  const lastUserContent = [...contents]
    .reverse()
    .find(
      (content) =>
        isRecord(content) &&
        typeof content['role'] === 'string' &&
        content['role'] === 'user',
    );

  if (lastUserContent && isRecord(lastUserContent)) {
    return sanitizePromptText(extractTextContent(lastUserContent));
  }

  return sanitizePromptText(extractTextContent(contents));
}

function extractTextContent(content: unknown): string {
  if (!content) {
    return '';
  }

  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .flatMap((item) => extractTextSegments(item))
      .filter(Boolean)
      .join('\n')
      .trim();
  }

  if (isRecord(content) && Array.isArray(content['parts'])) {
    return content['parts']
      .flatMap((item) => extractTextSegments(item))
      .filter(Boolean)
      .join('\n')
      .trim();
  }

  return extractTextSegments(content).join('\n').trim();
}

function extractTextSegments(value: unknown): string[] {
  if (!value) {
    return [];
  }

  if (typeof value === 'string') {
    return [value];
  }

  if (!isRecord(value)) {
    return [];
  }

  const text = value['text'];
  if (typeof text === 'string') {
    return [text];
  }

  if (Array.isArray(value['content'])) {
    return value['content'].flatMap((item) => extractTextSegments(item));
  }

  if (Array.isArray(value['parts'])) {
    return value['parts'].flatMap((item) => extractTextSegments(item));
  }

  return [];
}

function sanitizePromptText(text: string): string | undefined {
  const sanitized = text
    .split('\n')
    .filter((line) => !line.includes('<system-reminder>'))
    .join('\n')
    .trim();

  return sanitized || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function hasHeaderEntries(
  value: unknown,
): value is { entries(): IterableIterator<[string, string]> } {
  return isRecord(value) && typeof value['entries'] === 'function';
}

function getS3Config(): S3Config | null {
  const bucket = process.env['QWEN_CODE_LOGS_S3_BUCKET'];
  if (!bucket) {
    return null;
  }

  return {
    bucket,
    prefix: process.env['QWEN_CODE_LOGS_S3_PREFIX'] ?? '',
    region: process.env['QWEN_CODE_LOGS_S3_REGION'] ?? DEFAULT_S3_REGION,
  };
}

async function getS3Client(region: string): Promise<S3ClientLike> {
  if (!s3ClientPromise) {
    s3ClientPromise = (async () => {
      const { S3Client } = await import('@aws-sdk/client-s3');
      const accessKeyId = process.env['AWS_ACCESS_KEY_ID'];
      const secretAccessKey = process.env['AWS_SECRET_ACCESS_KEY'];
      const endpoint = process.env['AWS_ENDPOINT_URL'];

      return new S3Client({
        region,
        ...(endpoint ? { endpoint } : {}),
        ...(accessKeyId && secretAccessKey
          ? {
              credentials: {
                accessKeyId,
                secretAccessKey,
              },
            }
          : {}),
        forcePathStyle: true,
      }) as S3ClientLike;
    })();
  }

  return s3ClientPromise;
}

function buildS3Key(
  prefix: string,
  sessionId: string,
  filename: string,
): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const parts = [`${year}-${month}-${safeUsername()}`, sessionId, filename];
  if (prefix) {
    parts.unshift(prefix);
  }
  return parts.join('/');
}

async function uploadLogToS3(
  sessionId: string,
  filename: string,
  content: string,
): Promise<void> {
  const config = getS3Config();
  if (!config) {
    return;
  }

  try {
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    const client = await getS3Client(config.region);
    const key = buildS3Key(config.prefix, sessionId, filename);

    await client.send(
      new PutObjectCommand({
        Bucket: config.bucket,
        Key: key,
        Body: content,
        ContentType: filename.endsWith('.json')
          ? 'application/json'
          : 'text/markdown',
      }),
    );
  } catch (error) {
    debugLogger.debug('Failed to mirror API log to S3:', error);
  }
}
