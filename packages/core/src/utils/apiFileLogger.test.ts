/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ApiFileLogger } from './apiFileLogger.js';

describe('ApiFileLogger', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = path.join(os.tmpdir(), `qwen-api-file-logger-${Date.now()}`);
    delete process.env['QWEN_CODE_LOGS_S3_BUCKET'];
    delete process.env['QWEN_CODE_LOGS_S3_PREFIX'];
    delete process.env['QWEN_CODE_LOGS_S3_REGION'];
    delete process.env['AWS_ACCESS_KEY_ID'];
    delete process.env['AWS_SECRET_ACCESS_KEY'];
    delete process.env['AWS_ENDPOINT_URL'];
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('creates a session README and request log in the default session directory', async () => {
    const logger = new ApiFileLogger({
      sessionId: 'session-123',
      cwd: testDir,
      source: 'openai',
    });

    const context = logger.logRequest({
      model: 'test-model',
      messages: [
        { role: 'system', content: 'sys' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'first prompt' },
            {
              type: 'image_url',
              image_url: { url: 'data:image/png;base64,abc' },
            },
          ],
        },
      ],
    });

    expect(context).toMatchObject({
      sessionId: 'session-123',
      logDir: path.join(testDir, '.qwen-code-logs', 'session-123'),
    });

    const readmePath = path.join(context!.logDir, 'README.md');
    const readme = await fs.readFile(readmePath, 'utf-8');
    expect(readme).toContain('# Qwen Code session logs');
    expect(readme).toContain('**Session ID:** session-123');
    expect(readme).toContain(`**Working directory:** ${testDir}`);
    expect(readme).toContain('## User prompts');
    expect(readme).toContain('first prompt');

    const files = await fs.readdir(context!.logDir);
    const requestFilename = files.find((file) =>
      file.endsWith('_request.json'),
    );
    expect(requestFilename).toBeTruthy();

    const requestLog = JSON.parse(
      await fs.readFile(path.join(context!.logDir, requestFilename!), 'utf-8'),
    );
    expect(requestLog.source).toBe('openai');
    expect(requestLog.method).toBe('POST');
    expect(requestLog.body).toEqual({
      model: 'test-model',
      messages: [
        { role: 'system', content: 'sys' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'first prompt' },
            {
              type: 'image_url',
              image_url: { url: 'data:image/png;base64,abc' },
            },
          ],
        },
      ],
    });
  });

  it('extracts the latest user prompt from Gemini-style contents and filters system reminders', async () => {
    const logger = new ApiFileLogger({
      sessionId: 'session-456',
      cwd: testDir,
      source: 'gemini',
    });

    const context = logger.logRequest({
      model: 'gemini-test',
      contents: [
        {
          role: 'user',
          parts: [{ text: 'old prompt' }],
        },
        {
          role: 'user',
          parts: [
            { text: 'keep this line' },
            { text: '<system-reminder>drop this</system-reminder>' },
            { inlineData: { mimeType: 'image/png', data: 'abc' } },
          ],
        },
      ],
    });

    const readme = await fs.readFile(
      path.join(context!.logDir, 'README.md'),
      'utf-8',
    );
    expect(readme).toContain('keep this line');
    expect(readme).not.toContain('drop this');
    expect(readme).not.toContain('old prompt');
  });

  it('writes response logs with status and headers', async () => {
    const logger = new ApiFileLogger({
      sessionId: 'session-789',
      cwd: testDir,
      source: 'anthropic',
    });

    const context = logger.logRequest({
      model: 'claude-test',
      messages: [{ role: 'user', content: 'hello' }],
    });

    logger.logResponse(
      context,
      {
        responseId: 'resp-1',
        candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] } }],
      },
      {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'x-request-id': 'req-1',
        },
      },
    );

    const files = await fs.readdir(context!.logDir);
    const responseFilename = files.find((file) =>
      file.endsWith('_response.json'),
    );
    expect(responseFilename).toBeTruthy();

    const responseLog = JSON.parse(
      await fs.readFile(path.join(context!.logDir, responseFilename!), 'utf-8'),
    );
    expect(responseLog.status).toBe(200);
    expect(responseLog.headers).toEqual({
      'content-type': 'application/json',
      'x-request-id': 'req-1',
    });
    expect(responseLog.body).toEqual({
      responseId: 'resp-1',
      candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] } }],
    });
  });
});
