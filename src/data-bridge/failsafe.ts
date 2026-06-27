// src/data-bridge/failsafe.ts
import { logger, logWithCorrelation } from '../core/utils/logger';

// ─── CIRCUIT BREAKER STATES ──────────────────────────────

enum CircuitState {
  CLOSED = 'CLOSED',       // Normal — requests flowing
  OPEN = 'OPEN',           // Failed — requests blocked
  HALF_OPEN = 'HALF_OPEN', // Testing — one request allowed
}

// ─── CIRCUIT CONFIG ──────────────────────────────────────

export interface CircuitConfig {
  failureThreshold: number;   // Failures before opening circuit
  successThreshold: number;   // Successes in HALF_OPEN before closing
  timeout: number;            // Ms before OPEN → HALF_OPEN retry
  monitorWindow: number;      // Ms window to count failures in
}

const DEFAULT_CONFIG: CircuitConfig = {
  failureThreshold: 5,        // 5 failures = open circuit
  successThreshold: 2,        // 2 successes = close circuit again
  timeout: 60000,             // 60 seconds before retry
  monitorWindow: 120000,      // Count failures within 2 minute window
};

// ─── CIRCUIT BREAKER ─────────────────────────────────────

export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failureCount = 0;
  private successCount = 0;
  private lastFailureTime = 0;
  private failureTimestamps: number[] = [];
  private readonly config: CircuitConfig;

  constructor(
    private readonly name: string,
    config: Partial<CircuitConfig> = {}
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ─── MAIN EXECUTE METHOD ─────────────────────────────

  async execute<T>(
    fn: () => Promise<T>,
    correlationId?: string
  ): Promise<T> {
    const corrId = correlationId || `cb_${Date.now()}`;

    // OPEN — circuit is tripped, block request
    if (this.state === CircuitState.OPEN) {
      const timeSinceLastFailure = Date.now() - this.lastFailureTime;

      if (timeSinceLastFailure < this.config.timeout) {
        const waitTime = Math.ceil((this.config.timeout - timeSinceLastFailure) / 1000);
        logWithCorrelation(corrId, 'warn',
          `[CircuitBreaker:${this.name}] OPEN — blocked. Retry in ${waitTime}s`
        );
        throw new Error(`Circuit OPEN for ${this.name} — retry in ${waitTime}s`);
      }

      // Timeout passed — move to HALF_OPEN and try once
      this.transitionTo(CircuitState.HALF_OPEN, corrId);
    }

    // HALF_OPEN — allow one test request through
    if (this.state === CircuitState.HALF_OPEN) {
      logWithCorrelation(corrId, 'info',
        `[CircuitBreaker:${this.name}] HALF_OPEN — sending test request`
      );
    }

    // Execute the request
    try {
      const result = await fn();
      this.onSuccess(corrId);
      return result;
    } catch (error) {
      this.onFailure(corrId);
      throw error;
    }
  }

  // ─── SUCCESS HANDLER ─────────────────────────────────

  private onSuccess(corrId: string): void {
    if (this.state === CircuitState.HALF_OPEN) {
      this.successCount++;
      logWithCorrelation(corrId, 'info',
        `[CircuitBreaker:${this.name}] HALF_OPEN success ${this.successCount}/${this.config.successThreshold}`
      );

      if (this.successCount >= this.config.successThreshold) {
        this.reset();
        this.transitionTo(CircuitState.CLOSED, corrId);
      }
      return;
    }

    // Reset failure count on success in CLOSED state
    if (this.failureCount > 0) {
      this.failureCount = 0;
      this.failureTimestamps = [];
    }
  }

  // ─── FAILURE HANDLER ─────────────────────────────────

  private onFailure(corrId: string): void {
    const now = Date.now();
    this.lastFailureTime = now;

    // Only count failures within monitor window
    this.failureTimestamps = this.failureTimestamps
      .filter(t => now - t < this.config.monitorWindow);
    this.failureTimestamps.push(now);
    this.failureCount = this.failureTimestamps.length;

    logWithCorrelation(corrId, 'warn',
      `[CircuitBreaker:${this.name}] Failure ${this.failureCount}/${this.config.failureThreshold}`
    );

    if (this.state === CircuitState.HALF_OPEN) {
      // Failed in test — reopen immediately
      this.transitionTo(CircuitState.OPEN, corrId);
      return;
    }

    if (this.failureCount >= this.config.failureThreshold) {
      this.transitionTo(CircuitState.OPEN, corrId);
    }
  }

  // ─── STATE TRANSITION ────────────────────────────────

  private transitionTo(newState: CircuitState, corrId: string): void {
    const oldState = this.state;
    this.state = newState;

    logWithCorrelation(corrId, 'warn',
      `[CircuitBreaker:${this.name}] ${oldState} → ${newState}`, {
        failureCount: this.failureCount,
        failureThreshold: this.config.failureThreshold,
      }
    );

    if (newState === CircuitState.OPEN) {
      logger.warn(
        `[CircuitBreaker:${this.name}] ⛔ CIRCUIT OPEN — API blocked for ${this.config.timeout / 1000}s`
      );
    }

    if (newState === CircuitState.CLOSED) {
      logger.info(
        `[CircuitBreaker:${this.name}] ✅ CIRCUIT CLOSED — API restored`
      );
    }
  }

  // ─── RESET ───────────────────────────────────────────

  private reset(): void {
    this.failureCount = 0;
    this.successCount = 0;
    this.failureTimestamps = [];
  }

  // ─── STATUS ──────────────────────────────────────────

  getStatus(): {
    name: string;
    state: CircuitState;
    failureCount: number;
    lastFailureTime: number;
  } {
    return {
      name: this.name,
      state: this.state,
      failureCount: this.failureCount,
      lastFailureTime: this.lastFailureTime,
    };
  }

  isOpen(): boolean {
    return this.state === CircuitState.OPEN;
  }
}

// ─── FAILSAFE MANAGER ────────────────────────────────────
// Single instance managing all API circuit breakers

export class FailsafeManager {
  private circuits: Map<string, CircuitBreaker> = new Map();

  // Get or create a circuit breaker for a named API
  getCircuit(name: string, config?: Partial<CircuitConfig>): CircuitBreaker {
    if (!this.circuits.has(name)) {
      this.circuits.set(name, new CircuitBreaker(name, config));
      logger.info(`[Failsafe] Circuit created for: ${name}`);
    }
    return this.circuits.get(name)!;
  }

  // Execute through named circuit
  async execute<T>(
    circuitName: string,
    fn: () => Promise<T>,
    correlationId?: string
  ): Promise<T | null> {
    const circuit = this.getCircuit(circuitName);
    try {
      return await circuit.execute(fn, correlationId);
    } catch (error: any) {
      logger.error(`[Failsafe] ${circuitName} failed`, {
        error: error.message,
        circuitState: circuit.getStatus().state,
      });
      return null; // Never crash — return null and let fetcher handle
    }
  }

  // Status of all circuits
  getAllStatus(): ReturnType<CircuitBreaker['getStatus']>[] {
    return Array.from(this.circuits.values()).map(c => c.getStatus());
  }

  // Check if any circuit is open
  hasOpenCircuits(): boolean {
    return Array.from(this.circuits.values()).some(c => c.isOpen());
  }
}

// ─── SINGLETON EXPORT ────────────────────────────────────
// One FailsafeManager for entire app lifetime

export const failsafe = new FailsafeManager();