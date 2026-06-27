// src/data-bridge/apiClients/baseClient.ts
import { logger, logWithCorrelation } from '../core/utils/logger';

export interface RequestConfig {
  baseUrl: string;
  apiKey?: string;
  timeout?: number;
  maxRetries?: number;
  rateLimitPerMinute?: number;
}

export interface ApiResponse<T> {
  data: T | null;
  success: boolean;
  error?: string;
  statusCode?: number;
  correlationId: string;
}

export class BaseClient {
  private requestTimestamps: number[] = [];
  private readonly timeout: number;
  private readonly maxRetries: number;
  private readonly rateLimitPerMinute: number;

  constructor(private config: RequestConfig) {
    this.timeout = config.timeout || 10000;
    this.maxRetries = config.maxRetries || 3;
    this.rateLimitPerMinute = config.rateLimitPerMinute || 30;
  }

  // ─── RATE LIMITER ────────────────────────────────────────

  private async enforceRateLimit(): Promise<void> {
    const now = Date.now();
    const oneMinuteAgo = now - 60000;

    // Remove timestamps older than 1 minute
    this.requestTimestamps = this.requestTimestamps.filter(t => t > oneMinuteAgo);

    if (this.requestTimestamps.length >= this.rateLimitPerMinute) {
      const oldestRequest = this.requestTimestamps[0];
      const waitTime = 60000 - (now - oldestRequest) + 100;
      logger.warn(`Rate limit reached. Waiting ${waitTime}ms`);
      await this.sleep(waitTime);
    }

    this.requestTimestamps.push(Date.now());
  }

  // ─── TIMEOUT WRAPPER ─────────────────────────────────────

  private async fetchWithTimeout(
    url: string,
    options: RequestInit
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });
      return response;
    } finally {
      clearTimeout(timer);
    }
  }

  // ─── RETRY LOGIC ─────────────────────────────────────────

  private async withRetry<T>(
    fn: () => Promise<T>,
    correlationId: string,
    attempt = 1
  ): Promise<T> {
    try {
      return await fn();
    } catch (error: any) {
      const isLastAttempt = attempt >= this.maxRetries;
      const isAbortError = error.name === 'AbortError';
      const isRetryable = !isAbortError || attempt < this.maxRetries;

      logWithCorrelation(correlationId, 'warn', `Request attempt ${attempt} failed`, {
        error: error.message,
        willRetry: !isLastAttempt && isRetryable,
      });

      if (isLastAttempt || !isRetryable) throw error;

      // Exponential backoff: 1s, 2s, 4s
      const backoff = Math.pow(2, attempt - 1) * 1000;
      await this.sleep(backoff);

      return this.withRetry(fn, correlationId, attempt + 1);
    }
  }

  // ─── CORE REQUEST ────────────────────────────────────────

  async get<T>(
    endpoint: string,
    params?: Record<string, string>,
    correlationId?: string
  ): Promise<ApiResponse<T>> {
    const corrId = correlationId || this.generateCorrelationId();
    const url = this.buildUrl(endpoint, params);

    try {
      await this.enforceRateLimit();

      logWithCorrelation(corrId, 'info', `GET ${url}`);

      const response = await this.withRetry(
        () => this.fetchWithTimeout(url, {
          method: 'GET',
          headers: this.buildHeaders(),
        }),
        corrId
      );

      if (!response.ok) {
        logWithCorrelation(corrId, 'error', `HTTP ${response.status}`, { url });
        return {
          data: null,
          success: false,
          error: `HTTP ${response.status}: ${response.statusText}`,
          statusCode: response.status,
          correlationId: corrId,
        };
      }

      const data = await response.json() as T;

      logWithCorrelation(corrId, 'info', `GET success`, { url });

      return {
        data,
        success: true,
        statusCode: response.status,
        correlationId: corrId,
      };

    } catch (error: any) {
      logWithCorrelation(corrId, 'error', `GET failed after ${this.maxRetries} attempts`, {
        url,
        error: error.message,
      });

      return {
        data: null,
        success: false,
        error: error.message,
        correlationId: corrId,
      };
    }
  }

  // ─── HELPERS ─────────────────────────────────────────────

  private buildUrl(endpoint: string, params?: Record<string, string>): string {
    const url = new URL(`${this.config.baseUrl}${endpoint}`);
    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        url.searchParams.append(key, value);
      });
    }
    return url.toString();
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.config.apiKey) {
      headers['X-Auth-Token'] = this.config.apiKey;
    }
    return headers;
  }

  private generateCorrelationId(): string {
    return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}